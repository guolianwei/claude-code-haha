import { create } from 'zustand'
import type {
  Host,
  SshConnectionStatus,
  HostManagementEvent,
} from '../types/resourceTypes'
import { getDesktopHost } from '../../../lib/desktopHost/index'
import { clearTerminalOutput, retainTerminalOutput } from './terminalOutputReplay'
import { findHostSshAccount } from '../types/hostSshAccounts'

export type HostSshStatus =
  | 'idle'
  | 'allocating'
  | 'connecting'
  | 'awaiting_host_key'
  | 'ready'
  | 'closing'
  | 'closed'
  | 'failed'

export type HostSshEntry = {
  hostId: string
  accountId?: string
  username?: string
  hostRevision?: number
  connectionId: string | null
  generation: number
  status: HostSshStatus
  challenge: { challengeId: string; endpoint: string; algorithm: string; fingerprint: string } | null
  lastError: string | null
  changedKey: null | { oldFingerprint: string; newFingerprint: string; endpoint: string; algorithm: string }
  unackedBytes: number
  isPaused: boolean
  // We store the most recent output byte length so the surface can ack on
  // render. The service itself owns backpressure semantics; the store only
  // mirrors the current unacked count surfaced by the host.
  unlistenEvent: (() => void) | null
}

export type HostSshState = {
  byHostId: Record<string, HostSshEntry>
  selectedAccountByHostId: Record<string, string>
  selectAccount: (host: Host, accountId: string) => boolean
  ensureEntry: (hostId: string) => HostSshEntry
  start: (host: Host, cols: number, rows: number) => Promise<void>
  answer: (hostId: string, decision: 'trust' | 'reject') => Promise<void>
  write: (hostId: string, data: string) => Promise<void>
  resize: (hostId: string, cols: number, rows: number) => Promise<void>
  ack: (hostId: string, bytesAcked: number) => Promise<void>
  disconnect: (hostId: string) => Promise<void>
  teardownAll: () => void
}

export function isHostSshBusy(entry?: HostSshEntry): boolean {
  return !!entry && !['idle', 'failed', 'closed'].includes(entry.status)
}

function toSshStatus(status: SshConnectionStatus): HostSshStatus {
  switch (status) {
    case 'allocated': return 'allocating'
    case 'connecting': return 'connecting'
    case 'awaiting_host_key': return 'awaiting_host_key'
    case 'authenticating': return 'connecting'
    case 'ready': return 'ready'
    case 'closing': return 'closing'
    case 'closed': return 'closed'
    case 'disconnected': return 'closed'
    case 'failed': return 'failed'
  }
}

function emptyEntry(hostId: string): HostSshEntry {
  return {
    hostId,
    connectionId: null,
    generation: 0,
    status: 'idle',
    challenge: null,
    lastError: null,
    changedKey: null,
    unackedBytes: 0,
    isPaused: false,
    unlistenEvent: null,
  }
}

// We track every per-host event unlisten globally so the store can release
// them when the workbench unmounts or when the user switches hosts.
const unlistenByHost = new Map<string, () => void>()
// A cancellation or teardown invalidates asynchronous allocation work, even
// before the native connection id has reached the renderer.
const pendingStarts = new Map<string, symbol>()

export const useHostSshStore = create<HostSshState>((set, get) => ({
  byHostId: {},
  selectedAccountByHostId: {},
  selectAccount(host, accountId) {
    const entry = get().byHostId[host.id]
    if (isHostSshBusy(entry) || !findHostSshAccount(host, accountId)) return false
    set(state => ({
      selectedAccountByHostId: { ...state.selectedAccountByHostId, [host.id]: accountId },
      byHostId: { ...state.byHostId, [host.id]: { ...(entry ?? emptyEntry(host.id)), lastError: null } },
    }))
    return true
  },
  ensureEntry(hostId) {
    const existing = get().byHostId[hostId]
    if (existing) return existing
    const entry = emptyEntry(hostId)
    set(state => ({ byHostId: { ...state.byHostId, [hostId]: entry } }))
    return entry
  },
  async start(host, cols, rows) {
    let entry = get().byHostId[host.id] ?? emptyEntry(host.id)
    if (isHostSshBusy(entry)) return
    const account = findHostSshAccount(host, get().selectedAccountByHostId[host.id] ?? host.id)
    if (!account) {
      set(state => ({ byHostId: { ...state.byHostId, [host.id]: { ...entry, status: 'failed', lastError: 'SSH_ACCOUNT_NOT_FOUND' } } }))
      return
    }
    const hostApi = getDesktopHost().hostManagement
    const intent = Symbol(host.id)
    pendingStarts.set(host.id, intent)
    const isCurrent = () => pendingStarts.get(host.id) === intent
    try {
      if (entry.connectionId && ((entry.accountId ?? host.id) !== account.id || (entry.hostRevision ?? host.revision) !== host.revision)) {
        set(state => ({ byHostId: { ...state.byHostId, [host.id]: { ...entry, status: 'closing' } } }))
        const closed = await hostApi.disconnect({ connectionId: entry.connectionId })
        if (!isCurrent()) return
        if (!closed.ok) {
          set(state => ({ byHostId: { ...state.byHostId, [host.id]: { ...entry, status: 'failed', lastError: closed.error.code } } }))
          return
        }
        clearTerminalOutput(host.id)
        unlistenByHost.get(host.id)?.()
        unlistenByHost.delete(host.id)
        entry = { ...entry, connectionId: null, generation: 0, status: 'closed', challenge: null }
      }
      // Publish intent before the first subscription/allocation await so double
      // clicks and account changes cannot cross two users' connection attempts.
      set(state => ({ byHostId: { ...state.byHostId, [host.id]: {
        ...entry, accountId: account.id, username: account.username, hostRevision: host.revision,
        status: 'allocating', lastError: null, challenge: null,
      } } }))
      if (entry.connectionId) {
        // Active attempts are idempotent, but a failed generation is explicitly
        // retryable through the same service connection so the main process can
        // advance its generation without leaking another allocated session.
        const retry = await hostApi.startConnection({ connectionId: entry.connectionId })
        if (!isCurrent()) return
        if (!retry.ok) {
          set(state => ({
            byHostId: {
              ...state.byHostId,
              [host.id]: {
                ...(state.byHostId[host.id] ?? emptyEntry(host.id)),
                status: 'failed',
                lastError: retry.error.code,
              },
            },
          }))
        }
        return
      }

      // Bind event subscription for this host BEFORE createConnection so the
      // first 'allocated' event reaches us. The IPC handler also registers its
      // own binding for delivery gating — that one is the gate; this one is
      // the UI's mirror.
      if (!unlistenByHost.has(host.id)) {
        const unlisten = await hostApi.onEvent((event: HostManagementEvent) => {
          if (!('connectionId' in event)) return
          const entryNow = get().byHostId[host.id]
          if (!entryNow) return
          // Allocation itself emits no events. Until its exact id is returned,
          // ignore every frame instead of binding a different host's connection.
          if (entryNow.connectionId !== event.connectionId) return
          if (event.generation < entryNow.generation) return
          if (event.type === 'terminal-output') {
            if (entryNow.connectionId !== event.connectionId || entryNow.generation !== event.generation) return
            try {
              const binary = atob(event.data)
              const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
              if (bytes.length !== event.byteLength) return
              retainTerminalOutput(host.id, event.connectionId, event.generation, bytes, () => {
                const current = get().byHostId[host.id]
                if (current?.connectionId !== event.connectionId || current.generation !== event.generation) return
                void hostApi.ackOutput({ connectionId: event.connectionId, generation: event.generation, bytesAcked: bytes.length }).catch(() => undefined)
              })
            } catch { /* Never render a malformed output frame. */ }
            return
          }
          if (event.type === 'connection-state') {
            if (event.generation !== entryNow.generation) clearTerminalOutput(host.id)
            set(state => {
              const existing = state.byHostId[host.id] ?? emptyEntry(host.id)
              const status = toSshStatus(event.status)
              return {
                byHostId: {
                  ...state.byHostId,
                  [host.id]: {
                    ...existing,
                    status,
                    // A host-key challenge only exists while KEX is explicitly
                    // waiting for a decision. Never keep a stale challenge after
                    // authentication, success, rejection or disconnect.
                    challenge: event.status === 'awaiting_host_key'
                      ? (event.hostKeyChallenge ?? existing.challenge)
                      : null,
                    lastError: status === 'failed' ? (event.error ?? existing.lastError) : null,
                    generation: event.generation,
                    connectionId: event.connectionId,
                    changedKey: event.status === 'connecting' || event.status === 'ready'
                      ? null
                      : existing.changedKey,
                  },
                },
              }
            })
          } else if (event.type === 'connection-host-key-changed') {
            set(state => {
              const existing = state.byHostId[host.id] ?? emptyEntry(host.id)
              return {
                byHostId: {
                  ...state.byHostId,
                  [host.id]: {
                    ...existing,
                    status: 'failed',
                    lastError: 'HOST_KEY_CHANGED',
                    changedKey: {
                      oldFingerprint: event.oldFingerprint,
                      newFingerprint: event.newFingerprint,
                      endpoint: event.endpoint,
                      algorithm: event.algorithm,
                    },
                  },
                },
              }
            })
          }
        })
        if (!isCurrent()) { unlisten(); return }
        unlistenByHost.set(host.id, unlisten)
      }

      const create = await hostApi.createConnection({ hostId: host.id, accountId: account.id, expectedRevision: host.revision, cols, rows })
      if (!isCurrent()) {
        // Release a late native allocation without adopting its id or starting it.
        if (create.ok) await hostApi.disconnect({ connectionId: create.data.connectionId }).catch(() => undefined)
        return
      }
      if (!create.ok) {
        const unlisten = unlistenByHost.get(host.id)
        if (unlisten) unlisten()
        unlistenByHost.delete(host.id)
        set(state => ({
          byHostId: {
            ...state.byHostId,
            [host.id]: {
              ...(state.byHostId[host.id] ?? emptyEntry(host.id)),
              status: 'failed',
              lastError: create.error.code,
            },
          },
        }))
        return
      }
      set(state => ({
        byHostId: {
          ...state.byHostId,
          [host.id]: {
            ...(state.byHostId[host.id] ?? emptyEntry(host.id)),
            connectionId: create.data.connectionId,
            generation: create.data.generation,
            status: 'allocating',
            lastError: null,
          },
        },
      }))
      const startRes = await hostApi.startConnection({ connectionId: create.data.connectionId })
      if (!isCurrent()) return
      if (!startRes.ok) {
        // A start failure leaves an allocated main-process connection. Release it
        // before clearing the renderer id so a retry cannot exhaust the per-owner
        // connection limit with unreachable sessions.
        await hostApi.disconnect({ connectionId: create.data.connectionId }).catch(() => undefined)
        if (!isCurrent()) return
        const unlisten = unlistenByHost.get(host.id)
        if (unlisten) unlisten()
        unlistenByHost.delete(host.id)
        set(state => {
          const existing = state.byHostId[host.id] ?? emptyEntry(host.id)
          return {
            byHostId: {
              ...state.byHostId,
              [host.id]: {
                ...existing,
                connectionId: null,
                generation: 0,
                status: 'failed',
                lastError: startRes.error.code,
              },
            },
          }
        })
        return
      }
    } catch {
      if (!isCurrent()) return
      set(state => ({ byHostId: { ...state.byHostId, [host.id]: {
        ...(state.byHostId[host.id] ?? emptyEntry(host.id)), status: 'failed', lastError: 'SSH_ERROR',
      } } }))
    } finally {
      if (isCurrent()) pendingStarts.delete(host.id)
    }
  },
  async answer(hostId, decision) {
    const entry = get().byHostId[hostId]
    if (!entry || !entry.connectionId || !entry.challenge) return
    const res = await getDesktopHost().hostManagement.answerHostKey({
      connectionId: entry.connectionId,
      challengeId: entry.challenge.challengeId,
      decision,
    })
    if (!res.ok) {
      set(state => {
        const existing = state.byHostId[hostId] ?? emptyEntry(hostId)
        return {
          byHostId: {
            ...state.byHostId,
            [hostId]: { ...existing, lastError: res.error.messageKey },
          },
        }
      })
      return
    }
    set(state => {
      const existing = state.byHostId[hostId] ?? emptyEntry(hostId)
      return {
        byHostId: {
          ...state.byHostId,
          [hostId]: { ...existing, challenge: null },
        },
      }
    })
  },
  async write(hostId, data) {
    const entry = get().byHostId[hostId]
    if (!entry || !entry.connectionId) return
    const res = await getDesktopHost().hostManagement.writeConnection({
      connectionId: entry.connectionId,
      generation: entry.generation,
      data,
    })
    if (!res.ok) {
      set(state => {
        const existing = state.byHostId[hostId] ?? emptyEntry(hostId)
        return {
          byHostId: {
            ...state.byHostId,
            [hostId]: { ...existing, lastError: res.error.messageKey },
          },
        }
      })
    }
  },
  async resize(hostId, cols, rows) {
    const entry = get().byHostId[hostId]
    if (!entry || !entry.connectionId) return
    const res = await getDesktopHost().hostManagement.resizeConnection({
      connectionId: entry.connectionId,
      generation: entry.generation,
      cols,
      rows,
    })
    if (!res.ok) {
      set(state => {
        const existing = state.byHostId[hostId] ?? emptyEntry(hostId)
        return {
          byHostId: {
            ...state.byHostId,
            [hostId]: { ...existing, lastError: res.error.messageKey },
          },
        }
      })
    }
  },
  async ack(hostId, bytesAcked) {
    const entry = get().byHostId[hostId]
    if (!entry || !entry.connectionId) return
    const res = await getDesktopHost().hostManagement.ackOutput({
      connectionId: entry.connectionId,
      generation: entry.generation,
      bytesAcked,
    })
    if (!res.ok) return
    set(state => {
      const existing = state.byHostId[hostId] ?? emptyEntry(hostId)
      return {
        byHostId: {
          ...state.byHostId,
          [hostId]: {
            ...existing,
            unackedBytes: Math.max(0, existing.unackedBytes - bytesAcked),
          },
        },
      }
    })
  },
  async disconnect(hostId) {
    pendingStarts.delete(hostId)
    const entry = get().byHostId[hostId]
    if (!entry) return
    if (!entry.connectionId) {
      unlistenByHost.get(hostId)?.()
      unlistenByHost.delete(hostId)
      clearTerminalOutput(hostId)
      set(state => ({ byHostId: { ...state.byHostId, [hostId]: { ...entry, status: 'closed', challenge: null } } }))
      return
    }
    set(state => ({ byHostId: { ...state.byHostId, [hostId]: { ...entry, status: 'closing' } } }))
    const result = await getDesktopHost().hostManagement.disconnect({ connectionId: entry.connectionId })
      .catch(() => ({ ok: false as const, error: { messageKey: 'SSH_ERROR' } }))
    if (get().byHostId[hostId]?.connectionId !== entry.connectionId) return
    if (!result.ok) {
      set(state => {
        const existing = state.byHostId[hostId] ?? emptyEntry(hostId)
        return {
          byHostId: {
            ...state.byHostId,
            [hostId]: { ...existing, status: 'failed', lastError: result.error.messageKey },
          },
        }
      })
      return
    }
    clearTerminalOutput(hostId)
    // The main process emits closing/closed before resolving the IPC call. Do
    // not overwrite that terminal state with a stale local "closing" value.
    set(state => {
      const existing = state.byHostId[hostId] ?? emptyEntry(hostId)
      return {
        byHostId: {
          ...state.byHostId,
          [hostId]: {
            ...existing,
            connectionId: null,
            generation: 0,
            status: 'closed',
            challenge: null,
          },
        },
      }
    })
    const unlisten = unlistenByHost.get(hostId)
    if (unlisten) unlisten()
    unlistenByHost.delete(hostId)
  },
  teardownAll() {
    pendingStarts.clear()
    clearTerminalOutput()
    for (const [, unlisten] of unlistenByHost.entries()) unlisten()
    unlistenByHost.clear()
    set({ byHostId: {}, selectedAccountByHostId: {} })
  },
}))
