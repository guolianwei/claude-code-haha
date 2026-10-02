import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { SelectField } from '@/components/ui/SelectField'
import { useTranslation } from '@/i18n'
import type { NetworkManagerApi, NetworkProfile, VpnRouteOptions } from '../networkTypes'

type Props = { api?: NetworkManagerApi; profile: NetworkProfile; disabled: boolean; onChange: (profile: NetworkProfile) => void }
const identity = (name: string, scope: string) => JSON.stringify([scope, name])

export function VpnProfileSelector({ api, profile, disabled, onChange }: Props) {
  const t = useTranslation()
  const [options, setOptions] = useState<VpnRouteOptions['vpns']>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!api) return
    let active = true
    setLoading(true)
    setFailed(false)
    void api.vpnRouteOptions().then(result => {
      if (!active) return
      if (result.ok) setOptions(result.data.vpns)
      else setFailed(true)
    }).catch(() => { if (active) setFailed(true) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [api, revision])
  const current = options.find(option => option.name === profile.vpnName && option.scope === profile.vpnScope)
  return <div className="space-y-3">
    <SelectField label={t('networkManager.recovery.vpnSelect')} value={current ? identity(current.name, current.scope) : ''}
      disabled={disabled || loading || failed} size="md"
      options={[{ value: '', label: t('networkManager.recovery.vpnEmpty') }, ...options.map(option => ({
        value: identity(option.name, option.scope),
        label: `${option.name} · ${option.serverAddress || t('networkManager.recovery.unknown')} · ${t(option.scope === 'allUsers' ? 'networkManager.allUsers' : 'networkManager.currentUser')} · ${t(option.connected ? 'networkManager.vpnRouteConnected' : 'networkManager.vpnRouteDisconnected')}`,
      }))]}
      onChange={value => {
        const selected = options.find(option => identity(option.name, option.scope) === value)
        if (selected) onChange({ ...profile, vpnName: selected.name, vpnScope: selected.scope, vpnServerAddress: selected.serverAddress ?? '' })
      }} />
    {failed && <p role="alert" className="text-xs text-[var(--color-error)]">{t('networkManager.recovery.vpnError')}</p>}
    {!loading && !failed && !current && <p className="text-xs text-[var(--color-text-secondary)]">{t('networkManager.recovery.vpnMissing')}</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      <Input label={t('networkManager.vpnName')} value={profile.vpnName} readOnly size="md" />
      <Input label={t('networkManager.recovery.vpnServer')} value={profile.vpnServerAddress} readOnly size="md" />
      <SelectField label={t('networkManager.recovery.splitPolicy')} value={profile.splitTunnelingPolicy} disabled={disabled} size="md"
        options={[{ value: 'preserve', label: t('networkManager.recovery.preserve') }, { value: 'enabled', label: t('networkManager.recovery.enabled') }]}
        onChange={splitTunnelingPolicy => onChange({ ...profile, splitTunnelingPolicy })} />
    </div>
    <p className="text-xs text-[var(--color-text-secondary)]">{t('networkManager.recovery.policyHint')}</p>
    <Button variant="secondary" size="sm" disabled={disabled || loading || !api} onClick={() => setRevision(value => value + 1)}>{t('networkManager.recovery.refreshVpns')}</Button>
  </div>
}
