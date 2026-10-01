import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import type { ManagedResourcesModule } from '../../../electron/services/managedResources/index'
import type { Controls } from './hostWorkspaceFixture'

/** Extends the committed isolated native smoke with real DOM/IPC/loopback SSH. */
export async function verifySshAccounts(win: BrowserWindow, controls: Controls, module: ManagedResourcesModule,
  server: { authenticatedUsernames: string[] }, password: string, output: string) {
  const { clickButton, clickExpression, waitFor, type } = controls
  const read = async () => {
    const result = await module.services.store.load()
    if (result.status !== 'ready') throw new Error('Fixture document unavailable')
    return result.document
  }
  const save = async () => {
    await clickButton('common.save', 'button[type="submit"]')
    await waitFor('!document.querySelector("[role=dialog]")', 'SSH account edit saved')
  }
  const capture = async (name: string) => {
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await fs.writeFile(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  const select = async (key: 'Home' | 'End', expected: string) => {
    await win.webContents.executeJavaScript('document.querySelector("[data-testid=ssh-account-select]").focus()')
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type, key, code: key, windowsVirtualKeyCode: key === 'Home' ? 36 : 35,
    })
    await waitFor(`document.querySelector('[data-testid=ssh-account-select]')?.value === ${JSON.stringify(expected)}`, 'account chosen with native keyboard')
  }
  await clickButton('managedResources.editHost')
  await clickButton('managedResources.sshAccounts.add')
  const accountId: string = await win.webContents.executeJavaScript('document.querySelector("[data-ssh-account]").getAttribute("data-ssh-account")')
  await type(`#ssh-account-${accountId}-username`, 'operator')
  await type(`#ssh-account-${accountId}-password`, `${password}-operator`)
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#ssh-account-${accountId}-password').type`), 'password')
  await capture('multi-account-edit')
  await save()
  const saved = await read()
  assert.equal(saved.hosts[0]!.sshAccounts?.length, 1)
  assert.equal(saved.credentials.length, 2)
  assert.notEqual(saved.hosts[0]!.auth.credentialId, saved.hosts[0]!.sshAccounts![0]!.auth.credentialId)
  assert.equal((await fs.readFile(module.services.store.filePath, 'utf8')).includes(password), false)
  await clickExpression('document.querySelector("[data-testid=host-authentication-toggle]")')
  await waitFor('document.querySelectorAll("[data-testid^=ssh-account-info-]").length === 2', 'both protected account summaries')
  await capture('multi-account-details')
  await clickExpression('document.querySelector("[data-testid=host-authentication-toggle]")')
  await select('End', accountId)
  await clickButton('managedResources.ssh.connect')
  await clickButton('managedResources.ssh.trustAndContinue')
  await waitFor('Boolean(document.querySelector("[data-status=ready]"))', 'selected operator SSH connection')
  assert.deepEqual(server.authenticatedUsernames, ['operator'])
  assert.equal(await win.webContents.executeJavaScript('document.querySelector("[data-testid=ssh-account-select]").disabled'), true)
  assert.equal(await win.webContents.executeJavaScript('document.querySelector("[data-testid=host-summary-endpoint]").textContent.startsWith("operator@")'), true)
  await capture('operator-connected')
  await clickButton('managedResources.ssh.disconnect')
  await waitFor('Boolean(document.querySelector("[data-status=closed]"))', 'operator disconnected')
  await select('Home', saved.hosts[0]!.id)
  await clickButton('managedResources.ssh.connect')
  await waitFor('Boolean(document.querySelector("[data-status=ready]"))', 'default account reconnect')
  assert.deepEqual(server.authenticatedUsernames, ['operator', 'fixture'])
  await clickButton('managedResources.ssh.disconnect')
  await waitFor('Boolean(document.querySelector("[data-status=closed]"))', 'default account disconnected')
  const logs = await fs.readFile(path.join(path.dirname(path.dirname(module.services.store.filePath)), 'diagnostics', 'ssh-connections.log'), 'utf8')
  assert.ok(logs.includes('"username":"operator"') && logs.includes('"phase":"ready"'))
  assert.equal(logs.includes(password), false)
  await fs.writeFile(path.join(output, 'ssh-connections.log'), logs)
  await clickButton('managedResources.editHost')
  await clickExpression(`document.querySelector('[data-ssh-account="${accountId}"] button[aria-label]')`)
  await save()
  assert.equal((await read()).hosts[0]!.sshAccounts?.length, 0)
  assert.equal((await read()).credentials.length, 1, 'removed identity credential is collected without deleting the default')
  await fs.writeFile(path.join(output, 'ssh-accounts.json'), JSON.stringify({ status: 'passed', accountsSaved: 2,
    authenticatedUsernames: server.authenticatedUsernames, nativeKeyboardSelection: true, disabledWhileConnected: true,
    separateVaultCredentials: true, removedCredentialCollected: true, secretsAbsentFromLogsAndMetadata: true,
    transport: 'real loopback SSH', fakeVault: true }, null, 2) + '\n')
}
