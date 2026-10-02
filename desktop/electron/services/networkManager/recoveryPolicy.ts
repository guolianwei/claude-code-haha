import type { NetworkProfile, NetworkSnapshot, NetworkVerificationTarget } from '../../../src/features/network-manager/networkTypes'

type Vpn = { name: string; scope: string; serverAddress?: string; connected: boolean; splitTunneling: boolean; routes: { prefix: string; metric: number }[] }

/** The name is a hint until resolved; the scope and server fence renamed profiles. */
export function resolveObservedVpn(profile: NetworkProfile, vpns: Vpn[], issues: string[]): { status: 'present' | 'missing' | 'ambiguous' | 'unknown'; vpn?: Vpn } {
  if (issues.some(issue => issue.startsWith('vpn/'))) return { status: 'unknown' }
  const scoped = vpns.filter(vpn => vpn.scope === profile.vpnScope)
  const candidates = profile.vpnServerAddress
    ? scoped.filter(vpn => vpn.serverAddress?.toLowerCase() === profile.vpnServerAddress.toLowerCase()
      // Older test/bridge snapshots can only prove the exact name, never a rename.
      || (!vpn.serverAddress && vpn.name === profile.vpnName))
    : scoped.filter(vpn => vpn.name === profile.vpnName)
  const exact = candidates.filter(vpn => vpn.name === profile.vpnName)
  if (exact.length === 1) return { status: 'present', vpn: exact[0] }
  if (candidates.length === 1) return { status: 'present', vpn: candidates[0] }
  return { status: candidates.length > 1 ? 'ambiguous' : 'missing' }
}

export function verificationTargets(profile: NetworkProfile): NetworkVerificationTarget[] {
  return profile.verificationTargets.length ? profile.verificationTargets : [{
    id: 'profile-probe', label: '', address: profile.containerProbeAddress, port: profile.containerProbePort, protocol: 'tcp',
  }]
}

export function hasContainerRoute(profile: NetworkProfile, snapshot: NetworkSnapshot, address: string): boolean {
  const route = snapshot.selectedRoutes.find(item => item.target === address)
  if (!route || route.prefix !== profile.containerPrefix) return false
  if (profile.mode === 'home') return route.interfaceAlias === profile.tunnelName && route.source === profile.tunnelAddress
  const gateway = snapshot.selectedRoutes.find(item => item.target === profile.gatewayAddress)
  return route.interfaceIndex === gateway?.interfaceIndex && route.nextHop === profile.gatewayAddress
    && snapshot.interfaces.some(item => item.index === route.interfaceIndex && item.physical && item.connected)
}
