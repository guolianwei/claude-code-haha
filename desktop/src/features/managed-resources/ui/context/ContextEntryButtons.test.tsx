import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { useSettingsStore } from '@/stores/settingsStore'
import { ContextEntryButtons } from './ContextEntryButtons'
import { EMPTY_CONTEXT_CATALOG, resetContextSelectionStore, useContextSelectionStore } from '../../stores/contextSelectionStore'

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  resetContextSelectionStore()
  useContextSelectionStore.getState().setCatalog({
    ...EMPTY_CONTEXT_CATALOG,
    hosts: [{ id: 'host-1', revision: 1, name: 'Fixture host', address: '127.0.0.1', port: 22, username: 'fixture',
      auth: { type: 'password', credentialId: null }, tagIds: [], initialDirectory: null,
      applications: [], notes: '', createdAt: '2026-09-27T00:00:00Z', updatedAt: '2026-09-27T00:00:00Z' }],
  })
})
afterEach(() => { cleanup(); resetContextSelectionStore(); vi.restoreAllMocks() })

describe('composer resource dropdown', () => {
  it('uses one toolbar trigger and keeps all four categories inside the menu', () => {
    render(<ContextEntryButtons />)
    const root = screen.getByTestId('context-entry-buttons')
    expect(within(root).getAllByRole('button')).toHaveLength(1)
    expect(screen.queryByTestId('context-entry-host')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('context-entry-menu'))
    const menu = screen.getByRole('menu', { name: 'Resources' })
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(4)
    for (const kind of ['host', 'concept', 'database', 'redis']) {
      expect(within(menu).getByTestId(`context-entry-${kind}-count`)).toHaveTextContent('0')
    }
  })

  it('retains selected resources and category counts when returning or closing the menu', () => {
    render(<ContextEntryButtons />)
    fireEvent.click(screen.getByTestId('context-entry-menu'))
    fireEvent.click(screen.getByTestId('context-entry-host'))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Fixture host' }))
    expect(screen.getByTestId('context-entry-total')).toHaveTextContent('1')
    expect(useContextSelectionStore.getState().includePasswords).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Back to resources' }))
    expect(screen.getByTestId('context-entry-host-count')).toHaveTextContent('1')
    fireEvent.click(screen.getByTestId('context-entry-redis'))
    expect(screen.getByRole('dialog', { name: 'Redis context' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Close context picker' }))
    expect(screen.queryByTestId('context-picker')).not.toBeInTheDocument()
    expect(screen.getByTestId('context-entry-menu')).toHaveFocus()
    expect(useContextSelectionStore.getState().resolvedIds().host).toEqual(['host-1'])
    fireEvent.click(screen.getByTestId('context-entry-menu'))
    fireEvent.click(screen.getByTestId('context-entry-host'))
    expect(screen.getByRole('checkbox', { name: 'Fixture host' })).toBeChecked()
  })

  it('supports menu keyboard navigation and Escape without sending a message', () => {
    const submit = vi.fn()
    render(<div onKeyDown={submit}><ContextEntryButtons compact /></div>)
    fireEvent.click(screen.getByTestId('context-entry-menu'))
    expect(screen.getByTestId('context-entry-host')).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(screen.getByTestId('context-entry-redis')).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(screen.getByTestId('context-entry-database')).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByTestId('context-entry-menu')).toHaveFocus()
    expect(submit).not.toHaveBeenCalled()
  })

  it('keeps slash-triggered picker focus in the composer and dismisses on an outside pointer', () => {
    render(<><textarea aria-label="Composer" /><ContextEntryButtons /><button>Outside</button></>)
    const composer = screen.getByRole('textbox', { name: 'Composer' })
    composer.focus()
    act(() => useContextSelectionStore.getState().openPicker('host'))
    expect(screen.getByTestId('context-picker')).toBeVisible()
    expect(composer).toHaveFocus()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByTestId('context-picker')).not.toBeInTheDocument()
  })
})
