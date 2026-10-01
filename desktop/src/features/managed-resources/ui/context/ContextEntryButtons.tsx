/**
 * One compact resource entry for both composers. Its dropdown first selects a
 * category, then shows the existing multi-select picker without changing picks.
 *
 * Every entry has a real accessible name (`Button` `aria-label` /
 * `Checkbox` label / `IconButton` `label`), and the popover is deliberately NOT
 * a modal: the composer keeps focus while it is open so `/hh 生产` keeps
 * filtering as the user types and Enter confirms the highlighted option without
 * ever reaching the send path.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ChevronDown, ChevronRight, Database, Layers, Server, Shapes, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { IconButton } from '@/components/ui/IconButton'
import { SearchField } from '@/components/ui/SearchField'
import { useAnchoredPosition } from '@/hooks/useAnchoredPosition'
import { useDismissable } from '@/hooks/useDismissable'
import { useTranslation } from '../../../../i18n'
import {
  deriveResolvedIds,
  useContextSelectionStore,
  type ContextKind,
  type ContextPickerOption,
} from '../../stores/contextSelectionStore'

export type ContextEntryButtonsProps = {
  /** Tighter controls for the compact composer toolbar. */
  compact?: boolean
}

type SelectedSource = {
  key: string
  label: string
  remove: () => void
}

export function ContextEntryButtons({ compact = false }: ContextEntryButtonsProps) {
  const t = useTranslation()
  const pickerKind = useContextSelectionStore((s) => s.pickerKind)
  const unavailableCommand = useContextSelectionStore((s) => s.unavailableCommand)
  const pickerFilter = useContextSelectionStore((s) => s.pickerFilter)
  const highlightedIndex = useContextSelectionStore((s) => s.highlightedIndex)
  const pick = useContextSelectionStore((s) => s.pick)
  const catalog = useContextSelectionStore((s) => s.catalog)
  const options = useContextSelectionStore((s) => s.options)
  const openPicker = useContextSelectionStore((s) => s.openPicker)
  const closePicker = useContextSelectionStore((s) => s.closePicker)
  const toggleOption = useContextSelectionStore((s) => s.toggleOption)
  const removeSourceTag = useContextSelectionStore((s) => s.removeSourceTag)
  const removeDirectId = useContextSelectionStore((s) => s.removeDirectId)
  const includePasswords = useContextSelectionStore((s) => s.includePasswords)
  const setIncludePasswords = useContextSelectionStore((s) => s.setIncludePasswords)
  const setPickerFilter = useContextSelectionStore((s) => s.setPickerFilter)
  const scope = useContextSelectionStore((s) => `${s.scope}:${s.sessionId ?? ''}`)
  const [menuOpen, setMenuOpen] = useState(false)
  const [focusPicker, setFocusPicker] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const popupId = useId()
  const pickerOpen = Boolean(pickerKind || unavailableCommand)
  const close = useCallback(() => { setMenuOpen(false); setFocusPicker(false); closePicker() }, [closePicker])
  const closeAndFocus = () => { close(); anchorRef.current?.focus() }
  useEffect(() => { setMenuOpen(false) }, [scope])
  useEffect(() => { if (pickerOpen) setMenuOpen(false) }, [pickerOpen])

  // Recomputed on every change, never read from a stored id set.
  const resolved = useMemo(() => deriveResolvedIds(pick, catalog), [pick, catalog])
  // The highlight index is a flat position over the tags-then-resources list.
  const optionList = pickerKind ? options() : []

  const entries: Array<{ kind: ContextKind; label: string; count: number }> = [
    { kind: 'host', label: t('managedResources.context.hosts'), count: resolved.host.length },
    { kind: 'concept', label: t('managedResources.context.concepts'), count: resolved.concept.length },
    { kind: 'database', label: t('managedResources.context.databases'), count: resolved.database.length },
    { kind: 'redis', label: t('managedResources.context.redis'), count: resolved.redis.length },
  ]

  const optionLabel = (option: ContextPickerOption): string => option.label

  const optionDescription = (option: ContextPickerOption): string =>
    option.kind === 'tag'
      ? t('managedResources.context.tagMembers', { count: option.memberIds.length })
      : option.hint

  const tagCatalogFor = (kind: ContextKind) => {
    if (kind === 'host') return catalog.hostTags
    if (kind === 'concept') return catalog.conceptTags
    if (kind === 'database') return catalog.databaseTags
    return catalog.redisTags
  }

  const resourceCatalogFor = (kind: ContextKind) => {
    if (kind === 'host') return catalog.hosts
    if (kind === 'concept') return catalog.concepts
    return catalog.dataConnections.filter((connection) => connection.kind === kind)
  }

  const resourceName = (kind: ContextKind, source: unknown): string | undefined => {
    if (!source || typeof source !== 'object') return undefined
    if (kind === 'concept') return (source as { title?: string }).title
    return (source as { name?: string }).name
  }

  const selectedSources = (kind: ContextKind): SelectedSource[] => {
    const tags: SelectedSource[] = pick.sourceTags
      .filter((tag) => tag.namespace === kind)
      .map((tag) => {
        const name = tagCatalogFor(kind).find((tagDef) => tagDef.id === tag.id)?.name
        const label = name ?? tag.id
        return {
          key: `tag:${tag.namespace}:${tag.id}`,
          label,
          remove: () => removeSourceTag(tag),
        }
      })
    const directs: SelectedSource[] = pick.directIds
      .filter((direct) => direct.namespace === kind)
      .map((direct) => {
        const source = resourceCatalogFor(kind).find((candidate) => candidate.id === direct.id)
        const label = resourceName(kind, source)
        return {
          key: `resource:${direct.namespace}:${direct.id}`,
          label: label ?? direct.id,
          remove: () => removeDirectId(direct),
        }
      })
    return [...tags, ...directs]
  }

  const popoverTitle = pickerKind === 'host'
    ? t('managedResources.context.hostsTitle')
    : pickerKind === 'concept'
      ? t('managedResources.context.conceptsTitle')
      : pickerKind === 'database'
        ? t('managedResources.context.databasesTitle')
        : pickerKind === 'redis'
          ? t('managedResources.context.redisTitle')
          : t('managedResources.context.unavailableTitle')

  const total = entries.reduce((sum, entry) => sum + entry.count, 0)
  const resourceLabel = t('managedResources.context.menu')
  const entryIcons = { host: Server, concept: Shapes, database: Database, redis: Layers }

  return (
    <div className="relative shrink-0" data-testid="context-entry-buttons">
      <Button ref={anchorRef} size={compact ? 'sm' : 'base'}
        variant={menuOpen || pickerOpen || total > 0 ? 'tonal' : 'secondary'}
        aria-haspopup={pickerOpen ? 'dialog' : 'menu'} aria-expanded={menuOpen || pickerOpen}
        aria-controls={menuOpen || pickerOpen ? popupId : undefined}
        aria-label={t('managedResources.context.entryLabel', { name: resourceLabel, count: total })}
        title={entries.map(entry => `${entry.label}: ${entry.count}`).join(' · ')}
        data-testid="context-entry-menu" data-count={total}
        onClick={() => menuOpen || pickerOpen ? close() : setMenuOpen(true)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); event.stopPropagation(); closePicker(); setMenuOpen(true)
          }
        }}>
        <span>{resourceLabel}</span>
        <span aria-hidden="true" className="tabular-nums opacity-70" data-testid="context-entry-total">{total}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </Button>

      {menuOpen && !pickerOpen && <ContextPopover key="categories" anchorRef={anchorRef}
        id={popupId} role="menu" label={resourceLabel} onClose={close} autoFocusMenu>
        {entries.map(({ kind, label, count }) => {
          const Icon = entryIcons[kind]
          return <button key={kind} type="button" role="menuitem"
            aria-label={t('managedResources.context.entryLabel', { name: label, count })}
            data-testid={`context-entry-${kind}`} data-count={count}
            className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2 py-2 text-left text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            onClick={() => { setMenuOpen(false); setFocusPicker(true); openPicker(kind) }}>
            <Icon size={15} aria-hidden="true" />
            <span className="flex-1">{label}</span>
            <span aria-hidden="true" className="tabular-nums text-[var(--color-text-secondary)]" data-testid={`context-entry-${kind}-count`}>{count}</span>
            <ChevronRight size={12} aria-hidden="true" />
          </button>
        })}
      </ContextPopover>}

      {pickerOpen && (
        <ContextPopover key={pickerKind ?? 'unavailable'} anchorRef={anchorRef}
          id={popupId} role="dialog" label={popoverTitle} onClose={close} autoFocusSearch={focusPicker}>
          <div data-testid="context-picker" data-filter={pickerFilter}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <IconButton icon={<ArrowLeft size={14} />} label={t('managedResources.context.backToMenu')}
              size="xs" tone="muted" onClick={() => { closePicker(); setMenuOpen(true) }} />
            <span className="flex-1 text-sm font-medium text-[var(--color-text-primary)]">{popoverTitle}</span>
            <IconButton icon={<X size={14} strokeWidth={2} />} label={t('managedResources.context.close')}
              size="xs" tone="muted" onClick={closeAndFocus} />
          </div>
          {!unavailableCommand && <SearchField value={pickerFilter} onChange={setPickerFilter}
            label={t('managedResources.context.search')} placeholder={t('managedResources.context.search')}
            clearLabel={t('managedResources.context.clearSearch')} size="md" className="mb-3" />}

          {unavailableCommand ? (
            <div data-testid="context-picker-unavailable" role="status" className="space-y-1">
              <p className="text-sm text-[var(--color-text-primary)]">
                {t('managedResources.context.unavailableTitle')}
              </p>
              <p className="text-xs text-[var(--color-text-secondary)]">
                {t('managedResources.context.unavailableBody')}
              </p>
            </div>
          ) : (
            <ContextPickerBody
              options={optionList}
              highlightedIndex={highlightedIndex}
              filter={pickerFilter}
              optionLabel={optionLabel}
              optionDescription={optionDescription}
              onToggle={toggleOption}
              selected={pickerKind ? selectedSources(pickerKind) : []}
              includePasswords={includePasswords}
              onIncludePasswordsChange={setIncludePasswords}
            />
          )}
          </div>
        </ContextPopover>
      )}
    </div>
  )
}

/** Category actions lead to a multi-select dialog, unlike the single-select Dropdown.
 * Reuse the shared positioning/dismissal hooks and portal outside the clipped composer.
 * Slash-triggered dialogs do not grab focus from the editor.
 */
function ContextPopover({ anchorRef, id, role, label, onClose, autoFocusMenu = false, autoFocusSearch = false, children }: {
  anchorRef: RefObject<HTMLButtonElement | null>
  id: string
  role: 'menu' | 'dialog'
  label: string
  onClose: () => void
  autoFocusMenu?: boolean
  autoFocusSearch?: boolean
  children: ReactNode
}) {
  const floatingRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({ open: true, anchorRef, floatingRef,
    placement: 'top-end', offset: 8, viewportMargin: 12, clampHeight: true })
  useDismissable({ open: true, refs: [floatingRef], triggerRef: anchorRef,
    stopEscapePropagation: true, closeOnViewportChange: true,
    onDismiss: reason => {
      const ownedFocus = floatingRef.current?.contains(document.activeElement)
      onClose()
      if (reason === 'escape' && ownedFocus) anchorRef.current?.focus()
    },
  })
  useEffect(() => {
    if (autoFocusMenu) floatingRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    else if (autoFocusSearch) floatingRef.current?.querySelector<HTMLInputElement>('input[type="search"], input[type="text"]')?.focus()
  }, [autoFocusMenu, autoFocusSearch])
  return createPortal(<div ref={floatingRef} id={id} role={role} aria-label={label}
    className="fixed z-[var(--z-dropdown)] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-dropdown)]"
    style={{ ...position.style, width: 'min(320px, calc(100vw - 24px))', maxHeight: Math.min(384, Number(position.style.maxHeight ?? 384)) }}
    onKeyDown={event => {
      // A key inside either popup must never bubble into the composer's send handler.
      event.stopPropagation()
      if (role !== 'menu') return
      const items = Array.from(floatingRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
      const index = items.indexOf(document.activeElement as HTMLElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (index + 1) % items.length
          : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : -1
      if (next >= 0) { event.preventDefault(); items[next]?.focus() }
    }}>
    {children}
  </div>, document.body)
}

type ContextPickerBodyProps = {
  options: ContextPickerOption[]
  highlightedIndex: number
  filter: string
  optionLabel: (option: ContextPickerOption) => string
  optionDescription: (option: ContextPickerOption) => string
  onToggle: (option: ContextPickerOption) => void
  selected: SelectedSource[]
  includePasswords: boolean
  onIncludePasswordsChange: (include: boolean) => void
}

function ContextPickerBody({
  options,
  highlightedIndex,
  filter,
  optionLabel,
  optionDescription,
  onToggle,
  selected,
  includePasswords,
  onIncludePasswordsChange,
}: ContextPickerBodyProps) {
  const t = useTranslation()
  // The highlight index is a flat position over the tags-then-resources list, so
  // the sections carry the index they had in `options`, not their local one.
  const indexed = options.map((option, index) => ({ option, index }))
  const tagOptions = indexed.filter((entry) => entry.option.kind === 'tag')

  if (options.length === 0) {
    return (
      <div data-testid="context-picker-empty" role="status">
        <p className="text-xs text-[var(--color-text-secondary)]">
          {filter
            ? t('managedResources.context.noMatches', { query: filter })
            : t('managedResources.context.noResources')}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <section aria-label={t('managedResources.context.tagsSection')}>
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-text-tertiary)]">
          {t('managedResources.context.tagsSection')}
        </h3>
        {tagOptions.length === 0 ? (
          <p className="text-xs text-[var(--color-text-secondary)]">
            {t('managedResources.context.noTags')}
          </p>
        ) : (
          <ul className="space-y-1">
            {tagOptions.map(({ option, index }) => (
              <li key={`tag:${option.kind === 'tag' ? option.tag.id : index}`}>
                <Checkbox
                  label={optionLabel(option)}
                  description={optionDescription(option)}
                  checked={option.selected}
                  data-testid={`context-option-tag-${option.kind === 'tag' ? option.tag.id : index}`}
                  data-highlighted={highlightedIndex === index ? 'true' : 'false'}
                  containerClassName={highlightedIndex === index ? 'rounded-[var(--radius-sm)] ring-1 ring-[var(--color-border-focus)]' : undefined}
                  onChange={() => onToggle(option)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label={t('managedResources.context.resourcesSection')}>
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-text-tertiary)]">
          {t('managedResources.context.resourcesSection')}
        </h3>
        {options.length === tagOptions.length ? (
          <p className="text-xs text-[var(--color-text-secondary)]">
            {t('managedResources.context.noResources')}
          </p>
        ) : (
          <ul className="space-y-1">
            {indexed
              .filter((entry) => entry.option.kind === 'resource')
              .map(({ option, index }) => (
                <li key={`resource:${option.kind === 'resource' ? option.id.id : index}`}>
                  <Checkbox
                    label={optionLabel(option)}
                    description={optionDescription(option)}
                    checked={option.selected}
                    data-testid={`context-option-resource-${option.kind === 'resource' ? option.id.id : index}`}
                    data-highlighted={highlightedIndex === index ? 'true' : 'false'}
                    containerClassName={highlightedIndex === index ? 'rounded-[var(--radius-sm)] ring-1 ring-[var(--color-border-focus)]' : undefined}
                    onChange={() => onToggle(option)}
                  />
                </li>
              ))}
          </ul>
        )}
      </section>

      <section aria-label={t('managedResources.context.credentialsSection')}>
        <Checkbox
          label={t('managedResources.context.includePasswords')}
          description={t('managedResources.context.includePasswordsDescription')}
          checked={includePasswords}
          disabled={selected.length === 0}
          data-testid="context-include-passwords"
          onChange={(event) => onIncludePasswordsChange(event.currentTarget.checked)}
        />
      </section>

      <section aria-label={t('managedResources.context.selectedSection')}>
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-text-tertiary)]">
          {t('managedResources.context.selectedSection')}
        </h3>
        {selected.length === 0 ? (
          <p className="text-xs text-[var(--color-text-secondary)]">
            {t('managedResources.context.emptySelection')}
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1">
            {selected.map((source) => (
              <li
                key={source.key}
                data-testid={`context-selected-${source.key}`}
                className="inline-flex items-center gap-1 rounded-full bg-[var(--color-brand-soft)] px-2 py-0.5 text-xs text-[var(--color-on-brand-soft)]"
              >
                <span>{source.label}</span>
                <IconButton
                  icon={<X size={11} strokeWidth={2.4} />}
                  label={t('managedResources.context.removeSource', { name: source.label })}
                  size="2xs"
                  tone="muted"
                  onClick={source.remove}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
