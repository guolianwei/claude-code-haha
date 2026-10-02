import { ExternalLink } from 'lucide-react'
import { Badge, type Tone } from '@/components/ui/Badge'
import { useTranslation } from '@/i18n'
import { proxyBypassCovers, type NetworkProbe, type NetworkProfile, type NetworkSnapshot } from '../networkTypes'
import { networkIssueKey } from './networkMessages'

export type NetworkPathStage = 'physical' | 'vpn' | 'proxy' | 'containers' | 'plan' | 'verify'
type PathState = 'ready' | 'failed' | 'slow' | 'pending' | 'unknown'
type PathNode = { id: string; title: string; state: PathState; stage: NetworkPathStage; lines: string[]; hint?: string; checkedAt?: string; latencyMs?: number }
type Props = { profile: NetworkProfile; snapshot: NetworkSnapshot | null; probes: NetworkProbe[]; onNavigate?: (stage: NetworkPathStage) => void }

export const NETWORK_SLOW_PROBE_MS = 500
const tones: Record<PathState, Tone> = { ready: 'success', failed: 'danger', slow: 'warning', pending: 'neutral', unknown: 'neutral' }
const cardColors: Record<PathState, string> = {
  ready: 'border-[var(--color-success)] bg-[var(--color-success-container)]',
  failed: 'border-[var(--color-error)] bg-[var(--color-error-container)]',
  slow: 'border-[var(--color-warning)] bg-[var(--color-warning-container)]',
  pending: 'border-[var(--color-border)] bg-[var(--color-surface-container)]',
  unknown: 'border-[var(--color-border)] bg-[var(--color-surface-container)]',
}
const lineColors: Record<PathState, string> = {
  ready: 'text-[var(--color-success)]', failed: 'text-[var(--color-error)]', slow: 'text-[var(--color-warning)]',
  pending: 'text-[var(--color-text-tertiary)]', unknown: 'text-[var(--color-text-tertiary)]',
}
const stateKeys = {
  ready: 'networkManager.path.ready', failed: 'networkManager.path.failed', slow: 'networkManager.path.slow',
  pending: 'networkManager.path.pending', unknown: 'networkManager.path.unknown',
} as const

function latest(probes: NetworkProbe[], matches: (probe: NetworkProbe) => boolean) {
  return probes.filter(matches).sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0]
}

function probeState(probe: NetworkProbe | undefined): PathState {
  if (!probe) return 'unknown'
  if (!probe.ok) return 'failed'
  return (measuredLatency(probe) ?? -1) >= NETWORK_SLOW_PROBE_MS ? 'slow' : 'ready'
}

function measuredLatency(probe: NetworkProbe | undefined): number | undefined {
  return probe && ['tcp', 'http-direct', 'http-proxy'].includes(probe.kind)
    && Number.isFinite(probe.latencyMs) && probe.latencyMs >= 0 ? probe.latencyMs : undefined
}

function connectionState(from: PathState, to: PathState): PathState {
  if (from === 'failed' || to === 'failed') return 'failed'
  if (from === 'unknown' || to === 'unknown') return 'unknown'
  if (from === 'pending' || to === 'pending') return 'pending'
  return from === 'slow' || to === 'slow' ? 'slow' : 'ready'
}

/** A diagram of measured layers, never a declaration that all remote services are healthy. */
export function NetworkPathDiagram({ profile, snapshot, probes, onNavigate }: Props) {
  const t = useTranslation()
  const probeText = (code: string) => {
    const key = networkIssueKey(code)
    return key ? `${t(key)} (${code})` : code
  }
  const inspectedAt = snapshot?.collectedAt
  const vpnName = snapshot?.vpn.name || profile.vpnName
  const vpnServer = snapshot?.vpn.serverAddress || profile.vpnServerAddress
  const gatewayRoute = snapshot?.selectedRoutes.find(route => route.target === profile.gatewayAddress)
  const gatewayInterface = snapshot?.interfaces.find(iface => iface.index === gatewayRoute?.interfaceIndex)
  const selectedText = gatewayRoute
    ? `${gatewayRoute.interfaceAlias} · ${t('networkManager.path.source')}: ${gatewayRoute.source} · ${gatewayRoute.prefix}`
    : t('networkManager.path.noSnapshot')
  const unknownCollection = (prefix: string) => snapshot?.issues.some(issue => issue.startsWith(prefix)) ?? false
  const activePhysical = snapshot?.interfaces.filter(iface => iface.physical && iface.connected && iface.addresses.length) ?? []
  const physical: PathNode = {
    id: 'physical', title: t('networkManager.path.physical'), stage: 'physical',
    state: !snapshot || unknownCollection('interfaces') || unknownCollection('addresses') || unknownCollection('adapters')
      ? 'unknown' : activePhysical.length ? 'ready' : 'failed',
    lines: snapshot?.interfaces.filter(iface => iface.physical).map(iface =>
      `${iface.alias} · ${iface.addresses.join(', ')} · ${t(iface.connected ? 'networkManager.path.connected' : 'networkManager.path.disconnected')}`) ?? [],
    hint: t('networkManager.path.physicalHint'), checkedAt: inspectedAt,
  }
  const vpn: PathNode = {
    id: 'vpn', title: t('networkManager.path.vpn'), stage: 'vpn',
    state: !snapshot || unknownCollection('vpn/') || ['unknown', 'ambiguous'].includes(snapshot.vpn.status ?? '')
      ? 'unknown' : snapshot.vpn.exists && snapshot.vpn.connected ? 'ready' : 'failed',
    lines: [vpnName, `${t('networkManager.path.peer')}: ${vpnServer}`,
      ...(snapshot ? [`${t('networkManager.path.observed')}: ${t(snapshot.vpn.connected ? 'networkManager.path.connected' : 'networkManager.path.disconnected')}`, selectedText] : [])],
    hint: t('networkManager.path.vpnHint'), checkedAt: inspectedAt,
  }
  const managementProbe = latest(probes, probe => probe.kind === 'tcp' && probe.target === profile.gatewayAddress && probe.port === profile.gatewayPort)
  const gateway: PathNode = {
    id: 'gateway', title: t('networkManager.path.gateway'), stage: 'physical', state: probeState(managementProbe),
    lines: [`${profile.gatewayAddress}:${profile.gatewayPort}/TCP`, ...(managementProbe ? [probeText(managementProbe.detail)] : [])],
    checkedAt: managementProbe?.checkedAt, latencyMs: measuredLatency(managementProbe),
  }
  const selectedCorrect = profile.mode === 'home' ? gatewayRoute?.interfaceAlias === vpnName
    : !!gatewayInterface?.physical && gatewayInterface.connected
  const outer: PathNode = {
    id: 'outer', title: t('networkManager.path.outerHop'), stage: profile.mode === 'home' ? 'vpn' : 'physical',
    state: !snapshot || unknownCollection(`selected/${profile.gatewayAddress}`) ? 'unknown'
      : !gatewayRoute || !selectedCorrect ? 'failed' : 'ready',
    lines: [selectedText], checkedAt: inspectedAt,
  }
  const tunnel = snapshot?.tunnel
  const tunnelRoute = snapshot?.selectedRoutes.find(route => route.target === (profile.verificationTargets[0]?.address ?? profile.containerProbeAddress))
  const routeMatches = tunnelRoute?.interfaceAlias === profile.tunnelName && tunnelRoute.source === profile.tunnelAddress
  const handshake = latest(probes, probe => probe.kind === 'handshake' && probe.target === profile.tunnelName)
  const wireguard: PathNode = {
    id: 'wireguard', title: t('networkManager.path.wireguard'), stage: 'containers',
    state: !tunnel || tunnel.serviceStatus === 'unknown' || unknownCollection('tunnelService') || unknownCollection('handshake') ? 'unknown'
      : !tunnel.serviceExists || !tunnel.running ? 'failed'
        : (tunnelRoute && !routeMatches) || handshake?.ok === false ? 'failed'
          : routeMatches && handshake?.ok ? 'ready' : 'pending',
    lines: [profile.tunnelName, `${t('networkManager.path.configured')}: ${profile.tunnelAddress} · ${profile.containerPrefix}`,
      ...(tunnel ? [`${t('networkManager.path.service')}: ${t(tunnel.serviceStatus === 'unknown' ? 'networkManager.path.unknown' : tunnel.running ? 'networkManager.path.running' : 'networkManager.path.stopped')}`] : []),
      ...(tunnelRoute ? [`${t('networkManager.path.route')}: ${tunnelRoute.interfaceAlias} · ${tunnelRoute.source} · ${tunnelRoute.prefix}`] : [])],
    hint: t('networkManager.path.tunnelHint'), checkedAt: handshake?.checkedAt ?? inspectedAt,
  }
  const relayProbe = latest(probes, probe => probe.kind === 'relay' && (probe.target === profile.relayTaskName || probe.target === `127.0.0.1:${profile.relayLocalPort}`))
  const stateText = (value: boolean | undefined) => t(value === undefined ? 'networkManager.path.unknown' : value ? 'networkManager.path.yes' : 'networkManager.path.no')
  const relay: PathNode = {
    id: 'relay', title: t('networkManager.path.relay'), stage: 'containers',
    state: !tunnel || tunnel.taskStatus === 'unknown' || unknownCollection('relayTask') ? 'unknown'
      : !tunnel.taskExists || !tunnel.taskRunning || !tunnel.taskEnabled ? 'failed'
        : relayProbe?.ok === false || tunnel.udpListening === false || tunnel.tcpConnected === false ? 'failed'
          : tunnel.relayReady === true || relayProbe?.ok === true ? 'ready' : 'pending',
    lines: [`127.0.0.1:${profile.relayLocalPort}/UDP → ${profile.gatewayAddress}:${profile.relayPort}/TCP`, profile.relayTaskName,
      ...(tunnel ? [`${t('networkManager.path.task')}: ${t(tunnel.taskStatus === 'unknown' ? 'networkManager.path.unknown' : tunnel.taskRunning ? 'networkManager.path.running' : 'networkManager.path.stopped')}`,
        `${t('networkManager.path.udp')}: ${stateText(tunnel.udpListening)}`, `${t('networkManager.path.tcp')}: ${stateText(tunnel.tcpConnected)}`,
        ...(tunnel.processPriority ? [`${t('networkManager.path.priority')}: ${tunnel.processPriority}`] : []), ...(tunnel.readinessIssues ?? []).map(probeText)] : [])],
    hint: t('networkManager.path.relayHint'), checkedAt: relayProbe?.checkedAt ?? inspectedAt,
  }
  const remoteRelayProbe = latest(probes, probe => probe.kind === 'tcp' && probe.target === profile.gatewayAddress && probe.port === profile.relayPort)
  const remoteRelay: PathNode = {
    id: 'remote-relay', title: t('networkManager.path.remoteRelay'), stage: 'containers', state: probeState(remoteRelayProbe),
    lines: [`${profile.gatewayAddress}:${profile.relayPort}/TCP`, ...(remoteRelayProbe ? [probeText(remoteRelayProbe.detail)] : [])],
    checkedAt: remoteRelayProbe?.checkedAt, latencyMs: measuredLatency(remoteRelayProbe),
  }
  const remoteNetwork: PathNode = {
    id: 'remote-network', title: t('networkManager.path.remoteNetwork'), stage: 'containers', state: 'unknown',
    lines: [`${profile.gatewayAddress} → ${profile.containerPrefix}`], hint: t('networkManager.path.remoteUnknown'),
  }
  const targets = profile.verificationTargets.length ? profile.verificationTargets : [{
    id: 'legacy-target', label: '', address: profile.containerProbeAddress, port: profile.containerProbePort, protocol: 'tcp' as const,
  }]
  const targetNodes: PathNode[] = targets.map(target => {
    const targetRoute = snapshot?.selectedRoutes.find(route => route.target === target.address)
    const targetRouteProbe = latest(probes, probe => probe.kind === 'route' && probe.target === target.address)
    const routeInterface = snapshot?.interfaces.find(iface => iface.index === targetRoute?.interfaceIndex)
    const routeMismatch = profile.containerEnabled && (targetRouteProbe?.ok === false || !!targetRoute && (profile.mode === 'home'
      ? targetRoute.interfaceAlias !== profile.tunnelName || targetRoute.source !== profile.tunnelAddress
      : !routeInterface?.physical || !routeInterface.connected || targetRoute.nextHop !== profile.gatewayAddress))
    const targetProbe = latest(probes, probe => target.protocol === 'tcp'
      ? probe.kind === 'tcp' && probe.target === target.address && probe.port === target.port
      : probe.kind === 'http-direct' && probe.target === `${target.protocol}://${target.address}:${target.port}/`)
    return {
      id: `target-${target.id}`, title: target.label || `${target.address}:${target.port}`, stage: 'verify', state: routeMismatch ? 'failed' : probeState(targetProbe),
      lines: [`${target.address}:${target.port}/${target.protocol.toUpperCase()}`,
        ...(targetRoute ? [`${t('networkManager.path.route')}: ${targetRoute.interfaceAlias} · ${targetRoute.source} · ${targetRoute.prefix}`] : []),
        ...(targetProbe ? [probeText(targetProbe.detail), ...(targetProbe.statusCode ? [`HTTP ${targetProbe.statusCode}`] : []),
          ...(targetProbe.source ? [`${t('networkManager.path.source')}: ${targetProbe.source}`] : [])] : [])],
      checkedAt: targetProbe?.checkedAt, latencyMs: measuredLatency(targetProbe),
    }
  })
  const desiredBypass = [profile.managementPrefix, ...(profile.containerEnabled ? [profile.containerPrefix] : [])]
  const proxyReady = snapshot?.proxy.available && snapshot.proxy.mode === 'rule'
    && desiredBypass.every(prefix => proxyBypassCovers(snapshot.proxy.bypassPrefixes, prefix))
  const sakura: PathNode = {
    id: 'sakura', title: t('networkManager.path.sakura'), stage: 'proxy',
    state: !snapshot || unknownCollection('PROXY_') ? 'unknown' : !snapshot.proxy.available ? 'failed' : proxyReady ? 'ready' : 'pending',
    lines: [`127.0.0.1:${profile.proxyPort}`, ...(snapshot?.proxy.available ? [snapshot.proxy.mode, ...snapshot.proxy.bypassPrefixes.map(prefix => `${prefix} DIRECT`)] : [])],
    hint: t('networkManager.path.proxyHint'), checkedAt: inspectedAt,
  }
  const externalProbe = latest(probes, probe => probe.kind === 'http-proxy' && probe.target === profile.externalProbeUrl)
  const external: PathNode = {
    id: 'internet', title: t('networkManager.path.internet'), stage: 'proxy', state: probeState(externalProbe),
    lines: [profile.externalProbeUrl, ...(externalProbe ? [probeText(externalProbe.detail), ...(externalProbe.statusCode ? [`HTTP ${externalProbe.statusCode}`] : [])] : [])],
    checkedAt: externalProbe?.checkedAt, latencyMs: measuredLatency(externalProbe),
  }

  function card(node: PathNode) {
    return <article data-testid={`network-path-${node.id}`} data-state={node.state} aria-label={node.title}
      className={`h-full min-w-0 space-y-2 rounded-[var(--radius-md)] border-2 p-3 ${cardColors[node.state]}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        {onNavigate ? <button type="button" className="inline-flex min-w-0 items-center gap-1 text-left text-sm font-semibold text-[var(--color-text-primary)] hover:underline"
          onClick={() => onNavigate(node.stage)} title={t('networkManager.path.openStep')}>
          {node.title}<ExternalLink size={12} aria-hidden className="shrink-0" />
        </button> : <h5 className="text-sm font-semibold">{node.title}</h5>}
        <Badge tone={tones[node.state]} wrap>{t(stateKeys[node.state])}</Badge>
      </div>
      {node.lines.map((line, index) => <p key={index} className="break-words text-xs text-[var(--color-text-secondary)]">{line}</p>)}
      {node.latencyMs !== undefined && <p className="text-xs font-semibold tabular-nums" data-testid={`network-path-latency-${node.id}`}>{t('networkManager.path.elapsed')}: {node.latencyMs} ms</p>}
      {node.hint && <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{node.hint}</p>}
      {node.checkedAt && <p className="text-xs text-[var(--color-text-tertiary)]">{t('networkManager.path.checked')}: <time dateTime={node.checkedAt}>{new Date(node.checkedAt).toLocaleString()}</time></p>}
    </article>
  }

  function connector(from: PathNode, to: PathNode, horizontal = false) {
    const state = connectionState(from.state, to.state)
    return <div data-testid={`network-path-link-${from.id}-${to.id}`} data-from={from.id} data-to={to.id} data-state={state}
      role="img" aria-label={`${from.title} → ${to.title} · ${t(stateKeys[state])}`}
      className={`flex shrink-0 items-center justify-center ${horizontal ? 'h-full w-10' : 'h-9 xl:h-auto xl:w-10'} ${lineColors[state]}`}>
      {!horizontal && <svg aria-hidden viewBox="0 0 24 36" className="h-full w-6 xl:hidden" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path data-path="line" d="M12 0V36" /><path data-path="arrow" d="M6 29L12 36L18 29" strokeLinejoin="round" />
      </svg>}
      <svg aria-hidden viewBox="0 0 40 24" className={horizontal ? 'h-6 w-full' : 'hidden h-6 w-full xl:block'} fill="none" stroke="currentColor" strokeWidth="2.5">
        <path data-path="line" d="M0 12H40" /><path data-path="arrow" d="M33 6L40 12L33 18" strokeLinejoin="round" />
      </svg>
    </div>
  }

  function chain(title: string, nodes: PathNode[]) {
    return <section className="space-y-2" aria-label={title}>
      <h4 className="text-sm font-semibold">{title}</h4>
      <ol className="flex flex-col xl:flex-row">
        {nodes.map((node, index) => <li key={node.id} className="flex min-w-0 flex-1 flex-col xl:flex-row">
          <div className="min-w-0 flex-1">{card(node)}</div>
          {index < nodes.length - 1 && connector(node, nodes[index + 1]!)}
        </li>)}
      </ol>
    </section>
  }

  return <section className="space-y-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4" aria-label={t('networkManager.path.title')}>
    <div className="space-y-1">
      <h3 className="text-sm font-semibold">{t('networkManager.path.title')}</h3>
      <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{t('networkManager.path.hint')}</p>
      <div className="flex flex-wrap gap-2" aria-label={t('networkManager.path.legend')}>
        {(['ready', 'failed', 'slow', 'unknown'] as const).map(state => <Badge key={state} tone={tones[state]} bordered>{t(stateKeys[state])}</Badge>)}
      </div>
      <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{t('networkManager.path.legendHint', { threshold: NETWORK_SLOW_PROBE_MS })}</p>
      {!snapshot && <p role="status" className="text-xs text-[var(--color-text-secondary)]">{t('networkManager.path.noSnapshot')}</p>}
    </div>
    {chain(t('networkManager.path.outer'), profile.mode === 'home' ? [physical, vpn, gateway] : [physical, gateway])}
    {profile.containerEnabled ? chain(t(profile.mode === 'home' ? 'networkManager.path.inner' : 'networkManager.path.office'),
      profile.mode === 'home' ? [wireguard, relay, outer, remoteRelay, remoteNetwork] : [outer, remoteNetwork])
      : <p className="text-xs text-[var(--color-text-secondary)]">{t('networkManager.path.disabled')}</p>}
    {(profile.containerEnabled || profile.verificationTargets.length > 0) &&
      <section className="space-y-2" aria-label={t('networkManager.path.targets')}>
        <h4 className="text-sm font-semibold">{t('networkManager.path.targets')}</h4>
        <p className="text-xs text-[var(--color-text-secondary)]">{t('networkManager.path.targetHint')}</p>
        <div className="pt-2">
          <p className="mb-0 ml-3 text-xs font-medium text-[var(--color-text-secondary)]">{profile.containerEnabled ? remoteNetwork.title : outer.title}</p>
          <ul data-testid="network-path-target-branches" className="ml-3">{targetNodes.map((node, index) => <li key={node.id} className="flex min-w-0">
            <div className="relative w-10 shrink-0">
              <span aria-hidden data-testid={`network-path-spine-${node.id}`} className={`absolute left-0 top-0 border-l-2 border-[var(--color-text-tertiary)] ${index === targetNodes.length - 1 ? 'h-1/2' : 'h-full'}`} />
              {connector(profile.containerEnabled ? remoteNetwork : outer, node, true)}
            </div>
            <div className="min-w-0 flex-1 py-1">{card(node)}</div>
          </li>)}</ul>
        </div>
      </section>
    }
    {chain(t('networkManager.path.external'), [sakura, external])}
  </section>
}
