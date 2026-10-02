import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createNetworkManagerService } from './service'
import { createDefaultNetworkProfiles, type NetworkProbe, type NetworkResult } from '../../../src/features/network-manager/networkTypes'
import { hash, type ProxyAdapter } from './proxy'
import type { NetworkCommand } from './powershell'
import type { RelayRecoveryInspection } from './relayRecovery'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))) })
const unwrap = <T>(result: NetworkResult<T>): T => { if (!result.ok) throw new Error(result.error.code); return result.data }

async function fixture(mode: 'home' | 'work' = 'home', linkedRouteStores = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'network-manager-test-'))
  directories.push(directory)
  const profile = { ...createDefaultNetworkProfiles()[mode === 'home' ? 0 : 1], proxyConfigPath: 'C:\\fixture\\config.yaml' }
  const timestamp = Date.now()
  const state = {
    interfaces: [
      { InterfaceIndex: 4, InterfaceAlias: 'Ethernet', ConnectionState: 1, InterfaceMetric: 10 },
      { InterfaceIndex: 47, InterfaceAlias: profile.vpnName, ConnectionState: 1, InterfaceMetric: 20 },
      { InterfaceIndex: 51, InterfaceAlias: profile.tunnelName, ConnectionState: 1, InterfaceMetric: 5 },
    ],
    addresses: [{ InterfaceIndex: 4, IPAddress: mode === 'work' ? '191.168.3.50' : '192.168.1.50', PrefixLength: 21 }, { InterfaceIndex: 47, IPAddress: '162.168.1.2', PrefixLength: 32 }],
    adapters: [{ InterfaceIndex: 4, InterfaceGuid: 'physical-guid', Status: 'Up' }],
    routes: [] as { prefix: string; nextHop: string; interfaceIndex: number; interfaceAlias: string; metric: number; store: string }[],
    vpns: [{ name: profile.vpnName, serverAddress: profile.vpnServerAddress, scope: profile.vpnScope, connected: true, splitTunneling: true, routes: [{ prefix: profile.managementPrefix, metric: 1 }] }],
    selected: [
      { target: profile.gatewayAddress, source: mode === 'home' ? '162.168.1.2' : '191.168.3.50', interfaceIndex: mode === 'home' ? 47 : 4, interfaceAlias: mode === 'home' ? profile.vpnName : 'Ethernet', prefix: mode === 'home' ? profile.managementPrefix : '191.168.0.0/21', nextHop: '0.0.0.0' },
      { target: profile.containerProbeAddress, source: mode === 'home' ? '10.78.62.2' : '191.168.3.50', interfaceIndex: mode === 'home' ? 51 : 4, interfaceAlias: mode === 'home' ? profile.tunnelName : 'Ethernet', prefix: profile.containerPrefix, nextHop: mode === 'home' ? '0.0.0.0' : profile.gatewayAddress },
      { target: '1.1.1.1', source: '192.168.1.50', interfaceIndex: 4, interfaceAlias: 'Ethernet', prefix: '0.0.0.0/0', nextHop: '192.168.1.1' },
    ],
    service: { Name: `WireGuardTunnel$${profile.tunnelName}`, status: 'Running', startType: 'Automatic' },
    task: { TaskName: profile.relayTaskName, state: 'Running', enabled: true } as { TaskName: string; state: string; enabled: boolean } | null,
    handshakes: [Math.floor(timestamp / 1000)], receivedBytes: 100, sentBytes: 100, admin: true, issues: [] as string[],
  }
  const commands: NetworkCommand[] = []
  let afterCommand: ((command: NetworkCommand) => void | Promise<void>) | undefined
  let afterTcp: ((target: string) => void) | undefined
  let tcpPass = true
  const failedTargets = new Set<string>()
  const tcp = async (target: string, port: number): Promise<NetworkProbe> => {
    afterTcp?.(target)
    const ok = tcpPass && !failedTargets.has(target)
    return { target, port, kind: 'tcp', ok, checkedAt: new Date(timestamp).toISOString(), latencyMs: 1, detail: ok ? 'TCP_CONNECTED' : 'TCP_UNREACHABLE' }
  }
  const proxyState = { available: true, mode: 'rule', tunEnabled: false, controller: 'http://127.0.0.1:39797', bypassPrefixes: [profile.managementPrefix, profile.containerPrefix], configHash: hash('original') }
  const proxy: ProxyAdapter = {
    inspect: async () => structuredClone(proxyState),
    apply: async (_profile, _expected, prepared) => {
      const undo = { path: profile.proxyConfigPath, beforeRules: [], beforeMode: 'rule', beforeHash: hash('original'), afterHash: hash('changed'), restoredHash: hash('original'), runtimeBeforeMode: 'rule', runtimeAfterMode: 'rule' as const, runtimeRulesHash: hash([]), afterRuntimeRulesHash: hash([]), controlPathHash: hash({}) }
      await prepared?.(undo)
      proxyState.configHash = undo.afterHash
      return undo
    },
    rollback: async () => { proxyState.configHash = hash('original'); return true },
  }
  const discoveryState = { running: false, cores: [], issues: [] }
  const runner = async (command: NetworkCommand): Promise<unknown> => {
    if (command.action === 'snapshot') return structuredClone(state)
    if (command.action === 'proxyDiscover') return structuredClone(discoveryState)
    commands.push(command)
    switch (command.action) {
      case 'split': state.vpns[0]!.splitTunneling = Boolean(command.enabled); break
      case 'vpnRouteAdd': state.vpns[0]!.routes.push({ prefix: String(command.prefix), metric: Number(command.metric) }); break
      case 'vpnRouteRemove': state.vpns[0]!.routes = state.vpns[0]!.routes.filter(route => route.prefix !== command.prefix); break
      case 'service': state.service.status = command.running ? 'Running' : 'Stopped'; break
      case 'serviceStartup': state.service.startType = String(command.startType); break
      case 'task': state.task!.state = command.running ? 'Running' : 'Ready'; break
      case 'taskEnabled': state.task!.enabled = Boolean(command.enabled); break
      case 'routeAdd': {
        const route = { prefix: String(command.prefix), nextHop: String(command.nextHop), interfaceIndex: Number(command.interfaceIndex), interfaceAlias: 'Ethernet', metric: Number(command.metric), store: String(command.store) }
        state.routes.push(route)
        if (linkedRouteStores && route.store === 'PersistentStore' && !state.routes.some(item => item.prefix === route.prefix && item.store === 'ActiveStore')) state.routes.push({ ...route, store: 'ActiveStore' })
        break
      }
      case 'routeRemove': state.routes = state.routes.filter(route => !(route.prefix === command.prefix && route.nextHop === command.nextHop && route.interfaceIndex === command.interfaceIndex && (route.store === command.store || (linkedRouteStores && command.store === 'PersistentStore')))); break
      default: throw new Error('UNKNOWN_TEST_OPERATION')
    }
    await afterCommand?.(command)
    return null
  }
  let clock = timestamp
  const relayState: RelayRecoveryInspection = {
    checkedAt: new Date(timestamp).toISOString(), binary: { status: 'present', path: profile.relayExecutable, sha256: hash('fixture-binary'), secureAcl: true },
    task: { status: 'present', fingerprint: hash('fixture-task'), definitionMatches: true, state: 'Running', enabled: true },
    udp: { status: 'ready', pid: 123, executablePath: profile.relayExecutable, processPriority: 'Normal' }, tcp: { status: 'ready', pid: 123 }, issues: [],
  }
  let readyAt = 0
  const relay = {
    inspect: async () => ({ ...structuredClone(relayState),
      task: { ...relayState.task, status: relayState.task.status === 'unknown' ? 'unknown' as const : state.task ? 'present' as const : 'missing' as const,
        state: state.task?.state ?? null, enabled: state.task?.enabled ?? null, fingerprint: state.task ? relayState.task.fingerprint : null },
      udp: readyAt && clock < readyAt ? { status: 'missing' as const } : relayState.udp,
    }),
    create: async () => { commands.push({ action: 'relayTaskCreate' }); state.task = { TaskName: profile.relayTaskName, state: 'Ready', enabled: true }; return { taskFingerprint: relayState.task.fingerprint! } },
    remove: async () => { commands.push({ action: 'relayTaskRemove' }); state.task = null },
  }
  const service = createNetworkManagerService({ configDir: directory, platform: 'win32', runner, proxy, tcp, relay,
    http: async target => ({ target, kind: 'http-proxy', ok: true, checkedAt: new Date(timestamp).toISOString(), latencyMs: 1, detail: 'EXPLICIT_PROXY_HTTP_RESPONSE' }),
    now: () => clock, delay: async milliseconds => { clock += milliseconds },
    resolveHost: async id => id === '11111111-1111-4111-8111-111111111111' ? { id, name: 'fixture', address: '191.168.7.62', port: 2222 } : null,
    openExternal: async url => { commands.push({ action: 'openExternal', url }) }, openPath: async file => { commands.push({ action: 'openPath', file }); return '' },
  })
  return { directory, profile, state, commands, service, proxyState, discoveryState, relayState, failedTargets, setReadyAt: (value: number) => { readyAt = value }, setAfterCommand: (callback: typeof afterCommand) => { afterCommand = callback }, setAfterTcp: (callback: typeof afterTcp) => { afterTcp = callback }, setTcp: (pass: boolean) => { tcpPass = pass }, setClock: (value: number) => { clock = value }, timestamp }
}

describe('network manager deterministic orchestration', () => {
  it('resolves a renamed corporate VPN by server and preserves its full-tunnel policy', async () => {
    const f = await fixture()
    f.state.vpns[0]!.name = '公司'
    f.state.vpns[0]!.splitTunneling = false
    f.state.vpns[0]!.routes = []
    f.state.interfaces[1]!.InterfaceAlias = '公司'
    Object.assign(f.state.selected[0]!, { interfaceAlias: '公司', prefix: '0.0.0.0/0' })
    const planned = unwrap(await f.service.plan(f.profile))
    expect(planned.snapshot.vpn).toMatchObject({ name: '公司', serverAddress: f.profile.vpnServerAddress })
    expect(planned.plan.canApply).toBe(true)
    expect(unwrap(await f.service.apply(planned.plan.id)).status).toBe('applied')
    expect(f.commands).toEqual([])
    expect(f.state.vpns[0]!.splitTunneling).toBe(false)
  })

  it('allows manual endpoint testing without a container tunnel or saved SSH host', async () => {
    const f = await fixture()
    f.profile.containerEnabled = false
    f.profile.verificationTargets = [{ id: 'business', label: 'business', address: '10.0.0.199', port: 8070, protocol: 'tcp' }]
    const probes = unwrap(await f.service.verifyStep(f.profile, 'container'))
    expect(probes).toHaveLength(1)
    expect(probes[0]).toMatchObject({ kind: 'tcp', target: '10.0.0.199', port: 8070, ok: true })
    expect(f.commands).toEqual([])
  })

  it('requires an exact choice for ambiguous VPNs and does not interpret failed collection as missing', async () => {
    const f = await fixture()
    f.state.vpns[0]!.name = '公司A'
    f.state.vpns.push({ ...f.state.vpns[0]!, name: '公司B' })
    expect(unwrap(await f.service.plan(f.profile)).plan.steps).toContainEqual(expect.objectContaining({ code: 'vpnAmbiguous' }))
    f.state.issues = ['vpn/allUsers: ACCESS_DENIED']
    expect(unwrap(await f.service.plan(f.profile)).snapshot.vpn.status).toBe('unknown')
    expect(f.commands).toEqual([])
  })

  it('restores a missing relay task from reviewed safe binary and waits for delayed port readiness', async () => {
    const f = await fixture()
    f.state.task = null
    f.setReadyAt(f.timestamp + 20_000)
    const plan = unwrap(await f.service.plan(f.profile)).plan
    expect(plan.changes).toContainEqual(expect.objectContaining({ id: 'relay-register' }))
    expect(plan.execution!.find(item => item.id === 'relay-register')!.command).toMatchObject({ action: 'relayTaskCreate',
      relayLocalPort: f.profile.relayLocalPort, gatewayAddress: f.profile.gatewayAddress, relayPort: f.profile.relayPort })
    expect(plan.execution!.find(item => item.id === 'relay-start')!.command.expectedTaskFingerprint).toBe('<created-task fingerprint>')
    expect(unwrap(await f.service.apply(plan.id)).status).toBe('applied')
    expect(f.commands.map(command => command.action)).toEqual(['relayTaskCreate', 'task'])
    expect(unwrap(await f.service.plan(f.profile)).plan.changes.some(change => change.id === 'relay-register')).toBe(false)
  })

  it.each(['unknown', 'unsafe', 'definition'])('blocks task restoration when evidence is %s', async evidence => {
    const f = await fixture()
    if (evidence === 'unknown') f.relayState.task.status = 'unknown'
    else if (evidence === 'unsafe') { f.state.task = null; f.relayState.binary.secureAcl = false }
    else f.relayState.task.definitionMatches = false
    const plan = unwrap(await f.service.plan(f.profile)).plan
    expect(plan.canApply).toBe(false)
    expect(await f.service.apply(plan.id)).toMatchObject({ ok: false, error: { code: 'PLAN_BLOCKED' } })
    expect(f.commands).toHaveLength(0)
  })

  it('keeps unreadable UDP/TCP evidence unknown rather than reporting a failed listener', async () => {
    const f = await fixture()
    f.relayState.udp.status = 'unknown'
    f.relayState.tcp.status = 'unknown'
    const snapshot = unwrap(await f.service.inspect(f.profile))
    expect(snapshot.tunnel.taskStatus).toBe('present')
    expect(snapshot.tunnel.udpListening).toBeUndefined()
    expect(snapshot.tunnel.tcpConnected).toBeUndefined()
    expect(snapshot.tunnel.relayReady).toBeUndefined()
  })

  it('rolls back only the newly created task on readiness timeout and retains existing running task', async () => {
    const f = await fixture()
    f.profile.readinessTimeoutSeconds = 10
    f.state.task = null
    f.relayState.udp.status = 'missing'
    const report = unwrap(await f.service.apply(unwrap(await f.service.plan(f.profile)).plan.id))
    expect(report).toMatchObject({ status: 'rolled-back', issues: ['TRANSPORT_READINESS_TIMEOUT'] })
    expect(f.state.task).toBeNull()
    expect(f.commands.map(command => command.action)).toEqual(['relayTaskCreate', 'task', 'task', 'relayTaskRemove'])
    const existing = await fixture()
    existing.profile.readinessTimeoutSeconds = 10
    existing.relayState.udp.status = 'missing'
    expect(unwrap(await existing.service.apply(unwrap(await existing.service.plan(existing.profile)).plan.id)).issues).toContain('TRANSPORT_READINESS_TIMEOUT')
    expect(existing.commands).toHaveLength(0)
    expect(existing.state.task!.state).toBe('Running')
  })

  it('does not accept a successful observation that finishes after the readiness deadline', async () => {
    const f = await fixture()
    f.profile.readinessTimeoutSeconds = 10
    f.setAfterTcp(target => { if (target === f.profile.containerProbeAddress) f.setClock(f.timestamp + 10_001) })
    const report = unwrap(await f.service.apply(unwrap(await f.service.plan(f.profile)).plan.id))
    expect(report.issues).toContain('TRANSPORT_READINESS_TIMEOUT')
    expect(report.status).toBe('rolled-back')
  })

  it('tests selected targets instead of a retired legacy container and retains healthy transport for business failures', async () => {
    const f = await fixture()
    f.state.handshakes = [Math.floor(f.timestamp / 1000) - 600]
    f.failedTargets.add(f.profile.containerProbeAddress)
    f.profile.verificationTargets = [{ id: 'live', label: 'current container', address: '10.204.19.99', port: 22, protocol: 'tcp' }]
    f.state.selected.push({ ...f.state.selected[1]!, target: '10.204.19.99' })
    expect(unwrap(await f.service.apply(unwrap(await f.service.plan(f.profile)).plan.id)).status).toBe('applied')
    f.state.handshakes = [Math.floor(f.timestamp / 1000)]
    f.failedTargets.add('10.204.19.99')
    const report = unwrap(await f.service.apply(unwrap(await f.service.plan(f.profile)).plan.id))
    expect(report).toMatchObject({ status: 'applied', issues: ['BUSINESS_NOT_VERIFIED'] })
    expect(f.state.service.status).toBe('Running')
  })

  it('preserves disconnected office routes without treating them as an active home conflict', async () => {
    const f = await fixture()
    f.state.interfaces.push({ InterfaceIndex: 19, InterfaceAlias: '有线1', ConnectionState: 2, InterfaceMetric: 1 })
    f.state.routes.push({ prefix: '10.204.19.81/32', nextHop: f.profile.gatewayAddress, interfaceIndex: 19, interfaceAlias: '有线1', metric: 1, store: 'PersistentStore' })
    const plan = unwrap(await f.service.plan(f.profile)).plan
    expect(plan.canApply).toBe(true)
    expect(unwrap(await f.service.apply(plan.id)).status).toBe('applied')
    expect(f.state.routes).toHaveLength(1)
    expect(f.commands).toHaveLength(0)
  })

  it('prepares profile route before requesting reconnect and never removes the working VPN default early', async () => {
    const f = await fixture()
    f.profile.splitTunnelingPolicy = 'enabled'
    f.state.vpns[0]!.routes = []
    f.state.vpns[0]!.splitTunneling = false
    f.state.selected[0]!.prefix = '0.0.0.0/0'
    const report = unwrap(await f.service.apply(unwrap(await f.service.plan(f.profile)).plan.id))
    expect(report).toMatchObject({ status: 'applied', issues: ['VPN_RECONNECT_REQUIRED'] })
    expect(f.commands.map(command => command.action)).toEqual(['vpnRouteAdd'])
    expect(f.state.vpns[0]!.splitTunneling).toBe(false)
    expect(unwrap(await f.service.plan(f.profile)).plan.canApply).toBe(false)
  })

  it('adds the work route to the current physical adapter while preserving a disconnected old adapter route', async () => {
    const f = await fixture('work')
    f.state.interfaces.push({ InterfaceIndex: 19, InterfaceAlias: 'old cable', ConnectionState: 2, InterfaceMetric: 1 })
    f.state.routes.push({ prefix: f.profile.containerPrefix, nextHop: f.profile.gatewayAddress, interfaceIndex: 19, interfaceAlias: 'old cable', metric: 5, store: 'PersistentStore' })
    const plan = unwrap(await f.service.plan(f.profile)).plan
    expect(plan.canApply).toBe(true)
    expect(unwrap(await f.service.apply(plan.id)).status).toBe('applied')
    expect(f.state.routes.map(route => route.interfaceIndex).sort()).toEqual([19, 4, 4])
    expect(f.commands.some(command => command.action === 'routeRemove' && command.interfaceIndex === 19)).toBe(false)
  })

  it('preserves a task changed by another writer between enable and start, including during rollback', async () => {
    const f = await fixture()
    Object.assign(f.state.task!, { state: 'Ready', enabled: false })
    f.setAfterCommand(command => { if (command.action === 'taskEnabled') f.relayState.task.fingerprint = hash('third-party-task') })
    const report = unwrap(await f.service.apply(unwrap(await f.service.plan(f.profile)).plan.id))
    expect(report.status).toBe('rollback-conflict')
    expect(f.commands.map(command => command.action)).toEqual(['taskEnabled'])
    expect(f.state.task!.state).toBe('Ready')
  })

  it('restores the previous dedicated tunnel if a work switch cannot reach any business target', async () => {
    const f = await fixture('work')
    f.failedTargets.add(f.profile.containerProbeAddress)
    const report = unwrap(await f.service.apply(unwrap(await f.service.plan(f.profile)).plan.id))
    expect(report.status).toBe('rolled-back')
    expect(f.state.service.status).toBe('Running')
    expect(f.state.task!.state).toBe('Running')
    expect(f.state.routes).toEqual([])
  })

  it('returns a read-only catalogue and the exact native command/inverse of a reviewed plan', async () => {
    const f = await fixture()
    const catalog = unwrap(await f.service.executionCatalog())
    expect(catalog.actions.some(action => action.id === 'split' && action.script.includes('Set-VpnConnection'))).toBe(true)
    expect(f.commands).toHaveLength(0)
    f.state.vpns[0]!.splitTunneling = false
    f.profile.splitTunnelingPolicy = 'enabled'
    const plan = unwrap(await f.service.plan(f.profile)).plan
    const execution = plan.execution!.find(item => item.id === 'vpn-split')!
    expect(execution.command).toMatchObject({ action: 'split', enabled: true })
    expect(execution.inverse).toMatchObject({ action: 'split', enabled: false })
    expect(f.commands).toHaveLength(0)
    expect(unwrap(await f.service.apply(plan.id)).status).toBe('applied')
    expect(f.commands[0]).toEqual(execution.command)
  })

  it('does not relaunch an already running Sakura GUI even if its core/config is unresolved', async () => {
    const f = await fixture()
    f.discoveryState.running = true
    expect(unwrap(await f.service.discoverProxy(7897))).toMatchObject({ status: 'incomplete', running: true })
    expect(unwrap(await f.service.login('sakura', f.profile))).toBeNull()
    expect(f.commands).toHaveLength(0)
  })

  it('invalidates a reviewed plan when the proxy process identity changes', async () => {
    const f = await fixture()
    Object.assign(f.proxyState, { instanceId: '101:old-start' })
    const plan = unwrap(await f.service.plan(f.profile)).plan
    Object.assign(f.proxyState, { instanceId: '101:new-start' })
    expect(await f.service.apply(plan.id)).toMatchObject({ ok: false, error: { code: 'PLAN_STALE' } })
    expect(f.commands).toHaveLength(0)
  })

  it('loads defaults and migrates an old configuration on save with revision conflict protection', async () => {
    const f = await fixture()
    await fs.writeFile(path.join(f.directory, 'network-modes.json'), JSON.stringify({ schemaVersion: 0, profiles: [{ id: 'home', mode: 'home', name: '旧家庭网络' }] }))
    const old = unwrap(await f.service.list())
    expect(old.profiles[0]?.name).toBe('旧家庭网络')
    const saved = unwrap(await f.service.save(f.profile, 0))
    expect(saved.revision).toBe(1)
    expect(await f.service.save(f.profile, 0)).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } })
  })

  it('refuses a 31st profile without corrupting persisted configuration', async () => {
    const f = await fixture()
    await fs.writeFile(path.join(f.directory, 'network-modes.json'), JSON.stringify({ schemaVersion: 1, revision: 0, profiles: Array.from({ length: 30 }, (_, i) => ({ ...f.profile, id: `profile-${i}` })) }))
    expect(await f.service.save({ ...f.profile, id: 'extra' }, 0)).toMatchObject({ ok: false, error: { code: 'PROFILE_LIMIT' } })
    expect(unwrap(await f.service.list()).profiles).toHaveLength(30)
  })

  it('blocks disconnected scoped VPN and changed outer source before any mutation', async () => {
    const f = await fixture()
    f.state.vpns[0]!.connected = false
    expect(unwrap(await f.service.plan(f.profile)).plan).toMatchObject({ canApply: false })
    f.state.vpns[0]!.connected = true
    f.state.selected[0]!.source = '162.168.1.9'
    const planned = unwrap(await f.service.plan(f.profile))
    expect(planned.plan.steps.some(step => step.code === 'sourceAclMismatch')).toBe(true)
    expect(await f.service.apply(planned.plan.id)).toMatchObject({ ok: false, error: { code: 'PLAN_BLOCKED' } })
    expect(f.commands).toHaveLength(0)
  })

  it('allows a proxy-only hot reload without elevating the application', async () => {
    const f = await fixture()
    f.state.admin = false
    f.proxyState.bypassPrefixes = []
    const plan = unwrap(await f.service.plan({ ...f.profile, containerEnabled: false })).plan
    expect(plan.canApply).toBe(true)
    expect(plan.changes.map(change => change.id)).toEqual(['proxy-bypass'])
    expect(plan.steps.some(step => step.code === 'elevationRequired')).toBe(false)
  })

  it('accepts an existing broad 10/8 DIRECT rule for the configured container subnet', async () => {
    const f = await fixture()
    f.proxyState.bypassPrefixes = [f.profile.managementPrefix, '10.0.0.0/8']
    const plan = unwrap(await f.service.plan(f.profile)).plan
    expect(plan.steps.find(step => step.id === 'proxy')).toMatchObject({ state: 'ready' })
    expect(plan.changes.some(change => change.id === 'proxy-bypass')).toBe(false)
    expect(unwrap(await f.service.verify(f.profile)).find(probe => probe.kind === 'http-proxy')).toMatchObject({ ok: true })
  })

  it('does not pretend a VPN /16 overrides physical /21 or an old container /32', async () => {
    const f = await fixture()
    f.state.vpns[0]!.routes = []
    Object.assign(f.state.selected[0]!, { prefix: '191.168.0.0/21', interfaceIndex: 4, interfaceAlias: 'Ethernet' })
    let plan = unwrap(await f.service.plan(f.profile)).plan
    expect(plan.canApply).toBe(false)
    f.state.routes.push({ prefix: '10.204.19.81/32', nextHop: '191.168.7.151', interfaceIndex: 4, interfaceAlias: 'Ethernet', metric: 100, store: 'ActiveStore' })
    plan = unwrap(await f.service.plan(f.profile)).plan
    expect(plan.steps.some(step => step.code === 'routeConflict')).toBe(true)
  })

  it('rejects stale or expired plans and never trusts renderer-crafted changes', async () => {
    const f = await fixture()
    let plan = unwrap(await f.service.plan(f.profile)).plan
    f.state.selected[0]!.source = '162.168.1.7'
    expect(await f.service.apply(plan.id)).toMatchObject({ ok: false, error: { code: 'PLAN_STALE' } })
    f.state.selected[0]!.source = '162.168.1.2'
    plan = unwrap(await f.service.plan(f.profile)).plan
    f.setClock(f.timestamp + 120_001)
    expect(await f.service.apply(plan.id)).toMatchObject({ ok: false, error: { code: 'PLAN_EXPIRED' } })
    expect(f.commands).toHaveLength(0)
  })

  it('journals before mutation and reverses a command that partially succeeds then throws', async () => {
    const f = await fixture()
    f.profile.splitTunnelingPolicy = 'enabled'
    f.state.vpns[0]!.splitTunneling = false
    let failed = false
    f.setAfterCommand(async command => {
      if (command.action === 'split' && command.enabled && !failed) {
        const journal = JSON.parse(await fs.readFile(path.join(f.directory, 'network-apply-journal.json'), 'utf8'))
        expect(journal.entries[0].completed).toBe(false)
        failed = true
        throw new Error('INJECTED_FAILURE')
      }
    })
    const plan = unwrap(await f.service.plan(f.profile)).plan
    const result = unwrap(await f.service.apply(plan.id))
    expect(result.status).toBe('rolled-back')
    expect(f.state.vpns[0]!.splitTunneling).toBe(false)
    expect(f.commands.map(command => command.enabled)).toEqual([true, false])
  })

  it('preserves a route edited by another writer during failure rollback', async () => {
    const f = await fixture()
    f.profile.splitTunnelingPolicy = 'enabled'
    f.state.vpns[0]!.routes = []
    f.setAfterCommand(command => {
      if (command.action === 'vpnRouteAdd') { f.state.vpns[0]!.routes[0]!.metric = 99; throw new Error('INJECTED_FAILURE') }
    })
    const result = unwrap(await f.service.apply(unwrap(await f.service.plan(f.profile)).plan.id))
    expect(result.status).toBe('rollback-conflict')
    expect(f.state.vpns[0]!.routes[0]!.metric).toBe(99)
    expect(f.commands.some(command => command.action === 'vpnRouteRemove')).toBe(false)
  })

  it('recovers an interrupted inverse once and does not replay already-restored entries', async () => {
    const f = await fixture()
    f.profile.splitTunnelingPolicy = 'enabled'
    f.state.vpns[0]!.splitTunneling = false
    f.state.vpns[0]!.routes = []
    let restorationFailed = false
    f.setAfterCommand(command => {
      if (command.action === 'split' && command.enabled) throw new Error('INJECTED_FAILURE')
      if (command.action === 'vpnRouteRemove' && !restorationFailed) { restorationFailed = true; throw new Error('INJECTED_RESTORE_FAILURE') }
    })
    expect(unwrap(await f.service.apply(unwrap(await f.service.plan(f.profile)).plan.id)).status).toBe('rollback-conflict')
    expect(unwrap(await f.service.plan(f.profile)).plan.steps.some(step => step.code === 'recoveryRequired')).toBe(true)
    expect(unwrap(await f.service.recover()).status).toBe('rolled-back')
    expect(f.commands.filter(command => command.action === 'vpnRouteRemove')).toHaveLength(1)
    expect(await f.service.recover()).toMatchObject({ ok: false, error: { code: 'NO_PENDING_RECOVERY' } })
  })

  it.each([false, true])('switches work to home while preserving the corporate VPN, linked route stores=%s', async linked => {
    const f = await fixture('work', linked)
    let report = unwrap(await f.service.apply(unwrap(await f.service.plan(f.profile)).plan.id))
    expect(report.status).toBe('applied')
    expect(f.state.service.status).toBe('Stopped')
    expect(f.state.task!.enabled).toBe(false)
    expect(f.state.vpns[0]!.connected).toBe(true)
    expect(f.state.routes.map(route => route.store).sort()).toEqual(['ActiveStore', 'PersistentStore'])
    const home = { ...f.profile, id: 'home', mode: 'home' as const }
    Object.assign(f.state.selected[0]!, { source: '162.168.1.2', interfaceIndex: 47, interfaceAlias: home.vpnName, prefix: home.managementPrefix })
    Object.assign(f.state.selected[1]!, { source: '10.78.62.2', interfaceIndex: 51, interfaceAlias: home.tunnelName, nextHop: '0.0.0.0' })
    report = unwrap(await f.service.apply(unwrap(await f.service.plan(home)).plan.id))
    expect(report.status).toBe('applied')
    expect(f.state.routes).toHaveLength(0)
    expect(f.state.service.status).toBe('Running')
    expect(f.commands.every(command => !String(command.name).includes('ops-server'))).toBe(true)
  })

  it('retains independently owned active routes and blocks their deletion on a later home switch', async () => {
    const f = await fixture('work')
    f.state.routes.push({ prefix: f.profile.containerPrefix, nextHop: f.profile.gatewayAddress, interfaceIndex: 4, interfaceAlias: 'Ethernet', metric: 5, store: 'ActiveStore' })
    expect(unwrap(await f.service.apply(unwrap(await f.service.plan(f.profile)).plan.id)).status).toBe('applied')
    const home = { ...f.profile, mode: 'home' as const }
    Object.assign(f.state.selected[0]!, { source: '162.168.1.2', interfaceIndex: 47, interfaceAlias: home.vpnName, prefix: home.managementPrefix })
    expect(unwrap(await f.service.plan(home)).plan.canApply).toBe(false)
    expect(f.state.routes.find(route => route.store === 'ActiveStore')).toBeDefined()
  })

  it('blocks an unowned office route instead of silently deleting it for home mode', async () => {
    const f = await fixture()
    f.state.routes.push({ prefix: f.profile.containerPrefix, nextHop: f.profile.gatewayAddress, interfaceIndex: 4, interfaceAlias: 'Ethernet', metric: 5, store: 'PersistentStore' })
    const plan = unwrap(await f.service.plan(f.profile)).plan
    expect(plan.canApply).toBe(false)
    expect(plan.steps.some(step => step.code === 'routeConflict')).toBe(true)
  })

  it('generates traffic before measuring a fresh handshake and verifies the work next hop', async () => {
    const f = await fixture()
    f.state.handshakes = [0]
    f.setAfterTcp(target => { if (target === f.profile.containerProbeAddress) f.state.handshakes = [Math.floor(f.timestamp / 1000)] })
    const probes = unwrap(await f.service.verify(f.profile))
    expect(probes.find(probe => probe.kind === 'handshake')?.ok).toBe(true)
    const work = await fixture('work')
    work.state.selected[1]!.nextHop = '191.168.7.151'
    expect(unwrap(await work.service.verify(work.profile)).find(probe => probe.kind === 'route' && probe.target === work.profile.containerProbeAddress)?.ok).toBe(false)
    f.proxyState.bypassPrefixes = []
    expect(unwrap(await f.service.verify(f.profile)).find(probe => probe.kind === 'http-proxy')).toMatchObject({ ok: false, detail: 'PROXY_CONFIGURATION_MISMATCH' })
  })

  it('refuses a tampered recovery command and resolves manual host probes from the authoritative store', async () => {
    const f = await fixture()
    await fs.writeFile(path.join(f.directory, 'network-apply-journal.json'), JSON.stringify({ schemaVersion: 1, planId: 'old', profile: f.profile, status: 'applying', entries: [{ id: 'tunnel-stop', completed: true, operation: { id: 'tunnel-stop', command: { action: 'service', name: 'UnrelatedService', running: false }, inverse: { action: 'service', name: 'UnrelatedService', running: true }, before: true, after: false } }] }))
    expect(await f.service.recover()).toMatchObject({ ok: false, error: { code: 'RECOVERY_JOURNAL_INVALID' } })
    expect(f.commands).toHaveLength(0)
    expect(unwrap(await f.service.probeHost('11111111-1111-4111-8111-111111111111'))).toMatchObject({ target: '191.168.7.62', port: 2222, hostId: '11111111-1111-4111-8111-111111111111' })
  })

  it('opens OS login without credentials and blocks a concurrent apply', async () => {
    const f = await fixture()
    f.profile.splitTunnelingPolicy = 'enabled'
    unwrap(await f.service.login('vpn', f.profile))
    expect(f.commands[0]).toEqual({ action: 'openExternal', url: 'ms-settings:network-vpn' })
    f.state.vpns[0]!.splitTunneling = false
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    f.setAfterCommand(async () => { entered(); await gate })
    const plan = unwrap(await f.service.plan(f.profile)).plan
    const first = f.service.apply(plan.id)
    await started
    expect(await f.service.apply(plan.id)).toMatchObject({ ok: false, error: { code: 'NETWORK_BUSY' } })
    release()
    expect(unwrap(await first).status).toBe('applied')
  })
})
