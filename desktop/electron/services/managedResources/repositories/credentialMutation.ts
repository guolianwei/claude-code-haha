import type { CredentialKind, ResourceDocument, Host } from '../../../../src/features/managed-resources/types/resourceTypes.js'
import { CredentialRecordSchema } from '../../../../src/features/managed-resources/types/resourceSchemas.js'
import type { HostCredentialWrite, SshAccountCredentialWrite } from '../../../../src/features/managed-resources/api/credentialMutationContract.js'
import type { CredentialVault, TemporaryCredentialStore } from '../vault/credentialVault.js'
import { findResourceReferences } from './resourceDocumentIntegrity.js'
import { getHostSshAccounts } from '../../../../src/features/managed-resources/types/hostSshAccounts.js'

export class CredentialMutationError extends Error {
  constructor(readonly code: 'VAULT_UNAVAILABLE' | 'INVALID_CREDENTIAL_PAYLOAD' | 'INVALID_TEMPORARY_CREDENTIAL') {
    super(code)
  }
}

export type CredentialMutationDependencies = {
  vault?: CredentialVault
  temporaryCredentials?: TemporaryCredentialStore
  ownerId?: string
}

export function createBoundCredential(
  draft: ResourceDocument,
  vault: CredentialVault | undefined,
  kind: CredentialKind,
  secret: unknown,
  label: string,
): string {
  if (!vault) throw new CredentialMutationError('VAULT_UNAVAILABLE')
  const timestamp = new Date().toISOString()
  const metadata = {
    id: crypto.randomUUID(), revision: 1, createdAt: timestamp, updatedAt: timestamp,
    kind, label: label.slice(0, 120), backend: 'electron-safe-storage-v1' as const,
  }
  const encrypted = vault.encrypt(metadata, secret)
  if (encrypted.status !== 'encrypted') throw new CredentialMutationError(encrypted.code)
  const parsed = CredentialRecordSchema.safeParse({ ...metadata, ciphertextBase64: encrypted.ciphertextBase64 })
  if (!parsed.success) throw new CredentialMutationError('INVALID_CREDENTIAL_PAYLOAD')
  draft.credentials.push(parsed.data)
  return parsed.data.id
}

export function applyHostCredential(
  draft: ResourceDocument,
  host: Host,
  write: HostCredentialWrite | undefined,
  dependencies: CredentialMutationDependencies,
  afterCommit: Array<() => void>,
  accountId = host.id,
): Host {
  if (!write) return host
  const kind = host.auth.type === 'password' ? 'ssh-password' : 'ssh-private-key'
  if (write.secret.kind !== kind) throw new CredentialMutationError('INVALID_CREDENTIAL_PAYLOAD')
  if (write.storage === 'vault') {
    const credentialId = createBoundCredential(draft, dependencies.vault, kind, write.secret, `${host.name} (${host.username})`)
    afterCommit.push(() => dependencies.temporaryCredentials?.clearAccount({ hostId: host.id, accountId }))
    return { ...host, auth: { ...host.auth, credentialId } }
  }
  const prepared = dependencies.temporaryCredentials?.prepare({
    ownerId: dependencies.ownerId ?? '', hostId: host.id, accountId, payload: write.secret,
  })
  if (!prepared || prepared.status !== 'prepared') throw new CredentialMutationError('INVALID_TEMPORARY_CREDENTIAL')
  // Unpublished secrets are discarded on validation/write failure.
  afterCommit.push(() => {
    dependencies.temporaryCredentials?.clearAccount({ hostId: host.id, accountId })
    prepared.publish()
  })
  return { ...host, auth: { ...host.auth, credentialId: null } }
}

/** Apply all account writes in the same transaction; secrets never enter Host DTOs. */
export function applyHostCredentials(
  draft: ResourceDocument,
  host: Host,
  write: HostCredentialWrite | undefined,
  accountWrites: SshAccountCredentialWrite[] | undefined,
  dependencies: CredentialMutationDependencies,
  afterCommit: Array<() => void>,
  previous?: Host,
): Host {
  const previousAccounts = new Map(previous ? getHostSshAccounts(previous).map(account => [account.id, account]) : [])
  const writes = new Map<string, HostCredentialWrite>()
  for (const item of accountWrites ?? []) {
    if (writes.has(item.accountId) || !(host.sshAccounts ?? []).some(account => account.id === item.accountId)) {
      throw new CredentialMutationError('INVALID_CREDENTIAL_PAYLOAD')
    }
    writes.set(item.accountId, item.credential)
  }
  const accounts = getHostSshAccounts(host).map(account => {
    const old = previousAccounts.get(account.id)
    const replacement = account.id === host.id ? write : writes.get(account.id)
    if (old && (old.username !== account.username || old.auth.type !== account.auth.type) && !replacement) {
      throw new CredentialMutationError('INVALID_CREDENTIAL_PAYLOAD')
    }
    const auth = applyHostCredential(draft, {
      ...host, username: account.username, auth: { ...old?.auth, ...account.auth },
    }, replacement, dependencies, afterCommit, account.id).auth
    return { ...old, ...account, auth }
  })
  for (const old of previousAccounts.values()) {
    if (!accounts.some(account => account.id === old.id)) {
      afterCommit.push(() => dependencies.temporaryCredentials?.clearAccount({ hostId: host.id, accountId: old.id }))
    }
  }
  return { ...host, auth: accounts[0]!.auth, sshAccounts: accounts.slice(1) }
}

export function resourceCredentialIds(document: ResourceDocument): Set<string> {
  const ids = new Set<string>()
  for (const host of document.hosts) {
    for (const account of getHostSshAccounts(host)) {
      if (account.auth.credentialId) ids.add(account.auth.credentialId)
    }
    for (const app of host.applications) for (const account of app.accounts) {
      if (account.credentialId) ids.add(account.credentialId)
    }
  }
  for (const connection of document.dataConnections) {
    if (connection.credentialId) ids.add(connection.credentialId)
    if (connection.tls.clientKeyCredentialId) ids.add(connection.tls.clientKeyCredentialId)
  }
  return ids
}

/** Backward-compatible name for existing host mutations; now intentionally scans every resource. */
export const hostCredentialIds = resourceCredentialIds

export function removeNewlyUnreferencedCredentials(draft: ResourceDocument, before: Set<string>): void {
  // Never sweep unrelated orphans, or credentials still shared by a resource.
  const after = resourceCredentialIds(draft)
  const removed = [...before].filter(id => !after.has(id))
  const removable = new Set(removed.filter(id => findResourceReferences(draft, { resourceType: 'credential', id }).length === 0))
  draft.credentials = draft.credentials.filter(record => !removable.has(record.id))
}
