import type { HostSshAccount } from '../../types/resourceTypes'
import type { SshAccountCredentialWrite } from '../../api/credentialMutationContract'
import { UsernameSchema } from '../../types/resourceSchemas'
import { MAX_SSH_ACCOUNTS } from '../../types/hostSshAccounts'

export type SshAccountDraft = HostSshAccount & {
  originalUsername: string | null
  originalAuthType: HostSshAccount['auth']['type']
  replaceCredential: boolean
  storage: 'vault' | 'temporary'
  password: string
  privateKeyPem: string
  passphrase: string
}

export function createSshAccountDraft(account?: HostSshAccount): SshAccountDraft {
  return {
    id: account?.id ?? crypto.randomUUID(), username: account?.username ?? '',
    auth: { ...(account?.auth ?? { type: 'password', credentialId: null }) },
    originalUsername: account?.username ?? null,
    originalAuthType: account?.auth.type ?? 'password',
    replaceCredential: false, storage: 'vault', password: '', privateKeyPem: '', passphrase: '',
  }
}

export function needsSshAccountCredential(account: SshAccountDraft): boolean {
  return account.replaceCredential || !account.auth.credentialId ||
    account.username.trim() !== account.originalUsername || account.auth.type !== account.originalAuthType
}

export function prepareSshAccountWrites(accounts: SshAccountDraft[], defaultUsername: string): {
  sshAccounts: HostSshAccount[]
  sshAccountCredentials: SshAccountCredentialWrite[]
} {
  if (accounts.length >= MAX_SSH_ACCOUNTS) throw new Error('INVALID_ARGUMENT')
  const usernames = new Set([defaultUsername.trim()])
  const sshAccounts: HostSshAccount[] = []
  const sshAccountCredentials: SshAccountCredentialWrite[] = []
  for (const account of accounts) {
    const username = account.username.trim()
    if (!UsernameSchema.safeParse(username).success) throw new Error('INVALID_ARGUMENT')
    if (usernames.has(username)) throw new Error('SSH_DUPLICATE_USERNAME')
    usernames.add(username)
    const replace = needsSshAccountCredential(account)
    if (replace) {
      if (account.auth.type === 'password' ? !account.password : !account.privateKeyPem.trim()) throw new Error('SSH_CREDENTIAL_MISSING')
      sshAccountCredentials.push({ accountId: account.id, credential: {
        storage: account.storage,
        secret: account.auth.type === 'password'
          ? { kind: 'ssh-password', password: account.password }
          : { kind: 'ssh-private-key', privateKeyPem: account.privateKeyPem.trim(), ...(account.passphrase ? { passphrase: account.passphrase } : {}) },
      } })
    }
    // Explicit metadata projection: draft secrets must never reach a Host DTO.
    sshAccounts.push({ id: account.id, username, auth: { type: account.auth.type, credentialId: replace ? null : account.auth.credentialId } })
  }
  return { sshAccounts, sshAccountCredentials }
}
