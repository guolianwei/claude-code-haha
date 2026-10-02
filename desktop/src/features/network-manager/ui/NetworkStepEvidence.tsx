import { useTranslation, type TranslationKey } from '@/i18n'
import type { NetworkPlan, NetworkProbe, NetworkProfile, NetworkSnapshot, NetworkStepId } from '../networkTypes'
import { networkIssueKey } from './networkMessages'
import { probeBelongsToStep } from './networkEvidence'

type Props = { step: NetworkStepId; profile: NetworkProfile; snapshot?: NetworkSnapshot | null; probes?: NetworkProbe[]; plan?: NetworkPlan | null }
const hints: Record<NetworkStepId, TranslationKey> = {
  physical: 'networkManager.recovery.hostFix', management: 'networkManager.recovery.hostFix', vpn: 'networkManager.recovery.vpnFix',
  proxy: 'networkManager.recovery.proxyFix', relay: 'networkManager.recovery.relayFix', tunnel: 'networkManager.recovery.tunnelFix', container: 'networkManager.recovery.businessFix',
}
const issuePatterns: Record<NetworkStepId, RegExp> = {
  physical: /PHYSICAL|INTERFACE|HOST_PATH|MANAGEMENT|GATEWAY|^addresses|^adapters|^routes/i, management: /HOST_PATH|MANAGEMENT|GATEWAY/i,
  vpn: /VPN|SPLIT/i, proxy: /PROXY|SAKURA/i, relay: /RELAY|SOURCE_ACL|TASK/i,
  tunnel: /TUNNEL|WIREGUARD|HANDSHAKE|CONTAINER_ROUTE/i, container: /TARGET|BUSINESS|CONTAINER/i,
}
export function NetworkStepEvidence({ step, profile, snapshot, probes = [], plan }: Props) {
  const t = useTranslation()
  const routeTargets = ['physical', 'management', 'vpn', 'relay'].includes(step) ? [profile.gatewayAddress]
    : ['tunnel', 'container'].includes(step) ? [profile.containerProbeAddress, ...profile.verificationTargets.map(target => target.address)] : []
  const issues = [...(snapshot?.issues ?? []), ...(step === 'relay' ? snapshot?.tunnel.readinessIssues ?? [] : [])]
    .filter(issue => issuePatterns[step].test(issue) || routeTargets.some(target => issue.startsWith(`selected/${target}`)))
  const plans = plan?.steps.filter(item => item.id === step) ?? []
  const routes = snapshot?.selectedRoutes.filter(route => step === 'physical' || step === 'management' || step === 'vpn' || step === 'relay'
    ? route.target === profile.gatewayAddress : step === 'tunnel' || step === 'container' ? route.target === profile.containerProbeAddress || profile.verificationTargets.some(target => target.address === route.target) : false) ?? []
  const relevant = probes.filter(probe => probeBelongsToStep(probe, step, profile))
  return <div className="space-y-2 rounded-[var(--radius-md)] bg-[var(--color-surface-container-low)] p-3 text-xs">
    <h4 className="font-semibold">{t('networkManager.recovery.findings')}</h4>
    {!snapshot && !plans.length && !relevant.length && <p>{t('networkManager.recovery.unchecked')}</p>}
    {routes.map((route, index) => <p key={index} className="break-words">{route.target} → {route.interfaceAlias} · {route.source} · {route.prefix}</p>)}
    {plans.map((item, index) => <p key={index} className="break-words">{t(`networkManager.steps.${item.code}` as TranslationKey)}{item.details.length ? ` · ${item.details.join(' · ')}` : ''}</p>)}
    {[...new Set(issues)].map(issue => {
      const key = networkIssueKey(issue)
      return <p key={issue} className="break-words text-[var(--color-error)]">{key && key !== hints[step] ? `${t(key)} · ` : ''}{issue}</p>
    })}
    {relevant.map((probe, index) => <p key={index} className={`break-words ${probe.ok ? '' : 'text-[var(--color-error)]'}`}>{probe.target}{probe.port && !/^https?:\/\//.test(probe.target) ? `:${probe.port}` : ''} · {t(probe.ok ? 'networkManager.recovery.yes' : 'networkManager.recovery.no')} · {networkIssueKey(probe.detail) ? t(networkIssueKey(probe.detail)!) : probe.detail}</p>)}
    <p className="leading-relaxed text-[var(--color-text-secondary)]">{t(hints[step])}</p>
  </div>
}
