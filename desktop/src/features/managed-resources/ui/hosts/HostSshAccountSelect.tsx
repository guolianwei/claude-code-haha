import { useId } from 'react'
import { UserRound } from 'lucide-react'
import { useTranslation } from '../../../../i18n'
import { getHostSshAccounts } from '../../types/hostSshAccounts'
import type { Host } from '../../types/resourceTypes'
import { isHostSshBusy, useHostSshStore } from '../../stores/hostSshStore'

/** Shared by terminal, SFTP, transfers, and host tools: one selected SSH identity. */
export function HostSshAccountSelect({ host, compact = false }: { host: Host; compact?: boolean }) {
  const t = useTranslation()
  const id = useId()
  const entry = useHostSshStore(state => state.byHostId[host.id])
  const selectedId = useHostSshStore(state => state.selectedAccountByHostId[host.id]) ?? host.id
  const accounts = getHostSshAccounts(host)
  const busy = isHostSshBusy(entry)
  const activeId = busy ? entry?.accountId ?? host.id : selectedId
  return <div className={compact ? 'flex min-w-0 shrink items-center gap-1.5 text-[11px]' : 'mb-2 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs'} data-testid="ssh-account-picker" data-host-id={host.id}>
    <label htmlFor={id} className={compact ? 'sr-only' : 'inline-flex items-center gap-1 font-medium'}><UserRound size={14} />{t('managedResources.sshAccounts.select' as never)}</label>
    <select id={id} data-testid="ssh-account-select" data-host-id={host.id} aria-label={compact ? t('managedResources.sshAccounts.select' as never) : undefined} value={activeId} disabled={busy}
      className={compact ? 'h-7 min-w-0 max-w-36 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 font-mono text-[11px] disabled:opacity-70' : 'h-8 min-w-36 max-w-[60%] rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 font-mono disabled:opacity-70'}
      onChange={event => useHostSshStore.getState().selectAccount(host, event.target.value)}>
      {!accounts.some(account => account.id === activeId) && <option value={activeId}>{busy && entry?.username ? entry.username : t('managedResources.sshAccounts.missing' as never)}</option>}
      {accounts.map(account => <option key={account.id} value={account.id}>
        {busy && account.id === activeId ? entry?.username ?? account.username : account.username}{account.id === host.id ? ` (${t('managedResources.sshAccounts.default' as never)})` : ''}
      </option>)}
    </select>
    {busy && !compact && <span className="text-[var(--color-text-tertiary)]">{t('managedResources.sshAccounts.disconnectToSwitch' as never)}</span>}
  </div>
}
