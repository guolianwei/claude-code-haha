import { handlePreviewLink, isAbsoluteLocalPath, isRootedLocalPath } from './handlePreviewLink'
import { getServerBaseUrl } from './desktopRuntime'
import { getDesktopHost } from './desktopHost'
import { isWithinWorkDir } from './assistantOutputTargets'
import { isWorkspaceDocumentFile } from './fileCapabilities'
import { useWorkspaceContentStore } from '../stores/workspaceContentStore'
import { workspaceOpen } from './workspace/openTarget'
import { openLocalFileWithSystem, reportOpenFailure, resolveAbsoluteOpenPath } from './systemFileOpen'

/**
 * Whether the workspace preview can actually reach this document.
 *
 * The file routes serve the session workdir and the roots registered for files a
 * turn changed; a document elsewhere (`~/thesis.docx`, another drive) would open
 * a tab that goes straight to a 403. Those keep going to the system application,
 * as every document link did before the workspace could render them. A relative
 * path is resolved against the workdir by the server, which is reachable unless its
 * `../` climbs out of the workdir — `../shared/spec.pdf` is as far outside as its
 * absolute form. An absolute path while the workdir is still unknown is treated as
 * unreachable: the system app is the outcome the user had before, and it always works.
 */
function documentReachableInWorkspace(path: string, workDir: string | undefined): boolean {
  if (!isRootedLocalPath(path)) return !workDir || isWithinWorkDir(resolveAbsoluteOpenPath(path, workDir), workDir)
  if (!workDir || !isAbsoluteLocalPath(path)) return false
  return isWithinWorkDir(path, workDir)
}

/**
 * Route a clicked link the way the chat surface always has: a loopback URL opens
 * the workbench browser on the right, a workspace file opens its preview, and a
 * remote URL goes to the system browser.
 *
 * {@link handlePreviewLink} stays dependency-injected for testing; this is the
 * one place that binds it to the real stores, so the markdown body, the output
 * cards and the user prompt bubble cannot drift apart.
 *
 * Returns true when the link was handled (the caller should preventDefault).
 */
export function openPreviewLink(href: string, sessionId: string): boolean {
  const currentWorkDir = () => useWorkspaceContentStore.getState().statusBySession[sessionId]?.workDir
  const openSystemFile = (path: string) => {
    const absolutePath = resolveAbsoluteOpenPath(path, currentWorkDir())
    void openLocalFileWithSystem(absolutePath).catch(() => reportOpenFailure(absolutePath))
  }

  return handlePreviewLink(href, {
    sessionId,
    serverBaseUrl: getServerBaseUrl(),
    openBrowser: (id, url) => { workspaceOpen.browser(id, url) },
    openFilePreview: (id, path, reveal) => {
      if (isWorkspaceDocumentFile(path) && !documentReachableInWorkspace(path, currentWorkDir())) {
        openSystemFile(path)
        return
      }
      workspaceOpen.file(id, path, {
        ...(reveal ? { line: reveal.line, ...(reveal.column ? { column: reveal.column } : {}) } : {}),
      })
    },
    openSystemFile,
    openExternal: (url) => {
      void getDesktopHost().shell.open(url)
        .catch(() => window.open(url, '_blank'))
    },
  })
}
