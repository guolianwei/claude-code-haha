import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { SelectField } from '@/components/ui/SelectField'
import { useTranslation } from '@/i18n'
import type { NetworkProfile, NetworkVerificationTarget } from '../networkTypes'
import { isAddressInPrefix } from '../networkSchemas'

type Props = { profile: NetworkProfile; disabled: boolean; onChange: (profile: NetworkProfile) => void; onVerify: () => void }

export function VerificationTargets({ profile, disabled, onChange, onVerify }: Props) {
  const t = useTranslation()
  const validPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535
  function addressError(address: string) {
    if (!isAddressInPrefix(address, '0.0.0.0/0')) return t('networkManager.recovery.invalidTarget')
    if (profile.containerEnabled && !isAddressInPrefix(address, profile.containerPrefix)) return t('networkManager.recovery.outsidePrefix')
    return undefined
  }
  function update(id: string, changes: Partial<NetworkVerificationTarget>) {
    onChange({ ...profile, verificationTargets: profile.verificationTargets.map(target => target.id === id ? { ...target, ...changes } : target) })
  }
  return <div className="space-y-3">
    <h4 className="text-sm font-semibold">{t('networkManager.recovery.targetsTitle')}</h4>
    <p className="text-xs text-[var(--color-text-secondary)]">{t('networkManager.recovery.targetsHint')}</p>
    {!profile.containerEnabled && <p className="text-xs text-[var(--color-text-secondary)]">{t('networkManager.recovery.directOnly')}</p>}
    {profile.verificationTargets.map((target, index) => <fieldset key={target.id} className="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
      <legend className="px-1 text-xs">{index + 1} · {target.label || target.address}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label={t('networkManager.recovery.targetLabel')} value={target.label} disabled={disabled} size="md" onChange={event => update(target.id, { label: event.target.value })} />
        <Input label={t('networkManager.recovery.targetAddress')} value={target.address} error={addressError(target.address)} disabled={disabled} size="md" onChange={event => update(target.id, { address: event.target.value })} />
        <Input label={t('networkManager.recovery.targetPort')} value={target.port} error={validPort(target.port) ? undefined : t('networkManager.recovery.invalidPort')} type="number" min={1} max={65535} disabled={disabled} size="md" onChange={event => update(target.id, { port: Number(event.target.value) })} />
        <SelectField label={t('networkManager.recovery.targetProtocol')} value={target.protocol} disabled={disabled} size="md"
          options={[{ value: 'tcp', label: 'TCP' }, { value: 'http', label: 'HTTP' }, { value: 'https', label: 'HTTPS' }]}
          onChange={protocol => update(target.id, { protocol })} />
      </div>
      <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onChange({ ...profile, verificationTargets: profile.verificationTargets.filter(item => item.id !== target.id) })}>{t('networkManager.recovery.removeTarget')}</Button>
    </fieldset>)}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" disabled={disabled || profile.verificationTargets.length >= 32}
        onClick={() => onChange({ ...profile, verificationTargets: [...profile.verificationTargets, { id: crypto.randomUUID(), label: '', address: '', port: 80, protocol: 'http' }] })}>{t('networkManager.recovery.addTarget')}</Button>
      <Button size="sm" disabled={disabled || !profile.verificationTargets.length || profile.verificationTargets.some(target => addressError(target.address) || !validPort(target.port))} onClick={onVerify}>{t('networkManager.recovery.verifyTargets')}</Button>
    </div>
  </div>
}
