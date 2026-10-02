import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WINDOWS_APP_USER_MODEL_ID } from './appIdentity'
import { applyWindowsTaskbarIcon, resolveWindowsWindowIconPath } from './windowIcon'

const desktopRoot = path.resolve(__dirname, '..', '..')

describe('Windows window and taskbar icon', () => {
  it('resolves the existing branded ICO for development without relying on electron.exe branding', () => {
    const iconPath = resolveWindowsWindowIconPath(desktopRoot, 'win32')!
    expect(iconPath).toBe(path.join(desktopRoot, 'src-tauri', 'icons', 'icon.ico'))
    expect(existsSync(iconPath)).toBe(true)
    const icon = readFileSync(iconPath)
    expect(icon.readUInt16LE(0)).toBe(0)
    expect(icon.readUInt16LE(2)).toBe(1)
    const sizes = Array.from({ length: icon.readUInt16LE(4) }, (_, index) => icon[6 + index * 16] || 256)
    expect(sizes).toContain(32)
    expect(sizes).toContain(256)
  })

  it('uses a real unpacked ICO in packaged installs including paths with spaces', () => {
    const appRoot = path.join('C:', 'Program Files', 'Claude Code Haha', 'resources', 'app.asar')
    expect(resolveWindowsWindowIconPath(appRoot, 'win32'))
      .toBe(path.join('C:', 'Program Files', 'Claude Code Haha', 'resources', 'app.asar.unpacked', 'src-tauri', 'icons', 'icon.ico'))
    const pkg = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'))
    expect(pkg.build.asarUnpack).toContain('src-tauri/icons/icon.ico')
    expect(pkg.build.files).toContain('src-tauri/icons/**')
    expect(pkg.build.win.icon).toBe('src-tauri/icons/icon.ico')
  })

  it('sets an explicit taskbar icon with the same AppUserModelID as the packaged application', () => {
    const iconPath = resolveWindowsWindowIconPath(desktopRoot, 'win32')
    const setAppDetails = vi.fn()
    applyWindowsTaskbarIcon({ setAppDetails }, iconPath, 'win32')
    expect(setAppDetails).toHaveBeenCalledTimes(1)
    expect(setAppDetails).toHaveBeenCalledWith({
      appId: WINDOWS_APP_USER_MODEL_ID, appIconPath: iconPath, appIconIndex: 0,
    })
  })

  it('does not change macOS or Linux window identity', () => {
    const setAppDetails = vi.fn()
    for (const platform of ['darwin', 'linux'] as const) {
      expect(resolveWindowsWindowIconPath(desktopRoot, platform)).toBeUndefined()
      applyWindowsTaskbarIcon({ setAppDetails }, 'unused.ico', platform)
    }
    expect(setAppDetails).not.toHaveBeenCalled()
  })

  it('wires both taskbar-visible window constructors to the icon and taskbar identity', () => {
    const source = readFileSync(path.join(desktopRoot, 'electron', 'main.ts'), 'utf8')
    for (const name of ['traceWindow', 'mainWindow']) {
      const start = source.indexOf(`${name} = new BrowserWindow({`)
      expect(start).toBeGreaterThan(0)
      const options = source.slice(start, source.indexOf('\n  })', start))
      expect(options).toContain('icon: iconPath')
      expect(source).toContain(`applyWindowsTaskbarIcon(${name}, iconPath)`)
    }
  })
})
