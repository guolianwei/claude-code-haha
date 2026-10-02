import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { WINDOWS_APP_USER_MODEL_ID } from './appIdentity'

/** Windows icon APIs need a real ICO file, outside the virtual ASAR filesystem. */
export function resolveWindowsWindowIconPath(
  desktopRoot: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32') return undefined
  const nativeRoot = desktopRoot.replace(/\.asar$/i, '.asar.unpacked')
  return path.join(nativeRoot, 'src-tauri', 'icons', 'icon.ico')
}

export function applyWindowsTaskbarIcon(
  window: Pick<BrowserWindow, 'setAppDetails'>,
  iconPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32' || !iconPath) return
  // An explicit window identity also tells Windows which icon to use when
  // this unpacked/development window is grouped or newly pinned to the taskbar.
  window.setAppDetails({
    appId: WINDOWS_APP_USER_MODEL_ID,
    appIconPath: iconPath,
    appIconIndex: 0,
  })
}
