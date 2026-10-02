import type { BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { ManagedResourcesModule } from '../../../electron/services/managedResources'
import type { CredentialRevealAuthorization } from '../../../electron/services/managedResources/windowsCredentialReauth'

type Driver = {
  clickButton(key: string, selector?: string, scope?: string): Promise<void>
  clickExpression(expression: string): Promise<void>
  waitFor(expression: string, label: string, timeout?: number): Promise<void>
  type(selector: string, value: string): Promise<void>
}

export function createTagConnectionsFixture() {
  const clipboardWrites: string[] = []
  let authorization: CredentialRevealAuthorization = { status: 'authorized' }
  let authCalls = 0
  return {
    clipboard: { writeText(value: string) { clipboardWrites.push(value) } },
    authorizer: { async authorize() { authCalls += 1; return authorization } },
    async verify(win: BrowserWindow, driver: Driver, module: ManagedResourcesModule, output: string) {
      const steps: string[] = []
      const password = 'TAG_COPY_FIXTURE|password_only'
      const accountPassword = 'TAG_COPY_FIXTURE_EXTRA_ONLY'
      const tagIds: string[] = []
      for (const name of ['ambari', '其他', '空标签']) {
        const result = await module.services.libService.createTag({ namespace: 'host', name, colorToken: 'blue' })
        assert.equal(result.status, 'created')
        if (result.status === 'rejected') throw new Error('Fixture tag creation failed')
        tagIds.push(result.value.id)
      }
      const hostIds: string[] = []
      for (const [index, name] of ['可见主机', '搜索隐藏主机', '无关主机'].entries()) {
        const accountId = randomUUID()
        const extraAccount = index === 0 ? [{ id: accountId, username: 'operator', auth: { type: 'password' as const, credentialId: null } }] : []
        const result = await module.services.libService.createHost({
          name, address: `192.0.2.${index + 1}`, port: index === 0 ? 2222 : 22,
          username: 'root', auth: { type: 'password', credentialId: null },
          tagIds: [tagIds[index === 2 ? 1 : 0]!], initialDirectory: null, applications: [], notes: '',
          credential: { storage: 'vault', secret: { kind: 'ssh-password', password } },
          sshAccounts: extraAccount,
          ...(index === 0 ? { sshAccountCredentials: [{ accountId, credential: { storage: 'vault' as const, secret: { kind: 'ssh-password' as const, password: accountPassword } } }] } : {}),
        })
        assert.equal(result.status, 'created')
        if (result.status === 'rejected') throw new Error('Fixture host creation failed')
        hostIds.push(result.value.id)
      }
      const before = await fs.readFile(module.services.store.filePath, 'utf8')
      await driver.waitFor('Boolean(window.m2Smoke)', 'tag fixture bootstrap')
      // Hidden-window compositors can freeze CSS transitions between captures.
      // Keep screenshot evidence on the final state without changing product CSS.
      await win.webContents.insertCSS('*, *::before, *::after { transition: none !important; animation: none !important; }')
      await win.webContents.executeJavaScript("window.m2Smoke.setLocale('zh')")
      await driver.clickButton('managedResources.title')
      await driver.waitFor('window.m2Smoke.snapshot().hosts.length === 3 && window.m2Smoke.snapshot().tags.length === 3', 'tag fixture hosts loaded')
      const button = (label: string) => `Array.from(document.querySelectorAll('button')).find(e => (e.getAttribute('aria-label') || e.textContent.trim()) === ${JSON.stringify(label)})`
      const copy = button('复制「ambari」下全部服务器连接信息（Markdown）')
      assert.equal(await win.webContents.executeJavaScript(`(${button('复制「空标签」下全部服务器连接信息（Markdown）')}).disabled`), true)
      assert.equal(await win.webContents.executeJavaScript(`(${copy}).closest('button button') === null`), true)
      await driver.clickExpression("Array.from(document.querySelectorAll('[role=button]')).find(e => e.textContent.includes('可见主机'))")
      await driver.type('input[type=search]', '可见')
      await driver.clickExpression(button('其他 (1)'))
      const initial = await win.webContents.executeJavaScript('window.m2Smoke.snapshot()')
      assert.equal(initial.selectedHostId, hostIds[0])
      assert.equal(initial.selectedTagId, tagIds[1])
      assert.equal(initial.searchQuery, '可见')
      assert.equal(await win.webContents.executeJavaScript("document.body.textContent.includes('搜索隐藏主机')"), false)
      steps.push('中文标签复制按钮、空标签禁用、筛选与选中主机设置')

      await driver.clickExpression(copy)
      await driver.waitFor("document.querySelector('[role=status]')?.textContent.includes('已复制 2 台主机、3 个账号')", 'full tag clipboard success')
      assert.equal(clipboardWrites.length, 1)
      assert.equal(authCalls, 1)
      const markdown = clipboardWrites[0]!
      assert.equal(markdown.split('\n').length, 5)
      assert.ok(markdown.includes('可见主机') && markdown.includes('搜索隐藏主机') && markdown.includes('operator'))
      assert.equal(markdown.includes('无关主机'), false)
      assert.ok(markdown.includes('TAG\\_COPY\\_FIXTURE\\|password\\_only'))
      assert.ok(markdown.includes('TAG\\_COPY\\_FIXTURE\\_EXTRA\\_ONLY'))
      assert.deepEqual(await win.webContents.executeJavaScript('window.m2Smoke.snapshot()'), initial)
      assert.equal(await win.webContents.executeJavaScript("document.body.textContent.includes('TAG_COPY_FIXTURE') || JSON.stringify(window.m2Smoke.snapshot()).includes('TAG_COPY_FIXTURE')"), false)
      assert.equal(await win.webContents.executeJavaScript('Boolean(document.querySelector("[role=dialog]"))'), false)
      assert.equal(await fs.readFile(module.services.store.filePath, 'utf8'), before)
      await fs.writeFile(path.join(output, 'fixture-clipboard.md'), markdown)
      await win.webContents.capturePage()
      await new Promise(resolve => setTimeout(resolve, 250))
      await fs.writeFile(path.join(output, '01-tag-copy-success-zh.png'), (await win.webContents.capturePage()).toPNG())
      steps.push('真实 renderer/preload/native IPC，按完整标签复制两台主机三个账号，密码仅在主进程模拟剪贴板')

      authorization = { status: 'cancelled' }
      await win.webContents.executeJavaScript(`(${copy}).focus()`)
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 })
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await driver.waitFor("document.querySelector('[role=alert]')?.textContent === window.m2Smoke.label('managedResources.errors.OS_AUTH_CANCELLED')", 'cancelled verification is localized')
      assert.equal(clipboardWrites.length, 1)
      assert.equal(authCalls, 2)
      assert.equal(await win.webContents.executeJavaScript(`(${copy}).disabled`), false)
      await win.webContents.capturePage()
      await new Promise(resolve => setTimeout(resolve, 250))
      await fs.writeFile(path.join(output, '02-tag-copy-cancelled-zh.png'), (await win.webContents.capturePage()).toPNG())
      steps.push('Enter 键可访问；取消系统验证不覆盖剪贴板、不报告成功且可重试')

      authorization = { status: 'authorized' }
      await driver.clickExpression(copy)
      await driver.waitFor("Boolean(document.querySelector('[role=status]')) && !document.querySelector('[role=alert]')", 'retry succeeds')
      assert.equal(clipboardWrites.length, 2)
      await driver.type('input[type=search]', '')
      await driver.clickExpression(button('ambari (2)'))
      await driver.waitFor("document.body.textContent.includes('搜索隐藏主机')", 'full tag visible after user changes filter')
      await win.webContents.capturePage()
      await new Promise(resolve => setTimeout(resolve, 250))
      await fs.writeFile(path.join(output, '03-tag-copy-list-zh.png'), (await win.webContents.capturePage()).toPNG())
      steps.push('取消后重试成功，原有标签筛选继续工作')
      await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', kind: 'isolated-native-host-tag-copy-smoke', platform: process.platform, electron: process.versions.electron, testedAt: new Date().toISOString(), steps, hostCount: 2, accountCount: 3, realServicesContacted: false, fakeVault: true, fakeOsAuthentication: true, fakeClipboard: true, rendererContainsSecrets: false }, null, 2) + '\n')
    },
  }
}
