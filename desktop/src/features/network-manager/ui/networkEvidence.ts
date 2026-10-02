import type { NetworkProbe, NetworkProfile, NetworkStepId, NetworkVerificationTarget } from '../networkTypes'

export function matchesVerificationTarget(probe: NetworkProbe, target: Pick<NetworkVerificationTarget, 'address' | 'port' | 'protocol'>) {
  return target.protocol === 'tcp'
    ? probe.kind === 'tcp' && probe.target === target.address && probe.port === target.port
    : probe.kind === 'http-direct' && probe.target === `${target.protocol}://${target.address}:${target.port}/`
}

export function probeBelongsToStep(probe: NetworkProbe, step: NetworkStepId, profile: NetworkProfile): boolean {
  if (step === 'physical' && probe.detail.startsWith('PHYSICAL_')) return true
  if (step === 'vpn' && probe.detail.startsWith('VPN_')) return true
  if (step === 'physical' || step === 'management' || step === 'vpn') return probe.target === profile.gatewayAddress && (!probe.port || probe.port === profile.gatewayPort)
  if (step === 'relay') return probe.kind === 'relay' || probe.target === profile.gatewayAddress && probe.port === profile.relayPort
  if (step === 'tunnel') return probe.kind === 'handshake' || probe.kind === 'service' || probe.kind === 'route' && probe.target === (profile.verificationTargets[0]?.address ?? profile.containerProbeAddress)
  if (step === 'proxy') return probe.kind === 'http-proxy'
  return probe.target === profile.containerProbeAddress || profile.verificationTargets.some(target => matchesVerificationTarget(probe, target))
}

export function mergeNetworkProbes(previous: NetworkProbe[], next: NetworkProbe[]): NetworkProbe[] {
  return [...previous.filter(probe => !next.some(item => item.target === probe.target && item.port === probe.port && item.kind === probe.kind)), ...next]
}
