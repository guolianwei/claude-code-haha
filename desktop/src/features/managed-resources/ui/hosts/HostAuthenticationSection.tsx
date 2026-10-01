import { useId, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'
import type { Host } from '../../types/resourceTypes'
import { ProtectedPasswordReveal } from '../ProtectedPasswordReveal'
import { getHostSshAccounts } from '../../types/hostSshAccounts'

/** Authentication details only: collapsing must never unmount the SSH/file workspace. */
export function HostAuthenticationSection({ host }: { host: Host }) {
  const t = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  return (
    <section data-testid="host-authentication-section" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          block
          className="justify-start"
          data-testid="host-authentication-toggle"
          aria-expanded={expanded}
          aria-controls={`${id}-body`}
          icon={expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          onClick={() => setExpanded(value => !value)}
        >
          {t('managedResources.authMethod')}
        </Button>
      </h3>
      <div id={`${id}-body`} hidden={!expanded}>
        {/* Unmount on collapse to evict revealed passwords rather than merely hiding them. */}
        {expanded && <>
          <div className="mt-3 text-xs">
            <div>
              <span className="text-[var(--color-text-tertiary)]">{t('managedResources.initialDir')}: </span>
              <span className="break-all font-mono text-[var(--color-text-primary)]">{host.initialDirectory || '/'}</span>
            </div>
          </div>
          <div className="mt-3 flex max-h-64 flex-col gap-2 overflow-y-auto">
            {getHostSshAccounts(host).map(account => <div key={`${account.id}:${account.auth.credentialId ?? ''}`} data-testid={`ssh-account-info-${account.id}`}
              className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-2 text-xs">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono font-medium">{account.username}{account.id === host.id ? ` (${t('managedResources.sshAccounts.default' as never)})` : ''}</span>
                <span className="text-[var(--color-text-tertiary)]">{account.auth.type === 'password' ? t('managedResources.authPassword') : t('managedResources.authKey')}</span>
              </div>
              {account.auth.type === 'password' && account.auth.credentialId
                ? <ProtectedPasswordReveal credentialId={account.auth.credentialId} label={t('managedResources.passwordReveal.sshLabel')} />
                : <span className="text-[var(--color-text-tertiary)]">{account.auth.credentialId ? t('managedResources.boundVaultCredential') : t('managedResources.sshAccounts.temporaryHint' as never)}</span>}
            </div>)}
          </div>
        </>}
      </div>
    </section>
  )
}
