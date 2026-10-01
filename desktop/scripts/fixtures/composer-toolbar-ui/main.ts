import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
const sandbox = process.env.TOOLBAR_UI_SANDBOX!
const output = process.env.TOOLBAR_UI_OUTPUT!
if (!sandbox || !output) throw new Error('Missing isolated fixture directories')
app.setPath('userData', path.join(sandbox, 'electron-profile'))
app.setName('cc-haha-composer-toolbar-fixture')
let win: BrowserWindow | undefined
let stage = 'bootstrap'
const evidence: unknown[] = []
const deadline = setTimeout(() => app.exit(2), 100_000)
const query = (id: string) => `document.querySelector('[data-testid="${id}"]')`
async function wait(expression: string) {
  const end = Date.now() + 10_000
  while (Date.now() < end) {
    if (await win!.webContents.executeJavaScript(expression)) return
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error('UI wait failed: ' + expression)
}
async function click(expression: string) {
  await wait(`Boolean(${expression})`)
  await win!.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const point = await win!.webContents.executeJavaScript(`(() => { const e=${expression}; const r=e.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; const hit=document.elementFromPoint(x,y); if (!r.width || !r.height || !e.contains(hit) || e.disabled) throw Error('Target is not interactable: '+JSON.stringify({target:e.outerHTML.slice(0,500),hit:hit?.outerHTML.slice(0,300),x,y,viewport:[innerWidth,innerHeight]})); return {x,y} })()`)
  const driver = win!.webContents.debugger
  await driver.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await driver.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}
async function key(key: string, code: string, vk: number) {
  for (const type of ['keyDown', 'keyUp']) await win!.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk })
}
async function shot(name: string) { await fs.writeFile(path.join(output, name + '.png'), (await win!.webContents.capturePage()).toPNG()) }
void app.whenReady().then(async () => {
  try {
    await fs.mkdir(output, { recursive: true })
    win = new BrowserWindow({ width: 1180, height: 800, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.session.webRequest.onBeforeRequest((request, callback) => callback({ cancel: !['file:', 'data:', 'blob:'].includes(new URL(request.url).protocol) }))
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error('renderer:', message.slice(0, 1500)) })
    await win.loadFile(path.join(sandbox, 'ui', 'index.html'))
    win.webContents.debugger.attach('1.3')
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
    for (const view of ['chat', 'empty']) for (const width of [900, 640, 530, 400, 320]) {
      stage = `${view}-${width}`
      await wait('Boolean(window.toolbarSmoke)')
      await win.webContents.executeJavaScript(`window.toolbarSmoke.configure(${JSON.stringify({ view, width, theme: 'light' })})`)
      await wait(`${query('fixture-column')}?.dataset.width === '${width}' && ${query('fixture-column')}?.dataset.view === '${view}' && Boolean(${query('model-selector-trigger')})`)
      await new Promise(resolve => setTimeout(resolve, 250))
      await wait(`Boolean(${query('context-entry-menu')})`)
      stage = `${view}-${width}-measure`
      const measure = await win.webContents.executeJavaScript(`(() => {
        const ids=['fixture-column','model-selector-shell','model-selector-trigger','context-entry-menu'];
        const rects=Object.fromEntries(ids.map(id=>{ const e=document.querySelector('[data-testid="'+id+'"]'); const r=e.getBoundingClientRect(); return [id,{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}] }));
        const label=document.querySelector('[data-testid="model-selector-trigger"] span');
        return {rects,labelWidth:label?.getBoundingClientRect().width,label:label?.textContent};
      })()`)
      const col = measure.rects['fixture-column'], model = measure.rects['model-selector-trigger'], resource = measure.rects['context-entry-menu']
      assert.ok(resource.width >= 60, 'Resource button must have production styling')
      assert.ok(model.width >= 60 && measure.labelWidth >= 28, JSON.stringify(measure))
      for (const r of [model, resource]) assert.ok(r.x >= col.x - 1 && r.right <= col.right + 1, JSON.stringify(measure))
      assert.ok(resource.right <= model.x + 1 || resource.bottom <= model.y + 1, 'Resource overlaps model')
      stage = `${view}-${width}-model-menu`
      await click(query('model-selector-trigger'))
      await wait(`Boolean(${query('model-selector-dropdown')})`)
      const modelBox = await win.webContents.executeJavaScript(`(() => { const r=${query('model-selector-dropdown')}.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom} })()`)
      assert.ok(modelBox.left >= 0 && modelBox.right <= 1180 && modelBox.top >= 0 && modelBox.bottom <= 800, JSON.stringify(modelBox))
      await key('Escape', 'Escape', 27)
      await wait(`!${query('model-selector-dropdown')}`)
      stage = `${view}-${width}-resource-menu`
      await click(query('context-entry-menu'))
      await wait(`document.querySelector('[role="menu"] [data-testid="context-entry-host"]') !== null`)
      await click(query('context-entry-host'))
      await wait(`Boolean(${query('context-option-resource-fixture-host')})`)
      const state = await win.webContents.executeJavaScript(`(() => { const e=${query('context-picker')}; const r=e.closest('[role="dialog"]').getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom} })()`)
      assert.ok(state.left >= 0 && state.right <= 1180 && state.top >= 0 && state.bottom <= 800, JSON.stringify(state))
      await key('Escape', 'Escape', 27)
      await wait(`!${query('context-picker')}`)
      await shot(stage)
      evidence.push({ stage, ...measure, picker: state, modelMenu: modelBox })
    }
    stage = 'selected-resource-and-model-switch'
    await win.webContents.executeJavaScript("window.toolbarSmoke.configure({view:'chat',width:900,theme:'light'})")
    await wait(`${query('fixture-column')}.dataset.view === 'chat'`)
    await click(query('context-entry-menu')); await click(query('context-entry-host'))
    await click(query('context-option-resource-fixture-host'))
    await wait(`${query('context-entry-total')}?.textContent === '1'`)
    await key('Escape', 'Escape', 27)
    await click(query('model-selector-trigger'))
    await click("Array.from(document.querySelectorAll('[data-testid=model-selector-dropdown] button')).find(b => b.textContent.includes('Model-Beta'))")
    await wait(`${query('model-selector-trigger')}.textContent.includes('Model-Beta')`)
    const snapshot = await win.webContents.executeJavaScript('window.toolbarSmoke.snapshot()')
    assert.deepEqual(snapshot.selection.resolved.host, ['fixture-host'])
    assert.equal(snapshot.selection.includePasswords, false)
    assert.equal(snapshot.requests.some((s: string) => !s.startsWith('GET ')), false)
    await click(query('context-entry-menu')); await shot('selected-resources-zh')
    await key('Escape', 'Escape', 27)
    await win.webContents.executeJavaScript("window.toolbarSmoke.configure({view:'chat',width:900,theme:'dark'})")
    await new Promise(resolve => setTimeout(resolve, 200)); await shot('chat-dark-zh')
    evidence.push({ stage, preservedSelection: true, modelChanged: true, networkRequests: false })
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', scenarios: evidence, realComponents: true, liveModel: false }, null, 2))
    console.log('PASS composer toolbar fixture: ' + evidence.length + ' scenarios')
    clearTimeout(deadline); win.destroy(); app.exit(0)
  } catch (error) {
    if (win && !win.isDestroyed()) console.error('DOM:', await win.webContents.executeJavaScript("({ids:Array.from(document.querySelectorAll('[data-testid]')).map(e => e.getAttribute('data-testid')).slice(-35), state:window.toolbarSmoke?.snapshot()})").catch(() => []))
    await shot('failure').catch(() => {})
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'failed', stage, error: String(error), evidence }, null, 2))
    console.error(stage, error); clearTimeout(deadline); win?.destroy(); app.exit(1)
  }
})
