import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createResourceDocumentStore } from './resourceDocumentStore.js'
import { createResourceLibraryService } from './resourceLibraryService.js'
import { createCredentialVault, createTemporaryCredentialStore } from '../vault/credentialVault.js'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }) })
const hostInput = () => ({ name: 'fixture', address: 'fixture.invalid', port: 22, username: 'fixture', auth: { type: 'password' as const, credentialId: null }, tagIds: [], initialDirectory: null, applications: [], notes: '' })
const credential = { storage: 'vault' as const, secret: { kind: 'ssh-password' as const, password: 'M2_FIXTURE_PASSWORD_ONLY' } }
async function fixture(available = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-credential-atomic-'))
  directories.push(directory)
  const store = createResourceDocumentStore({ activeConfigDir: directory })
  const vault = createCredentialVault({ safeStorage: {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from(value, 'utf8'),
    decryptString: value => value.toString('utf8'),
  } })
  const temporaryCredentials = createTemporaryCredentialStore()
  const dependencies = { store, vault, temporaryCredentials, ownerId: 'window:fixture' }
  return { store, vault, temporaryCredentials, library: createResourceLibraryService(dependencies) }
}
async function read(f: Awaited<ReturnType<typeof fixture>>) {
  const loaded = await f.store.load()
  if (loaded.status !== 'ready') throw new Error('fixture load failed')
  return loaded.document
}

describe('M2 atomic credentials and resource references', () => {
  it('commits host and encrypted credential together without returning a secret', async () => {
    const f = await fixture()
    const result = await f.library.createHost({ ...hostInput(), credential })
    expect(result.status).toBe('created')
    const doc = await read(f)
    expect(doc.credentials).toHaveLength(1)
    expect(doc.hosts[0]!.auth.credentialId).toBe(doc.credentials[0]!.id)
    expect(JSON.stringify(result)).not.toContain(credential.secret.password)
    expect(await fs.readFile(f.store.filePath, 'utf8')).not.toContain(credential.secret.password)
  })

  it('does not create a credential when host integrity validation fails', async () => {
    const f = await fixture()
    await f.library.createHost(hostInput())
    const before = await fs.readFile(f.store.filePath)
    const result = await f.library.createHost({ ...hostInput(), tagIds: ['missing-tag'], credential })
    expect(result.status).toBe('rejected')
    expect(await fs.readFile(f.store.filePath)).toEqual(before)
  })

  it('rejects vault unavailability before persisting the host', async () => {
    const f = await fixture(false)
    const result = await f.library.createHost({ ...hostInput(), credential })
    expect(result).toMatchObject({ status: 'rejected', code: 'VAULT_UNAVAILABLE' })
    expect((await read(f)).hosts).toHaveLength(0)
    expect((await read(f)).credentials).toHaveLength(0)
  })

  it('replaces a credential atomically and only removes the unreferenced old record', async () => {
    const f = await fixture()
    await f.library.createHost({ ...hostInput(), credential })
    const first = (await read(f)).hosts[0]!
    const oldCredentialId = first.auth.credentialId
    await f.library.updateHost({ id: first.id, expectedRevision: first.revision, changes: { notes: 'updated' }, credential: { ...credential, secret: { ...credential.secret, password: 'M2_REPLACEMENT_ONLY' } } })
    const doc = await read(f)
    expect(doc.credentials).toHaveLength(1)
    expect(doc.credentials[0]!.id).not.toBe(oldCredentialId)
    expect(doc.hosts[0]!.auth.credentialId).toBe(doc.credentials[0]!.id)
    const before = await fs.readFile(f.store.filePath)
    const stale = await f.library.updateHost({ id: first.id, expectedRevision: first.revision, changes: {}, credential })
    expect(stale).toMatchObject({ status: 'rejected', code: 'REVISION_CONFLICT' })
    expect(await fs.readFile(f.store.filePath)).toEqual(before)
  })

  it('preserves a credential still referenced by another host', async () => {
    const f = await fixture()
    await f.library.createHost({ ...hostInput(), credential })
    const first = (await read(f)).hosts[0]!
    await f.library.createHost({ ...hostInput(), auth: first.auth })
    await f.library.deleteHost({ id: first.id, expectedRevision: first.revision })
    const doc = await read(f)
    expect(doc.hosts).toHaveLength(1)
    expect(doc.credentials).toHaveLength(1)
    expect(doc.hosts[0]!.auth.credentialId).toBe(doc.credentials[0]!.id)
  })

  it('binds temporary credentials to the generated host id without vault or disk secrets', async () => {
    const f = await fixture(false)
    await f.library.createHost({ ...hostInput(), credential: { ...credential, storage: 'temporary' } })
    const doc = await read(f)
    expect(doc.credentials).toHaveLength(0)
    expect(doc.hosts[0]!.auth.credentialId).toBeNull()
    expect(f.temporaryCredentials.resolveLatestForOwnerHost({ ownerId: 'window:fixture', hostId: doc.hosts[0]!.id })).toMatchObject({ status: 'resolved', payload: credential.secret })
    expect(await fs.readFile(f.store.filePath, 'utf8')).not.toContain(credential.secret.password)
  })

  it('refuses to reuse a saved password after changing the SSH username', async () => {
    const f = await fixture()
    await f.library.createHost({ ...hostInput(), credential })
    const host = (await read(f)).hosts[0]!
    const before = await fs.readFile(f.store.filePath)
    const result = await f.library.updateHost({
      id: host.id, expectedRevision: host.revision, changes: { username: 'another-user' },
    })
    expect(result).toMatchObject({ status: 'rejected', code: 'INVALID_CREDENTIAL_PAYLOAD' })
    expect(await fs.readFile(f.store.filePath)).toEqual(before)
  })

  it('evicts the old temporary password after a vault replacement commits', async () => {
    const f = await fixture()
    await f.library.createHost({ ...hostInput(), credential: { ...credential, storage: 'temporary' } })
    const host = (await read(f)).hosts[0]!
    const result = await f.library.updateHost({ id: host.id, expectedRevision: host.revision, changes: {}, credential })
    expect(result.status).toBe('updated')
    expect(f.temporaryCredentials.resolveLatestForOwnerHost({ ownerId: 'window:fixture', hostId: host.id })).toEqual({ status: 'not-found' })
  })

  it('saves independent account secrets and collects only removed account credentials', async () => {
    const f = await fixture()
    const extra = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'operator', auth: { type: 'password' as const, credentialId: null } }
    const extraWrite = { ...credential, secret: { ...credential.secret, password: 'EXTRA_FIXTURE_ONLY' } }
    const result = await f.library.createHost({ ...hostInput(), credential, sshAccounts: [extra], sshAccountCredentials: [{ accountId: extra.id, credential: extraWrite }] })
    expect(result.status).toBe('created')
    let doc = await read(f)
    const host = doc.hosts[0]!
    const savedExtra = host.sshAccounts![0]!
    expect(doc.credentials).toHaveLength(2)
    expect(savedExtra.auth.credentialId).not.toBe(host.auth.credentialId)
    expect(f.vault.decrypt(doc.credentials.find(value => value.id === savedExtra.auth.credentialId)!)).toMatchObject({ status: 'decrypted', payload: extraWrite.secret })
    expect(JSON.stringify(result)).not.toContain('EXTRA_FIXTURE_ONLY')
    expect(await fs.readFile(f.store.filePath, 'utf8')).not.toContain('EXTRA_FIXTURE_ONLY')
    const before = await fs.readFile(f.store.filePath)
    expect(await f.library.updateHost({ id: host.id, expectedRevision: host.revision, changes: { sshAccounts: [{ ...savedExtra, username: 'another' }] } })).toMatchObject({ status: 'rejected', code: 'INVALID_CREDENTIAL_PAYLOAD' })
    expect(await fs.readFile(f.store.filePath)).toEqual(before)
    expect(await f.library.updateHost({ id: host.id, expectedRevision: host.revision, changes: { sshAccounts: [] } })).toMatchObject({ status: 'updated' })
    doc = await read(f)
    expect(doc.credentials.map(record => record.id)).toEqual([host.auth.credentialId])
  })

  it('separates temporary credentials by account and window and clears removed identities', async () => {
    const f = await fixture(false)
    const extra = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'operator', auth: { type: 'password' as const, credentialId: null } }
    const primaryWrite = { ...credential, storage: 'temporary' as const }
    const extraWrite = { ...primaryWrite, secret: { ...credential.secret, password: 'EXTRA_TEMP_ONLY' } }
    await f.library.createHost({ ...hostInput(), credential: primaryWrite, sshAccounts: [extra], sshAccountCredentials: [{ accountId: extra.id, credential: extraWrite }] })
    const host = (await read(f)).hosts[0]!
    const scope = { ownerId: 'window:fixture', hostId: host.id }
    expect(f.temporaryCredentials.resolveLatestForOwnerHost(scope)).toMatchObject({ status: 'resolved', payload: primaryWrite.secret })
    expect(f.temporaryCredentials.resolveLatestForOwnerHost({ ...scope, accountId: extra.id })).toMatchObject({ status: 'resolved', payload: extraWrite.secret })
    expect(f.temporaryCredentials.resolveLatestForOwnerHost({ ...scope, ownerId: 'another-window', accountId: extra.id })).toEqual({ status: 'not-found' })
    expect(f.temporaryCredentials.resolveLatestForOwnerHost({ ...scope, accountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })).toEqual({ status: 'not-found' })
    await f.library.updateHost({ id: host.id, expectedRevision: host.revision, changes: { sshAccounts: [] } })
    expect(f.temporaryCredentials.resolveLatestForOwnerHost({ ...scope, accountId: extra.id })).toEqual({ status: 'not-found' })
    expect(f.temporaryCredentials.resolveLatestForOwnerHost(scope)).toMatchObject({ status: 'resolved', payload: primaryWrite.secret })
    expect((await read(f)).credentials).toEqual([])
  })

  it('rejects duplicate usernames and unknown credential writes without partial commits', async () => {
    const f = await fixture()
    await f.library.createHost({ ...hostInput(), credential })
    const host = (await read(f)).hosts[0]!
    const before = await fs.readFile(f.store.filePath)
    const account = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: host.username, auth: { type: 'password' as const, credentialId: null } }
    const duplicate = await f.library.updateHost({ id: host.id, expectedRevision: host.revision, changes: { sshAccounts: [account] }, sshAccountCredentials: [{ accountId: account.id, credential }] })
    expect(duplicate.status).toBe('rejected')
    const unknown = await f.library.updateHost({ id: host.id, expectedRevision: host.revision, changes: {}, sshAccountCredentials: [{ accountId: account.id, credential }] })
    expect(unknown).toMatchObject({ status: 'rejected', code: 'INVALID_CREDENTIAL_PAYLOAD' })
    expect(await fs.readFile(f.store.filePath)).toEqual(before)
  })

  it('upgrades a pre-account v2 document without changing the old login or unknown metadata', async () => {
    const f = await fixture()
    await f.library.createHost({ ...hostInput(), credential })
    const old = JSON.parse(await fs.readFile(f.store.filePath, 'utf8'))
    delete old.hosts[0].sshAccounts
    old.hosts[0].futureHostMetadata = { preserve: true }
    old.hosts[0].auth.futureAuthMetadata = 'keep'
    await fs.writeFile(f.store.filePath, JSON.stringify(old))
    const upgraded = await read(f)
    expect(upgraded.hosts[0]).toMatchObject({ ...old.hosts[0], sshAccounts: [] })
    const host = upgraded.hosts[0]!
    await f.library.updateHost({ id: host.id, expectedRevision: host.revision, changes: { notes: 'upgrade fixture' } })
    // A fresh parse proves the additive shape persists; never rewrite the user's home.
    expect(JSON.parse(await fs.readFile(f.store.filePath, 'utf8')).hosts[0]).toMatchObject({ sshAccounts: [], username: old.hosts[0].username, auth: old.hosts[0].auth, futureHostMetadata: { preserve: true } })
  })

  it('commits application passwords with references and removes them with the application', async () => {
    const f = await fixture()
    await f.library.createHost(hostInput())
    const host = (await read(f)).hosts[0]!
    const result = await f.library.createApplication({ hostId: host.id, expectedHostRevision: host.revision, application: {
      name: 'fixture app', version: null, installPaths: [], accessUrls: [], loginUrl: null, accessDescription: '', notes: '',
      accounts: [{ label: 'fixture account', username: 'fixture', credentialId: null, password: 'M2_ACCOUNT_PASSWORD_ONLY' }],
    } })
    expect(result.status).toBe('created')
    const doc = await read(f)
    expect(doc.credentials).toHaveLength(1)
    const savedHost = doc.hosts[0]!
    expect(savedHost.applications[0]!.accounts[0]!.credentialId).toBe(doc.credentials[0]!.id)
    expect(JSON.stringify(result)).not.toContain('M2_ACCOUNT_PASSWORD_ONLY')
    await f.library.deleteApplication({ hostId: host.id, expectedHostRevision: savedHost.revision, applicationId: savedHost.applications[0]!.id })
    expect((await read(f)).credentials).toHaveLength(0)
  })
})
