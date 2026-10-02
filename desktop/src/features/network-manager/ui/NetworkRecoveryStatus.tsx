import { Badge } from '@/components/ui/Badge'
import { useTranslation } from '@/i18n'
import type { NetworkProbe, NetworkProfile, NetworkSnapshot } from '../networkTypes'
import { matchesVerificationTarget } from './networkEvidence'

type Props = { profile: NetworkProfile; snapshot: NetworkSnapshot | null; probes: NetworkProbe[]; applying?: boolean; pollError?: boolean }

export function NetworkRecoveryStatus({ profile, snapshot, probes, applying = false, pollError = false }: Props) {
  const t = useTranslation()
  const tunnel = snapshot?.tunnel
  const task = tunnel?.taskStatus === 'unknown' ? undefined : tunnel?.taskRunning
  const relay = tunnel?.relayReady
  const route = snapshot?.selectedRoutes.find(item => item.target === (profile.verificationTargets[0]?.address ?? profile.containerProbeAddress))
  const handshake = probes.find(item => item.kind === 'handshake' && item.target === profile.tunnelName)
  const usable = !snapshot || !profile.containerEnabled ? undefined : profile.mode === 'home'
    ? handshake ? Boolean(tunnel?.running && relay && handshake.ok && route?.interfaceAlias === profile.tunnelName && route.source === profile.tunnelAddress) : undefined
    : route ? snapshot.interfaces.some(item => item.index === route.interfaceIndex && item.physical && item.connected) && route.nextHop === profile.gatewayAddress : undefined
  const targets = profile.verificationTargets.length ? profile.verificationTargets : [{ address: profile.containerProbeAddress, port: profile.containerProbePort, protocol: 'tcp' as const }]
  const results = targets.map(target => probes.find(probe => matchesVerificationTarget(probe, target)))
  const wrongRoute = targets.some(target => probes.some(probe => probe.kind === 'route' && probe.target === target.address && !probe.ok))
  const business = wrongRoute ? false : results.every(Boolean) ? results.every(probe => probe?.ok) : undefined
  const cards = [
    { key: 'task', value: profile.mode === 'home' && profile.containerEnabled ? task : undefined },
    { key: 'relay', value: profile.mode === 'home' && profile.containerEnabled ? relay : undefined },
    { key: 'tunnel', value: usable }, { key: 'business', value: business },
  ] as const
  const valueText = (value: boolean | undefined) => t(value === true ? 'networkManager.recovery.yes' : value === false ? 'networkManager.recovery.no' : 'networkManager.recovery.unknown')
  return <section className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4" aria-label={t('networkManager.recovery.statusTitle')} aria-live="polite">
    <h3 className="text-sm font-semibold">{t('networkManager.recovery.statusTitle')}</h3>
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map(card => <div key={card.key} data-testid={`recovery-${card.key}`} className="space-y-2 rounded-[var(--radius-md)] bg-[var(--color-surface-container)] p-3">
        <p className="text-sm">{t(`networkManager.recovery.${card.key}`)}</p>
        <Badge tone={card.value === true ? 'success' : !applying && card.value === false ? 'danger' : 'neutral'} wrap>{applying && card.key === 'relay' && card.value !== true ? t('networkManager.recovery.waiting') : valueText(card.value)}</Badge>
      </div>)}
    </div>
    {tunnel && profile.mode === 'home' && profile.containerEnabled && <p className="break-words text-xs text-[var(--color-text-secondary)]">
      {t('networkManager.recovery.udp')}: {valueText(tunnel.udpListening)} · {t('networkManager.recovery.tcp')}: {valueText(tunnel.tcpConnected)} · {t('networkManager.recovery.priority')}: {tunnel.processPriority || t('networkManager.recovery.unknown')}
    </p>}
    {applying && <p role="status" className="text-xs">{t('networkManager.recovery.polling')}</p>}
    {pollError && <p role="alert" className="text-xs text-[var(--color-error)]">{t('networkManager.recovery.pollError')}</p>}
  </section>
}
