import { useEffect, useRef, useState } from 'react'
import { getDesktopHost } from '../../../../lib/desktopHost'
import type { TranslationKey } from '../../../../i18n'

const copyErrorKeys: Partial<Record<string, TranslationKey>> = {
  OS_AUTH_CANCELLED: 'managedResources.errors.OS_AUTH_CANCELLED',
  OS_AUTH_FAILED: 'managedResources.errors.OS_AUTH_FAILED',
  OS_AUTH_UNAVAILABLE: 'managedResources.errors.OS_AUTH_UNAVAILABLE',
  TAG_CONNECTIONS_CHANGED: 'managedResources.tagCopy.changed',
  TAG_CONNECTIONS_EMPTY: 'managedResources.tagCopy.empty',
}

type CopyFeedback =
  | { kind: 'success'; hostCount: number; accountCount: number }
  | { kind: 'error'; messageKey: TranslationKey }

export function useCopyHostTag() {
  const [busyTagId, setBusyTagId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<CopyFeedback | null>(null)
  const inFlight = useRef(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const copyTag = async (tagId: string) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusyTagId(tagId)
    setFeedback(null)
    try {
      const result = await getDesktopHost().hostManagement.copyTagConnections(tagId)
      if (!alive.current) return
      setFeedback(result.ok
        ? { kind: 'success', hostCount: result.data.hostCount, accountCount: result.data.accountCount }
        : { kind: 'error', messageKey: copyErrorKeys[result.error.code] ?? 'managedResources.tagCopy.failed' })
    } catch {
      if (alive.current) setFeedback({ kind: 'error', messageKey: 'managedResources.tagCopy.failed' })
    } finally {
      inFlight.current = false
      if (alive.current) setBusyTagId(null)
    }
  }

  return { busyTagId, feedback, copyTag }
}
