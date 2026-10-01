import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import './fixture.css'
import { ChatInput } from '../../../src/components/chat/ChatInput'
import { EmptySession } from '../../../src/pages/EmptySession'
import { browserHost } from '../../../src/lib/desktopHost/browserHost'
import { useSettingsStore } from '../../../src/stores/settingsStore'
import { useSessionStore } from '../../../src/stores/sessionStore'
import { useChatStore } from '../../../src/stores/chatStore'
import { useTabStore } from '../../../src/stores/tabStore'
import { useProviderStore } from '../../../src/stores/providerStore'
import { useSessionRuntimeStore, DRAFT_RUNTIME_SELECTION_KEY } from '../../../src/stores/sessionRuntimeStore'
import { useHahaOAuthStore } from '../../../src/stores/hahaOAuthStore'
import { useHahaOpenAIOAuthStore } from '../../../src/stores/hahaOpenAIOAuthStore'
import { useHahaGrokOAuthStore } from '../../../src/stores/hahaGrokOAuthStore'
import { resetContextSelectionStore, useContextSelectionStore } from '../../../src/features/managed-resources/stores/contextSelectionStore'
import type { Host } from '../../../src/features/managed-resources/types/resourceTypes'
import { t } from '../../../src/i18n'

const sessionId = 'composer-toolbar-fixture'
const repo = '/fixture/cc-haha'
const branch = 'fix/wechat-windows-image-filenames'
const session = { id: sessionId, title: 'Composer fixture', createdAt: '2026-09-27T00:00:00Z', modifiedAt: '2026-09-27T00:00:00Z', messageCount: 1, projectPath: repo, workDir: repo, workDirExists: true }
const requests: string[] = []
// Renderer API facade only. BrowserWindow also rejects every network request;
// no saved provider, model connection, SSH host or user config is involved.
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://fixture.invalid')
  const method = init?.method ?? 'GET'
  requests.push(method + ' ' + url.pathname)
  if (method !== 'GET') throw new Error('Fixture forbids writes: ' + url.pathname)
  let body: unknown = { sessions: [], skills: [], plugins: [], activeAgents: [], allAgents: [], commands: [], projects: [], tasks: [], entries: [], tools: [], currentPath: repo, parentPath: null }
  if (url.pathname.endsWith('/git-info')) body = { branch, repoName: 'cc-haha', workDir: repo, changedFiles: 0 }
  else if (url.pathname.includes('repository-context')) body = { state: 'ok', workDir: repo, repoRoot: repo, repoName: 'cc-haha', currentBranch: branch, defaultBranch: 'main', dirty: false, branches: [], worktrees: [] }
  else if (url.pathname.endsWith('/auth-status')) body = { hasAuth: true, source: 'fixture' }
  else if (url.pathname.includes('/inspection')) body = {}
  else if (url.pathname === '/api/sessions') body = { sessions: [session], total: 1 }
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}
const hosts: Host[] = [{ id: 'fixture-host', revision: 1, name: '测试主机', address: '127.0.0.1', port: 22, username: 'fixture', auth: { type: 'password', credentialId: null }, tagIds: [], initialDirectory: null, applications: [], notes: '', createdAt: '2026-09-27T00:00:00Z', updatedAt: '2026-09-27T00:00:00Z' }]
window.desktopHost = {
  ...browserHost, kind: 'electron', isDesktop: true,
  capabilities: { ...browserHost.capabilities, hostManagement: true, conceptKnowledge: true, dataConnections: true },
  hostManagement: { ...browserHost.hostManagement, listHosts: async () => ({ ok: true, data: hosts }), listTags: async () => ({ ok: true, data: [] }) },
  conceptKnowledge: { ...browserHost.conceptKnowledge, listConcepts: async () => ({ ok: true, data: [] }) },
  dataConnections: { ...browserHost.dataConnections, list: async () => ({ ok: true, data: [] }) },
}
useSettingsStore.setState({ locale: 'zh', theme: 'light', effortLevel: 'medium', permissionMode: 'bypassPermissions', currentModel: { id: 'Model-Alpha-Long-Name', name: 'Model-Alpha-Long-Name', description: 'Fixture model', context: '128k' }, availableModels: [] })
useProviderStore.setState({ activeId: 'fixture-provider', hasLoadedProviders: true, isLoading: false,
  providers: [{ id: 'fixture-provider', presetId: 'custom', name: 'Fixture', apiFormat: 'anthropic', apiKey: 'not-a-real-key', baseUrl: 'http://fixture.invalid', models: { main: 'Model-Alpha-Long-Name', haiku: 'Model-Beta', sonnet: '', opus: '' } }],
})
for (const store of [useHahaOAuthStore, useHahaOpenAIOAuthStore, useHahaGrokOAuthStore]) store.setState({ fetchStatus: async () => {} })
useSessionStore.setState({ sessions: [session], activeSessionId: sessionId })
useTabStore.setState({ activeTabId: sessionId, tabs: [{ sessionId, title: 'Fixture', type: 'session', status: 'idle' }] })
useChatStore.setState({ sessions: { [sessionId]: { ...useChatStore.getState().getSession(sessionId), messages: [{ id: 'fixture-message', type: 'assistant_text', content: '收到。', timestamp: 1 }], connectionState: 'connected', chatState: 'idle' } } })
for (const key of [sessionId, DRAFT_RUNTIME_SELECTION_KEY]) useSessionRuntimeStore.getState().setSelection(key, { providerId: 'fixture-provider', modelId: 'Model-Alpha-Long-Name', effortLevel: 'medium' })
resetContextSelectionStore()
type Scenario = { view: 'chat' | 'empty'; width: number; theme: 'light' | 'dark' }
declare global { interface Window { toolbarSmoke: { configure: (s: Scenario) => void; snapshot: () => unknown; label: typeof t } } }
function Fixture() {
  const [scenario, setScenario] = useState<Scenario>({ view: 'chat', width: 900, theme: 'light' })
  window.toolbarSmoke = {
    configure: next => {
      useContextSelectionStore.getState().closePicker()
      useSettingsStore.setState({ theme: next.theme })
      document.documentElement.classList.toggle('dark', next.theme === 'dark')
      document.documentElement.setAttribute('data-theme', next.theme)
      setScenario(next)
    },
    snapshot: () => ({ selection: useContextSelectionStore.getState().snapshot(), pickerKind: useContextSelectionStore.getState().pickerKind, catalogHosts: useContextSelectionStore.getState().catalog.hosts.length, runtime: useSessionRuntimeStore.getState().selections, requests }),
    label: t,
  }
  return <main className="flex h-screen items-end justify-center bg-[var(--color-surface)] pb-6 text-[var(--color-text-primary)]">
    <div data-testid="fixture-column" data-view={scenario.view} data-width={scenario.width} style={{ width: scenario.width, maxWidth: '100%', height: 650 }} className="relative flex min-w-0 flex-col overflow-hidden border border-[var(--color-border)]">
      {scenario.view === 'chat' ? <><div className="flex-1 p-6">收到。<p className="mt-3 text-xs text-[var(--color-text-tertiary)]">离线布局测试 · 长分支名 · 模型与资源入口</p></div><ChatInput /></> : <EmptySession />}
    </div>
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
