import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { createDefaultNetworkProfiles, type NetworkProbe } from '../networkTypes'
import { createNetworkFixture } from '../testing/networkFixture'
import { NetworkPathDiagram } from './NetworkPathDiagram'

beforeEach(() => { useSettingsStore.setState({ locale: 'en' }) })
afterEach(cleanup)
const getNode = (id: string) => screen.getByTestId(`network-path-${id}`)
const probe = (target: string, overrides: Partial<NetworkProbe> = {}): NetworkProbe => ({
  target, port: 22, kind: 'tcp', ok: true, checkedAt: '2026-10-02T02:01:00.000Z', latencyMs: 2, detail: 'TCP_CONNECTED', ...overrides,
})

function fixture() {
  const profile = createDefaultNetworkProfiles()[0]
  profile.verificationTargets = [
    { id: 'ssh', label: 'Container SSH', address: '10.204.19.81', port: 22, protocol: 'tcp' },
    { id: 'web', label: 'Container HTTP', address: '10.204.19.81', port: 8080, protocol: 'http' },
  ]
  const snapshot = createNetworkFixture().snapshot
  snapshot.collectedAt = '2026-10-02T02:00:00.000Z'
  snapshot.vpn = { ...snapshot.vpn, name: '公司', serverAddress: profile.vpnServerAddress, scope: 'allUsers', status: 'present' }
  snapshot.selectedRoutes[0] = { target: profile.gatewayAddress, source: profile.expectedRelaySource, interfaceIndex: 47,
    interfaceAlias: '公司', prefix: '0.0.0.0/0', nextHop: '0.0.0.0' }
  snapshot.selectedRoutes.push({ target: profile.containerProbeAddress, source: profile.tunnelAddress, interfaceIndex: 51,
    interfaceAlias: profile.tunnelName, prefix: profile.containerPrefix, nextHop: '0.0.0.0' })
  return { profile, snapshot }
}

describe('network path evidence', () => {
  it('shows every configured layer as unmeasured until observed, including remote Docker internals', () => {
    const { profile } = fixture()
    render(<NetworkPathDiagram profile={profile} snapshot={null} probes={[]} />)
    for (const id of ['physical', 'vpn', 'gateway', 'wireguard', 'relay', 'outer', 'remote-relay', 'remote-network', 'target-ssh', 'target-web', 'sakura', 'internet']) {
      expect(getNode(id)).toHaveAttribute('data-state', 'unknown')
    }
    expect(screen.queryAllByRole('article').every(node => node.getAttribute('data-state') === 'unknown')).toBe(true)
    expect(within(getNode('relay')).getByText('127.0.0.1:51824/UDP → 191.168.7.62:51826/TCP')).toBeVisible()
  })

  it('marks observed missing relay ports and a stopped tunnel failed despite task Running and endpoint success', () => {
    const { profile, snapshot } = fixture()
    snapshot.tunnel = { ...snapshot.tunnel, running: false, relayReady: false, udpListening: false, tcpConnected: false }
    render(<NetworkPathDiagram profile={profile} snapshot={snapshot} probes={[probe('10.204.19.81')]} />)
    expect(getNode('relay')).toHaveAttribute('data-state', 'failed')
    expect(getNode('wireguard')).toHaveAttribute('data-state', 'failed')
    expect(getNode('target-ssh')).toHaveAttribute('data-state', 'ready')
    expect(getNode('target-web')).toHaveAttribute('data-state', 'unknown')
    expect(getNode('remote-network')).toHaveAttribute('data-state', 'unknown')
  })

  it('shows successful local layers separately from unmeasured server internals and exact endpoint protocol results', () => {
    const { profile, snapshot } = fixture()
    snapshot.tunnel = { ...snapshot.tunnel, relayReady: true, udpListening: true, tcpConnected: true, processPriority: 'Normal' }
    render(<NetworkPathDiagram profile={profile} snapshot={snapshot} probes={[
      probe(profile.tunnelName, { kind: 'handshake', port: undefined }),
      probe(profile.gatewayAddress, { port: profile.gatewayPort }),
      probe(profile.gatewayAddress, { port: profile.relayPort }),
      probe('http://10.204.19.81:8080/', { kind: 'http-direct', port: 8080, statusCode: 200, source: '10.78.62.2' }),
    ]} />)
    for (const id of ['wireguard', 'relay', 'gateway', 'outer', 'remote-relay', 'target-web']) {
      expect(getNode(id)).toHaveAttribute('data-state', 'ready')
    }
    expect(getNode('target-ssh')).toHaveAttribute('data-state', 'unknown')
    expect(getNode('remote-network')).toHaveAttribute('data-state', 'unknown')
    expect(within(getNode('target-web')).getByText('HTTP 200')).toBeVisible()
    expect(within(getNode('target-web')).getByText('Source: 10.78.62.2')).toBeVisible()
    expect(within(getNode('relay')).getByText('Process priority: Normal')).toBeVisible()
    expect(within(getNode('vpn')).getByText('公司')).toBeVisible()
    expect(getNode('gateway').querySelector('time')).toHaveAttribute('datetime', '2026-10-02T02:01:00.000Z')
  })

  it('reports collection failures as unknown rather than missing and does not infer a verified tunnel from handshake age alone', () => {
    const { profile, snapshot } = fixture()
    snapshot.tunnel.taskStatus = 'unknown'
    snapshot.tunnel.taskRunning = false
    snapshot.tunnel.taskExists = false
    render(<NetworkPathDiagram profile={profile} snapshot={snapshot} probes={[]} />)
    expect(getNode('relay')).toHaveAttribute('data-state', 'unknown')
    expect(within(getNode('relay')).getByText('Task: Unknown / not measured')).toBeVisible()
    expect(getNode('wireguard')).toHaveAttribute('data-state', 'pending')
  })

  it('identifies the wrong actual outer interface even while the selected VPN remains connected', () => {
    const { profile, snapshot } = fixture()
    snapshot.selectedRoutes[0] = { ...snapshot.selectedRoutes[0]!, interfaceAlias: 'WLAN', interfaceIndex: 7, source: '192.168.3.93' }
    render(<NetworkPathDiagram profile={profile} snapshot={snapshot} probes={[]} />)
    expect(getNode('vpn')).toHaveAttribute('data-state', 'ready')
    expect(getNode('outer')).toHaveAttribute('data-state', 'failed')
    expect(within(getNode('outer')).getByText('WLAN · Source: 192.168.3.93 · 0.0.0.0/0')).toBeVisible()
  })

  it('uses the latest matching endpoint result and ignores a response for another protocol or port', () => {
    const { profile, snapshot } = fixture()
    render(<NetworkPathDiagram profile={profile} snapshot={snapshot} probes={[
      probe('10.204.19.81'),
      probe('10.204.19.81', { ok: false, checkedAt: '2026-10-02T02:02:00.000Z', detail: 'TCP_TIMEOUT' }),
      probe('http://10.204.19.81:80/', { kind: 'http-direct', port: 80 }),
      probe('https://10.204.19.81:8080/', { kind: 'http-direct', port: 8080 }),
    ]} />)
    expect(getNode('target-ssh')).toHaveAttribute('data-state', 'failed')
    expect(getNode('target-web')).toHaveAttribute('data-state', 'unknown')
  })

  it('uses the active target list for tunnel route evidence and matches the exact local relay endpoint', () => {
    const { profile, snapshot } = fixture()
    profile.verificationTargets[0]!.address = '10.204.19.84'
    snapshot.selectedRoutes[1] = { ...snapshot.selectedRoutes[1]!, target: '10.204.19.84' }
    snapshot.tunnel.relayReady = undefined
    render(<NetworkPathDiagram profile={profile} snapshot={snapshot} probes={[
      probe(`127.0.0.1:${profile.relayLocalPort}`, { kind: 'relay', port: undefined }),
      probe(profile.tunnelName, { kind: 'handshake', port: undefined }),
    ]} />)
    expect(getNode('relay')).toHaveAttribute('data-state', 'ready')
    expect(getNode('wireguard')).toHaveAttribute('data-state', 'ready')
  })

  it('does not show a reachable HTTP target as restored when its route takes another interface', () => {
    const { profile, snapshot } = fixture()
    snapshot.selectedRoutes[1] = { ...snapshot.selectedRoutes[1]!, interfaceAlias: 'Company', source: '162.168.1.2' }
    render(<NetworkPathDiagram profile={profile} snapshot={snapshot} probes={[
      probe('http://10.204.19.81:8080/', { kind: 'http-direct', port: 8080, statusCode: 200 }),
      probe('10.204.19.81', { kind: 'route', port: undefined, ok: false, detail: 'ROUTE_MISMATCH' }),
    ]} />)
    expect(getNode('target-web')).toHaveAttribute('data-state', 'failed')
    expect(within(getNode('target-web')).getByText('HTTP 200')).toBeVisible()
    expect(within(getNode('target-web')).getByText(/Selected route: Company/)).toBeVisible()
  })

  it('still shows independent service endpoints when the container channel is disabled', () => {
    const { profile, snapshot } = fixture()
    profile.containerEnabled = false
    snapshot.selectedRoutes[1] = { ...snapshot.selectedRoutes[1]!, interfaceAlias: 'Company', source: '162.168.1.2' }
    render(<NetworkPathDiagram profile={profile} snapshot={snapshot} probes={[
      probe('http://10.204.19.81:8080/', { kind: 'http-direct', port: 8080, statusCode: 200 }),
    ]} />)
    expect(screen.queryByTestId('network-path-wireguard')).toBeNull()
    expect(getNode('target-web')).toHaveAttribute('data-state', 'ready')
    expect(within(getNode('target-web')).getByText(/Selected route: Company/)).toBeVisible()
  })

  it('renders the office physical path without home tunnel nodes and navigates to the selected configuration step', () => {
    const { profile, snapshot } = fixture()
    profile.mode = 'work'
    snapshot.selectedRoutes[0] = { ...snapshot.selectedRoutes[0]!, interfaceAlias: 'Fixture Ethernet', interfaceIndex: 7 }
    const onNavigate = vi.fn()
    render(<NetworkPathDiagram profile={profile} snapshot={snapshot} probes={[]} onNavigate={onNavigate} />)
    expect(screen.queryByTestId('network-path-vpn')).toBeNull()
    expect(screen.queryByTestId('network-path-wireguard')).toBeNull()
    expect(screen.queryByTestId('network-path-relay')).toBeNull()
    expect(getNode('outer')).toHaveAttribute('data-state', 'ready')
    fireEvent.click(within(getNode('target-web')).getByRole('button', { name: 'Container HTTP' }))
    expect(onNavigate).toHaveBeenCalledWith('verify')
    fireEvent.click(within(getNode('physical')).getByRole('button', { name: 'Physical network adapter' }))
    expect(onNavigate).toHaveBeenLastCalledWith('physical')
  })

  it.each([[499, 'ready'], [500, 'slow'], [1600, 'slow']] as const)('classifies a successful %s ms TCP check at the visible 500 ms threshold', (latencyMs, state) => {
    const { profile, snapshot } = fixture()
    render(<NetworkPathDiagram profile={profile} snapshot={snapshot} probes={[probe(profile.gatewayAddress, { latencyMs, port: profile.gatewayPort })]} />)
    expect(getNode('gateway')).toHaveAttribute('data-state', state)
    expect(screen.getByTestId('network-path-latency-gateway')).toHaveTextContent(`${latencyMs} ms`)
    expect(getNode('gateway')).toHaveClass(state === 'slow' ? 'border-[var(--color-warning)]' : 'border-[var(--color-success)]')
    expect(screen.getByText(/at least 500 ms/)).toHaveTextContent('not ICMP ping')
  })

  it('colors successful HTTP and relay probes yellow while a slow failed response remains red', () => {
    const { profile, snapshot } = fixture()
    render(<NetworkPathDiagram profile={profile} snapshot={snapshot} probes={[
      probe(profile.gatewayAddress, { port: profile.relayPort, latencyMs: 800 }),
      probe('http://10.204.19.81:8080/', { kind: 'http-direct', port: 8080, latencyMs: 700 }),
      probe(profile.externalProbeUrl, { kind: 'http-proxy', port: undefined, latencyMs: 900 }),
      probe('10.204.19.81', { latencyMs: 3000, ok: false, detail: 'TCP_TIMEOUT' }),
    ]} />)
    for (const id of ['remote-relay', 'target-web', 'internet']) {
      expect(getNode(id)).toHaveAttribute('data-state', 'slow')
      expect(getNode(id)).toHaveClass('bg-[var(--color-warning-container)]')
    }
    expect(getNode('target-ssh')).toHaveAttribute('data-state', 'failed')
    expect(getNode('target-ssh')).toHaveClass('border-[var(--color-error)]', 'bg-[var(--color-error-container)]')
    expect(screen.getByTestId('network-path-latency-target-ssh')).toHaveTextContent('3000 ms')
  })

  it('uses gray for pending and unknown nodes and never invents elapsed time for virtual adapters', () => {
    const { profile, snapshot } = fixture()
    snapshot.tunnel.relayReady = false
    render(<NetworkPathDiagram profile={profile} snapshot={snapshot} probes={[
      probe(profile.tunnelName, { kind: 'handshake', port: undefined, latencyMs: 900 }),
    ]} />)
    expect(getNode('relay')).toHaveAttribute('data-state', 'pending')
    for (const id of ['relay', 'remote-network']) {
      expect(getNode(id)).toHaveClass('bg-[var(--color-surface-container)]')
      expect(getNode(id)).not.toHaveClass('bg-[var(--color-warning-container)]')
    }
    expect(getNode('wireguard')).toHaveAttribute('data-state', 'ready')
    for (const id of ['physical', 'vpn', 'wireguard', 'relay']) expect(screen.queryByTestId(`network-path-latency-${id}`)).toBeNull()
  })

  it('connects adjacent nodes with continuous horizontal and vertical arrows and leaves unmeasured remote branches gray', () => {
    const { profile, snapshot } = fixture()
    render(<NetworkPathDiagram profile={profile} snapshot={snapshot} probes={[probe('10.204.19.81')]} />)
    const link = screen.getByTestId('network-path-link-physical-vpn')
    expect(link).toHaveAttribute('data-from', 'physical')
    expect(link).toHaveAttribute('data-to', 'vpn')
    expect(link.querySelectorAll('svg')).toHaveLength(2)
    expect(link.querySelectorAll('path[data-path="line"]')).toHaveLength(2)
    expect(link.querySelectorAll('path[data-path="arrow"]')).toHaveLength(2)
    expect(link.querySelector('path[d="M0 12H40"]')).not.toBeNull()
    expect(link.querySelector('path[d="M12 0V36"]')).not.toBeNull()
    expect(screen.getByTestId('network-path-link-vpn-gateway')).toHaveAttribute('data-state', 'unknown')
    expect(screen.getByTestId('network-path-link-remote-network-target-ssh')).toHaveAttribute('data-state', 'unknown')
    expect(screen.getByTestId('network-path-target-branches')).toBeVisible()
  })

  it('keeps a wrong route red even when its successful HTTP response exceeds the slow threshold', () => {
    const { profile, snapshot } = fixture()
    snapshot.selectedRoutes[1] = { ...snapshot.selectedRoutes[1]!, interfaceAlias: 'WLAN', source: '192.168.3.93' }
    render(<NetworkPathDiagram profile={profile} snapshot={snapshot} probes={[
      probe('http://10.204.19.81:8080/', { kind: 'http-direct', port: 8080, latencyMs: 900, statusCode: 200 }),
    ]} />)
    expect(getNode('target-web')).toHaveAttribute('data-state', 'failed')
    expect(getNode('target-web')).toHaveClass('bg-[var(--color-error-container)]')
    expect(screen.getByTestId('network-path-latency-target-web')).toHaveTextContent('900 ms')
  })

  it.each(['udpListening', 'tcpConnected'] as const)('shows an explicitly failed %s observation in red without waiting for another relay probe', field => {
    const { profile, snapshot } = fixture()
    snapshot.tunnel[field] = false
    render(<NetworkPathDiagram profile={profile} snapshot={snapshot} probes={[]} />)
    expect(getNode('relay')).toHaveAttribute('data-state', 'failed')
    expect(getNode('relay')).toHaveClass('bg-[var(--color-error-container)]')
  })

  it.each([1, 2, 5])('connects all %s endpoint branches to a continuous left spine without grid gaps', count => {
    const { profile, snapshot } = fixture()
    profile.verificationTargets = Array.from({ length: count }, (_, index) => ({ id: `endpoint-${index}`, label: `Endpoint ${index}`,
      address: `10.204.19.${81 + index}`, port: 22, protocol: 'tcp' }))
    render(<NetworkPathDiagram profile={profile} snapshot={snapshot} probes={[]} />)
    const branches = screen.getByTestId('network-path-target-branches')
    expect(branches.children).toHaveLength(count)
    for (let index = 0; index < count; index++) {
      const spine = screen.getByTestId(`network-path-spine-target-endpoint-${index}`)
      expect(spine).toHaveClass('left-0', 'top-0', index === count - 1 ? 'h-1/2' : 'h-full')
      const edge = screen.getByTestId(`network-path-link-remote-network-target-endpoint-${index}`)
      expect(edge).toHaveAttribute('data-state', 'unknown')
      expect(edge.querySelectorAll('svg')).toHaveLength(1)
      expect(edge.querySelector('path[d="M0 12H40"]')).not.toBeNull()
      expect(edge).toHaveClass('h-full', 'w-10')
    }
  })
})
