import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { HostList } from './HostList'
import { useHostManagementStore } from '../../stores/hostManagementStore'
import { useHostSshStore } from '../../stores/hostSshStore'
import { useSettingsStore } from '../../../../stores/settingsStore'
import { browserHost } from '../../../../lib/desktopHost/browserHost'
import type { Host, ResourceTag } from '../../types/resourceTypes'
import type { HostManagementResult } from '../../api/hostManagementApi'
import { translate } from '../../../../i18n'

const revision = { revision: 1, createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' }
const tags: ResourceTag[] = [
  { ...revision, id: 'ambari-tag', namespace: 'host', name: 'ambari', normalizedName: 'ambari', colorToken: 'blue' },
  { ...revision, id: 'other-tag', namespace: 'host', name: '其他', normalizedName: '其他', colorToken: 'red' },
  { ...revision, id: 'empty-tag', namespace: 'host', name: '空标签', normalizedName: '空标签', colorToken: 'blue' },
]
function fixtureHost(id: string, tagId: string): Host {
  return { ...revision, id, name: id, address: `host-${id}.example`, port: 22, username: 'root', auth: { type: 'password', credentialId: `credential-${id}` }, tagIds: [tagId], initialDirectory: null, applications: [], notes: '' }
}
type CopyResult = HostManagementResult<{ hostCount: number; accountCount: number }>
const copyTagConnections = vi.fn<(tagId: string) => Promise<CopyResult>>()
const action = (name: string) => `复制「${name}」下全部服务器连接信息（Markdown）`

describe('Host tag clipboard action', () => {
  beforeEach(() => {
    copyTagConnections.mockReset()
    copyTagConnections.mockResolvedValue({ ok: true, data: { hostCount: 2, accountCount: 3 } })
    window.desktopHost = { ...browserHost, hostManagement: { ...browserHost.hostManagement, copyTagConnections } }
    useSettingsStore.setState({ locale: 'zh' })
    useHostSshStore.setState(useHostSshStore.getInitialState(), true)
    useHostManagementStore.setState({
      ...useHostManagementStore.getInitialState(),
      hosts: [fixtureHost('visible', 'ambari-tag'), fixtureHost('search-hidden', 'ambari-tag'), fixtureHost('unrelated', 'other-tag')],
      tags,
      searchQuery: 'visible',
      selectedHostId: 'unrelated',
      selectedTagId: 'other-tag',
    }, true)
  })

  afterEach(() => {
    cleanup()
    window.desktopHost = browserHost
    useHostManagementStore.setState(useHostManagementStore.getInitialState(), true)
    useHostSshStore.setState(useHostSshStore.getInitialState(), true)
  })

  it('copies the whole tag by ID despite search and selected-tag filtering, without changing selection', async () => {
    render(<HostList />)
    const copy = screen.getByRole('button', { name: action('ambari') })
    expect(copy).toHaveAttribute('title', action('ambari'))
    expect(copy.closest('button button')).toBeNull()
    expect(screen.getByRole('button', { name: 'ambari (2)' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByText('search-hidden')).not.toBeInTheDocument()

    fireEvent.click(copy)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已复制 2 台主机、3 个账号的连接信息（Markdown）。'))
    expect(copyTagConnections).toHaveBeenCalledExactlyOnceWith('ambari-tag')
    expect(useHostManagementStore.getState()).toMatchObject({ searchQuery: 'visible', selectedTagId: 'other-tag', selectedHostId: 'unrelated' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('disables empty tags and duplicate or concurrent copies while pending, then allows another tag', async () => {
    let complete!: (result: CopyResult) => void
    copyTagConnections.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    render(<HostList />)
    const ambari = screen.getByRole('button', { name: action('ambari') })
    const other = screen.getByRole('button', { name: action('其他') })
    const empty = screen.getByRole('button', { name: action('空标签') })
    expect(empty).toBeDisabled()
    fireEvent.click(empty)
    expect(copyTagConnections).not.toHaveBeenCalled()

    fireEvent.click(ambari)
    expect(ambari).toBeDisabled()
    expect(ambari).toHaveAttribute('aria-busy', 'true')
    expect(other).toBeDisabled()
    fireEvent.click(ambari)
    fireEvent.click(other)
    expect(copyTagConnections).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'ambari (2)' })).toBeEnabled()
    complete({ ok: true, data: { hostCount: 2, accountCount: 3 } })
    await waitFor(() => expect(other).toBeEnabled())
    fireEvent.click(other)
    await waitFor(() => expect(copyTagConnections).toHaveBeenCalledTimes(2))
    expect(copyTagConnections).toHaveBeenLastCalledWith('other-tag')
  })

  it.each(['result', 'exception'])('reports %s failure in Chinese without echoing native secret/error text and allows retry', async failure => {
    if (failure === 'exception') copyTagConnections.mockRejectedValueOnce(new Error('SENSITIVE_FIXTURE_DO_NOT_RENDER'))
    else copyTagConnections.mockResolvedValueOnce({ ok: false, error: { code: 'VALIDATION_FAILED', messageKey: 'SENSITIVE_FIXTURE_DO_NOT_RENDER' } })
    render(<HostList />)
    const copy = screen.getByRole('button', { name: action('ambari') })
    fireEvent.click(copy)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('复制失败，请重试。'))
    expect(document.body).not.toHaveTextContent('SENSITIVE_FIXTURE_DO_NOT_RENDER')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(copy).toBeEnabled()
    fireEvent.click(copy)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已复制 2 台主机'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })


  it.each([
    ['OS_AUTH_CANCELLED', 'managedResources.errors.OS_AUTH_CANCELLED'],
    ['OS_AUTH_FAILED', 'managedResources.errors.OS_AUTH_FAILED'],
    ['OS_AUTH_UNAVAILABLE', 'managedResources.errors.OS_AUTH_UNAVAILABLE'],
    ['TAG_CONNECTIONS_CHANGED', 'managedResources.tagCopy.changed'],
    ['TAG_CONNECTIONS_EMPTY', 'managedResources.tagCopy.empty'],
  ] as const)('maps %s to an allowlisted localized explanation instead of native message text', async (code, messageKey) => {
    copyTagConnections.mockResolvedValueOnce({ ok: false, error: { code, messageKey: 'SENSITIVE_FIXTURE_DO_NOT_RENDER' } })
    render(<HostList />)
    const copy = screen.getByRole('button', { name: action('ambari') })
    fireEvent.click(copy)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(translate('zh', messageKey)))
    expect(copy).toBeEnabled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('SENSITIVE_FIXTURE_DO_NOT_RENDER')
  })
})
