import { Badge } from '@/components/ui/Badge'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Input } from '@/components/ui/Input'
import { useTranslation, type TranslationKey } from '@/i18n'
import type { NetworkManagerApi, NetworkPlan, NetworkProbe, NetworkProfile, NetworkSnapshot, NetworkStepId } from '../networkTypes'
import type { useSakuraDiscovery } from '../useSakuraDiscovery'
import { SakuraRuntimeFields } from './SakuraRuntimeFields'
import { NetworkExecutionReference } from './NetworkExecutionReference'
import { VpnProfileSelector } from './VpnProfileSelector'
import { NetworkStepEvidence } from './NetworkStepEvidence'

export type NetworkProfileStage = 'physical' | 'vpn' | 'proxy' | 'containers'
export type NetworkStageState = 'passed' | 'failed'

type Props = {
  profile: NetworkProfile
  effectiveProfile?: NetworkProfile
  api?: NetworkManagerApi
  sakura?: ReturnType<typeof useSakuraDiscovery>
  snapshot?: NetworkSnapshot | null
  probes?: NetworkProbe[]
  plan?: NetworkPlan | null
  disabled: boolean
  previewDisabled?: boolean
  activeStage?: NetworkProfileStage
  stageStates?: Partial<Record<NetworkProfileStage, NetworkStageState>>
  registerSection?: (stage: NetworkProfileStage, node: HTMLElement | null) => void
  onStageFocus?: (stage: NetworkProfileStage) => void
  onChange: (profile: NetworkProfile) => void
  onLogin: (target: 'vpn' | 'sakura') => void
  onPick: (field: 'proxyConfigPath' | 'sakuraExecutable' | 'relayExecutable') => void
  onValidate?: (stage: NetworkProfileStage) => void
  onPreview?: (stage: 'physical' | 'vpn' | 'containers') => void
  onValidateLink?: (step: NetworkStepId) => void
  onOpenSystemTool?: (target: 'tasks' | 'services') => void
  onNavigate?: (stage: NetworkProfileStage | 'plan' | 'verify') => void
  vpnRoutePanel?: ReactNode
}

const hintClass = 'text-xs leading-relaxed text-[var(--color-text-secondary)]'

export function NetworkProfileFields({
  profile,
  effectiveProfile = profile,
  api,
  sakura,
  snapshot,
  probes,
  plan,
  disabled,
  previewDisabled = false,
  activeStage,
  stageStates = {},
  registerSection,
  onStageFocus,
  onChange,
  onLogin,
  onPick,
  onValidate,
  onPreview,
  onValidateLink,
  onOpenSystemTool,
  onNavigate,
  vpnRoutePanel,
}: Props) {
  const t = useTranslation()

  function field(key: keyof NetworkProfile, label: TranslationKey, numeric = false) {
    return <Input key={key} label={t(label)} value={String(profile[key])} disabled={disabled} size="md"
      type={numeric ? 'number' : 'text'} min={numeric ? 1 : undefined} max={numeric ? 65535 : undefined}
      onChange={event => onChange({ ...profile, [key]: numeric ? Number(event.target.value) : event.target.value })} />
  }

  function status(stage: NetworkProfileStage) {
    const state = stageStates[stage]
    if (!state) return null
    return <Badge tone={state === 'passed' ? 'success' : 'danger'}>{t(state === 'passed' ? 'networkManager.stagePassed' : 'networkManager.stageFailed')}</Badge>
  }

  function sectionClass(stage: NetworkProfileStage) {
    return [
      'scroll-mt-3 space-y-3 rounded-[var(--radius-lg)] border bg-[var(--color-surface)] p-4 transition-colors',
      activeStage === stage
        ? 'border-[var(--color-border-focus)] bg-[var(--color-surface-container-low)]'
        : 'border-[var(--color-border)]',
    ].join(' ')
  }

  const reference = (stage: NetworkProfileStage) => api && <NetworkExecutionReference api={api} stage={stage} profile={effectiveProfile}
    extra={stage === 'proxy' && sakura?.discovery?.selected ? { source: 'process-argument', ...sakura.discovery.selected }
      : stage === 'containers' ? { serviceName: `WireGuardTunnel$${profile.tunnelName}`, interfaceIndex: 'Find-NetRoute → InterfaceIndex (runtime)', mode: profile.mode } : { mode: profile.mode }} />
  const evidence = (step: NetworkStepId) => <NetworkStepEvidence step={step} profile={profile} snapshot={snapshot} probes={probes} plan={plan} />

  return <div className="min-w-0 space-y-3">
    <section ref={node => registerSection?.('physical', node)} className={sectionClass('physical')} onFocusCapture={() => onStageFocus?.('physical')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t('networkManager.physical')}</h3>
        {status('physical')}
      </div>
      <p className={hintClass}>{t('networkManager.physicalHint')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {field('managementPrefix', 'networkManager.corporatePrefix')}
        {field('gatewayAddress', 'networkManager.gateway')}
        {field('gatewayPort', 'networkManager.gatewayPort', true)}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onValidate?.('physical')}>{t('networkManager.validatePhysical')}</Button>
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onValidateLink?.('management')}>{t('networkManager.recovery.checkHost')}</Button>
        <Button size="sm" disabled={disabled || previewDisabled} onClick={() => onPreview?.('physical')}>{t('networkManager.previewRoute')}</Button>
        {profile.mode === 'home' && <Button size="sm" variant="secondary" onClick={() => onNavigate?.('vpn')}>{t('networkManager.recovery.goVpn')}</Button>}
      </div>
      {evidence('physical')}
      {reference('physical')}
    </section>

    <section ref={node => registerSection?.('vpn', node)} className={sectionClass('vpn')} onFocusCapture={() => onStageFocus?.('vpn')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t('networkManager.vpn')}</h3>
        {status('vpn')}
      </div>
      <p className={hintClass}>{t(profile.mode === 'home' ? 'networkManager.vpnHint' : 'networkManager.workHint')}</p>
      {profile.mode === 'home' ? <>
        <VpnProfileSelector api={api} profile={profile} disabled={disabled} onChange={onChange} />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onValidate?.('vpn')}>{t('networkManager.validateVpn')}</Button>
          <Button size="sm" disabled={disabled} onClick={() => onLogin('vpn')}>{t('networkManager.loginVpn')}</Button>
          <Button size="sm" variant="secondary" onClick={() => onNavigate?.('physical')}>{t('networkManager.recovery.goHost')}</Button>
        </div>
      </> : <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onValidate?.('vpn')}>{t('networkManager.validateVpn')}</Button>
        <Button size="sm" disabled={disabled || previewDisabled} onClick={() => onPreview?.('vpn')}>{t('networkManager.previewRoute')}</Button>
      </div>}
      {evidence('vpn')}
      {reference('vpn')}
      {vpnRoutePanel}
    </section>

    <section ref={node => registerSection?.('proxy', node)} className={sectionClass('proxy')} onFocusCapture={() => onStageFocus?.('proxy')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t('networkManager.proxy')}</h3>
        {status('proxy')}
      </div>
      <p className={hintClass}>{t('networkManager.proxyHint')}</p>
      <SakuraRuntimeFields profile={profile} discovery={sakura?.discovery ?? null} detecting={sakura?.detecting ?? false}
        error={sakura?.error ?? false} disabled={disabled} onRefresh={() => sakura?.refresh()} onChange={onChange} onPick={onPick} />
      <div className="grid gap-3 sm:grid-cols-2">
        {field('proxyPort', 'networkManager.proxyEndpoint', true)}
        {field('externalProbeUrl', 'networkManager.proxyProbe')}
      </div>
      {!sakura?.discovery?.selected && <p className={hintClass}>{t('networkManager.configHint')}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onValidate?.('proxy')}>{t('networkManager.validateProxy')}</Button>
        <Button size="sm" disabled={disabled || sakura?.detecting || sakura?.discovery?.running} onClick={() => onLogin('sakura')}>{t('networkManager.startSakura')}</Button>
      </div>
      {evidence('proxy')}
      {reference('proxy')}
    </section>

    <section ref={node => registerSection?.('containers', node)} className={sectionClass('containers')} onFocusCapture={() => onStageFocus?.('containers')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t('networkManager.containers')}</h3>
        {status('containers')}
      </div>
      <p className={hintClass}>{t('networkManager.containerHint')}</p>
      <p className={hintClass}>{t('networkManager.deployedHint')}</p>
      <p className={hintClass}>{t('networkManager.recovery.deploymentHint')}</p>
      <Checkbox label={t('networkManager.containerEnabled')} checked={profile.containerEnabled} disabled={disabled}
        onChange={event => onChange({ ...profile, containerEnabled: event.target.checked })} />
      {profile.containerEnabled && <div className="grid gap-3 sm:grid-cols-2">
        {field('containerPrefix', 'networkManager.prefix')}
        {field('containerProbeAddress', 'networkManager.probeAddress')}
        {field('containerProbePort', 'networkManager.probePort', true)}
        <Input label={t('networkManager.tunnel')} hint={t('networkManager.tunnelHint')} value={profile.tunnelName} disabled={disabled} size="md" onChange={event => onChange({ ...profile, tunnelName: event.target.value })} />
        <Input label={t('networkManager.service')} hint={t('networkManager.taskHint')} value={profile.relayTaskName} disabled={disabled} size="md" onChange={event => onChange({ ...profile, relayTaskName: event.target.value })} />
        {profile.mode === 'home' && <>
          {field('relayPort', 'networkManager.relayPort', true)}
          <Input label={t('networkManager.expectedSource')} hint={t('networkManager.expectedSourceHint')} value={profile.expectedRelaySource}
            disabled={disabled} size="md" onChange={event => onChange({ ...profile, expectedRelaySource: event.target.value })} />
          {field('relayLocalPort', 'networkManager.recovery.localPort', true)}
          {field('tunnelAddress', 'networkManager.recovery.tunnelAddress')}
          <Input label={t('networkManager.recovery.relayExecutable')} value={profile.relayExecutable} disabled={disabled} size="md"
            onChange={event => onChange({ ...profile, relayExecutable: event.target.value })} />
          <Input label={t('networkManager.recovery.timeout')} hint={t('networkManager.recovery.timeoutHint')} value={profile.readinessTimeoutSeconds}
            type="number" min={10} max={120} disabled={disabled} size="md" onChange={event => onChange({ ...profile, readinessTimeoutSeconds: Number(event.target.value) })} />
        </>}
      </div>}
      {profile.containerEnabled && profile.mode === 'home' && <>
        <p className={hintClass}>{t('networkManager.recovery.relayHint')}</p>
        <p className={hintClass}>{t('networkManager.recovery.taskFix')}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onPick('relayExecutable')}>{t('networkManager.recovery.chooseRelay')}</Button>
          <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onValidateLink?.('relay')}>{t('networkManager.recovery.checkRelay')}</Button>
          <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onOpenSystemTool?.('tasks')}>{t('networkManager.recovery.openTasks')}</Button>
        </div>
        {evidence('relay')}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onValidateLink?.('tunnel')}>{t('networkManager.recovery.checkTunnel')}</Button>
          <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onOpenSystemTool?.('services')}>{t('networkManager.recovery.openServices')}</Button>
        </div>
        {evidence('tunnel')}
      </>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={disabled || !profile.containerEnabled} onClick={() => onValidate?.('containers')}>{t('networkManager.validateContainers')}</Button>
        <Button size="sm" disabled={disabled || previewDisabled || !profile.containerEnabled} onClick={() => onPreview?.('containers')}>{t('networkManager.previewContainer')}</Button>
      </div>
      {profile.containerEnabled && evidence('container')}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => onNavigate?.('plan')}>{t('networkManager.recovery.nextPlan')}</Button>
        <Button size="sm" variant="secondary" onClick={() => onNavigate?.('verify')}>{t('networkManager.recovery.nextTargets')}</Button>
      </div>
      {reference('containers')}
    </section>
  </div>
}
