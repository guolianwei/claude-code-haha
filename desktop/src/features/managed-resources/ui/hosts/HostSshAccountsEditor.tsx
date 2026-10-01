import { Plus, Trash2, KeyRound } from 'lucide-react'
import { Button } from '../../../../components/ui/Button'
import { Input } from '../../../../components/ui/Input'
import { TextArea } from '../../../../components/ui/TextArea'
import { useTranslation } from '../../../../i18n'
import { MAX_SSH_ACCOUNTS } from '../../types/hostSshAccounts'
import { createSshAccountDraft, needsSshAccountCredential, type SshAccountDraft } from './sshAccountDrafts'

export function HostSshAccountsEditor({ accounts, onChange }: {
  accounts: SshAccountDraft[]
  onChange: (accounts: SshAccountDraft[]) => void
}) {
  const t = useTranslation()
  const label = (key: string) => t(`managedResources.sshAccounts.${key}` as never)
  const update = (id: string, changes: Partial<SshAccountDraft>) => onChange(accounts.map(account => account.id === id ? { ...account, ...changes } : account))
  return <section className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3" data-testid="ssh-accounts-editor">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">{label('title')} ({accounts.length + 1}/{MAX_SSH_ACCOUNTS})</h3>
      <Button type="button" variant="secondary" size="xs" icon={<Plus size={13} />} disabled={accounts.length >= MAX_SSH_ACCOUNTS - 1}
        onClick={() => onChange([...accounts, createSshAccountDraft()])}>{label('add')}</Button>
    </div>
    <p className="text-xs text-[var(--color-text-tertiary)]">{label('help')}</p>
    {accounts.map(account => {
      const prefix = `ssh-account-${account.id}`
      const needsCredential = needsSshAccountCredential(account)
      const identityChanged = account.originalUsername !== null && (account.originalUsername !== account.username.trim() || account.originalAuthType !== account.auth.type)
      return <div key={account.id} data-ssh-account={account.id} className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container)] p-3">
        <div className="flex items-end gap-2">
          <Input id={`${prefix}-username`} label={t('managedResources.username')} value={account.username} required size="sm" className="font-mono"
            onChange={event => update(account.id, { username: event.target.value })} />
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
            {t('managedResources.authMethod')}
            <select className="h-8 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2" value={account.auth.type}
              onChange={event => update(account.id, { auth: { ...account.auth, type: event.target.value as 'password' | 'privateKey' }, password: '', privateKeyPem: '', passphrase: '' })}>
              <option value="password">{t('managedResources.authPassword')}</option>
              <option value="privateKey">{t('managedResources.authKey')}</option>
            </select>
          </label>
          <Button type="button" size="xs" variant="danger-outline" aria-label={`${label('remove')}: ${account.username}`} icon={<Trash2 size={13} />}
            onClick={() => onChange(accounts.filter(candidate => candidate.id !== account.id))}>{label('remove')}</Button>
        </div>
        {!needsCredential ? <div className="flex items-center justify-between gap-2 text-xs text-[var(--color-text-secondary)]">
          <span className="flex items-center gap-1"><KeyRound size={13} />{t('managedResources.boundVaultCredential')}</span>
          <Button type="button" size="xs" variant="secondary" onClick={() => update(account.id, { replaceCredential: true })}>{t('managedResources.changeCredential')}</Button>
        </div> : <>
          {identityChanged && <p className="text-xs text-[var(--color-brand)]">{label('identityChanged')}</p>}
          {account.auth.type === 'password'
            ? <Input id={`${prefix}-password`} label={t('managedResources.sshPasswordRequired')} type="password" autoComplete="new-password" required size="sm"
              value={account.password} onChange={event => update(account.id, { password: event.target.value })} />
            : <>
              <TextArea id={`${prefix}-key`} label={t('managedResources.sshPrivateKeyRequired')} rows={3} required value={account.privateKeyPem}
                onChange={event => update(account.id, { privateKeyPem: event.target.value })} />
              <Input id={`${prefix}-passphrase`} label={t('managedResources.keyPassphrase')} type="password" size="sm" value={account.passphrase}
                onChange={event => update(account.id, { passphrase: event.target.value })} />
            </>}
          <label className="flex items-center justify-between gap-2 text-xs">
            {t('managedResources.storageStrategy')}
            <select className="h-8 max-w-[65%] rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2" value={account.storage}
              onChange={event => update(account.id, { storage: event.target.value as 'vault' | 'temporary' })}>
              <option value="vault">{t('managedResources.vaultStorage')}</option>
              <option value="temporary">{t('managedResources.sessionOnlyStorage')}</option>
            </select>
          </label>
          {account.auth.credentialId && !identityChanged && <Button type="button" variant="secondary" size="xs"
            onClick={() => update(account.id, { replaceCredential: false, password: '', privateKeyPem: '', passphrase: '' })}>{t('managedResources.keepExistingCredential')}</Button>}
        </>}
      </div>
    })}
  </section>
}
