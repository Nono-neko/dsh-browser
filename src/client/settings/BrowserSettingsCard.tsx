/**
 * The plugin settings card: registers into the official Plugins section's
 * `settings.plugin.item` slot (declared at runtime by dsh's settings-plugins
 * shell) and renders the staged form over the `dsh-browser` settings
 * namespace. The slot type is declared here with the shell's shape so this
 * standalone package can register without depending on the shell package.
 *
 * Layout mirrors the official PluginCard: a clickable header (name +
 * description + chevron) that discloses the staged form and save/discard
 * footer in place. Collapse state is card-local.
 * @module dsh-browser/client/settings/BrowserSettingsCard
 */

import { useEffect, useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserSettingsActions, CardState, BrowserSettingsForm } from './card-form.ts'
import css from './settings-card.module.css'

/** The card's locale-bound translate (namespace 'dsh-browser'). */
type CardT = TranslateNS<'dsh-browser'>

/** The registration-side face the card's slot entry injects. */
export interface BrowserSettingsCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as useBrowserSettingsCard. */
    browserSettingsCard: HostObservable<CardState>
  }
}

/** Owner share of a plugin card (the section supplies nothing). */
export interface SettingsPluginItemOwnerProps {
  /** Marker field: card owner props are intentionally empty. */
  children?: never
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * One plugin's card inside the plugin configuration section. Options:
     * `id` (card key), `order` (card position). Declared at runtime by the
     * Plugins settings section; this package declares the type with the same
     * shape so it can register without depending on that package.
     */
    'settings.plugin.item': {
      kind: 'list'
      scope: 'root'
      owner: SettingsPluginItemOwnerProps
    }
  }
}

export type BrowserSettingsCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'dsh-browser'>
  & InjectFace<BrowserSettingsCardFace & BrowserSettingsActions>

/** A tri-state boolean row: inherit / on / off. */
function BooleanRow(props: {
  field: string
  label: string
  hint: string
  state: { overridden: boolean; text: string }
  writable: boolean
  t: CardT
  setBoolean: (field: string, value: boolean) => void
  resetField: (field: string) => void
}): JSX.Element {
  const { field, label, hint, state, writable, t, setBoolean, resetField } = props
  const mode = !state.overridden
    ? 'inherit'
    : state.text === 'true' ? 'on' : state.text === 'false' ? 'off' : 'inherit'
  return (
    <div className={css.row}>
      <div className={css.rowCopy}>
        <span className={css.rowLabel}>{label}</span>
        <span className={css.rowHint}>{hint}</span>
      </div>
      <div className={css.segment} role="group">
        <button
          type="button"
          className={css.segmentButton}
          data-active={mode === 'inherit' ? 'true' : undefined}
          disabled={!writable}
          onClick={() => { resetField(field) }}
        >
          {t('settings.inherit')}
        </button>
        <button
          type="button"
          className={css.segmentButton}
          data-active={mode === 'on' ? 'true' : undefined}
          disabled={!writable}
          onClick={() => { setBoolean(field, true) }}
        >
          {t('settings.on')}
        </button>
        <button
          type="button"
          className={css.segmentButton}
          data-active={mode === 'off' ? 'true' : undefined}
          disabled={!writable}
          onClick={() => { setBoolean(field, false) }}
        >
          {t('settings.off')}
        </button>
      </div>
      {state.overridden ? <span className={css.badge} title={t('settings.overridden')}>{t('settings.overridden')}</span> : null}
    </div>
  )
}

/** A staged text/number row. */
function TextRow(props: {
  field: string
  label: string
  hint: string
  state: { text: string; overridden: boolean; invalid: boolean }
  writable: boolean
  t: CardT
  editText: (field: string, text: string) => void
  resetField: (field: string) => void
}): JSX.Element {
  const { field, label, hint, state, writable, t, editText, resetField } = props
  return (
    <div className={css.row}>
      <div className={css.rowCopy}>
        <span className={css.rowLabel}>{label}</span>
        <span className={css.rowHint}>{hint}</span>
      </div>
      <div className={css.textControl}>
        <input
          className={css.textInput}
          type="text"
          spellCheck={false}
          value={state.text}
          disabled={!writable}
          data-invalid={state.invalid ? 'true' : undefined}
          onChange={(event) => { editText(field, event.target.value) }}
        />
        {state.invalid ? <span className={css.invalidHint}>{t('settings.invalidNumber')}</span> : null}
        {state.overridden ? (
          <button type="button" className={css.resetButton} disabled={!writable} onClick={() => { resetField(field) }}>
            {t('settings.reset')}
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** Simple chevron icon (inline SVG to avoid an icon-package dependency). */
function Chevron({ className }: { className?: string }): JSX.Element {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3.5 5.25L7 8.75L10.5 5.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Render the plugin card as a collapsible disclosure matching the official
 * PluginCard look.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function BrowserSettingsCard(props: BrowserSettingsCardProps): JSX.Element {
  const { t, useBrowserSettingsCard, editText, setBoolean, resetField, save, discard, refresh } = props
  const state = useBrowserSettingsCard(s => s)
  const [open, setOpen] = useState(false)

  // External plugins register their settings namespace after the client's
  // initial settings.describe() has already run, and namespace registration
  // does not emit settings/document-updated. Re-fetch on mount so the card
  // sees the namespace once the host has registered it.
  useEffect(() => { refresh() }, [refresh])

  if (state.status === 'unavailable') {
    return (
      <li className={css.card}>
        <p className={css.notExposed}>{t('settings.notExposed')}</p>
      </li>
    )
  }
  if (state.status === 'loading') {
    return <li className={css.card} />
  }

  const title = t('settings.title')
  const blocked = !state.dirty || state.invalid || state.saving

  return (
    <li className={`${css.card} ${open ? css.cardOpen : ''}`}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${open ? t('settings.collapse') : t('settings.expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{title}</span>
          <span className={css.description}>{t('settings.description')}</span>
        </span>
        {state.dirty ? <span className={css.pending}>{t('settings.unsaved')}</span> : null}
        <Chevron className={`${css.chevron} ${open ? css.chevronOpen : ''}`} />
      </button>
      {open ? (
        <div className={css.body}>
          {state.writable ? null : <p className={css.readOnly}>{t('settings.readOnly')}</p>}

          <BooleanRow
            field="enabled"
            label={t('settings.enabled')}
            hint={t('settings.enabledHint')}
            state={state.fields.enabled}
            writable={state.writable}
            t={t}
            setBoolean={setBoolean}
            resetField={resetField}
          />
          <BooleanRow
            field="announceToAgent"
            label={t('settings.announceToAgent')}
            hint={t('settings.announceToAgentHint')}
            state={state.fields.announceToAgent}
            writable={state.writable}
            t={t}
            setBoolean={setBoolean}
            resetField={resetField}
          />
          <BooleanRow
            field="allowPrivateAccess"
            label={t('settings.allowPrivate')}
            hint={t('settings.allowPrivateHint')}
            state={state.fields.allowPrivateAccess}
            writable={state.writable}
            t={t}
            setBoolean={setBoolean}
            resetField={resetField}
          />
          <TextRow
            field="defaultHome"
            label={t('settings.defaultHome')}
            hint={t('settings.defaultHomeHint')}
            state={state.fields.defaultHome}
            writable={state.writable}
            t={t}
            editText={editText}
            resetField={resetField}
          />
          <TextRow
            field="maxTabs"
            label={t('settings.maxTabs')}
            hint={t('settings.maxTabsHint')}
            state={state.fields.maxTabs}
            writable={state.writable}
            t={t}
            editText={editText}
            resetField={resetField}
          />
          <TextRow
            field="browserExecutable"
            label={t('settings.browserExecutable')}
            hint={t('settings.browserExecutableHint')}
            state={state.fields.browserExecutable}
            writable={state.writable}
            t={t}
            editText={editText}
            resetField={resetField}
          />
          <TextRow
            field="proxyServer"
            label={t('settings.proxyServer')}
            hint={t('settings.proxyServerHint')}
            state={state.fields.proxyServer}
            writable={state.writable}
            t={t}
            editText={editText}
            resetField={resetField}
          />

          <div className={css.footer}>
            {state.failed ? <span className={css.saveFailed}>{t('settings.saveFailed')}</span> : null}
            <button
              type="button"
              className={css.discardButton}
              disabled={!state.dirty || state.saving}
              onClick={discard}
            >
              {t('settings.discard')}
            </button>
            <button
              type="button"
              className={css.saveButton}
              disabled={blocked}
              onClick={save}
            >
              {state.saving ? t('settings.saving') : t('settings.save')}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

/**
 * Module-level form for the Desktop settings.section variant. settings.section
 * does not support the `inject` option, so the registrant stashes the form
 * here and the component reads it directly, subscribing to form.store via
 * useSyncExternalStore.
 */
let desktopForm: BrowserSettingsForm<any> | undefined

/** Called by the client entry when registering the Desktop settings.section. */
export function setDesktopForm(form: BrowserSettingsForm<any>): void {
  desktopForm = form
}

/** Clear on unload to avoid stale state across HMR/re-registration. */
export function clearDesktopForm(): void {
  desktopForm = undefined
}

/**
 * Standalone settings page variant for the Desktop build's settings.section
 * slot. Renders the same staged form directly in a column (no collapsible
 * card chrome), because the section nav already provides the title.
 */
export function BrowserSettingsPage(props: any): JSX.Element {
  const form = desktopForm
  if (form === undefined) {
    return (
      <div className={css.page}>
        <p className={css.notExposed}>表单未初始化</p>
      </div>
    )
  }
  const { t } = props
  const [state, setState] = useState(() => form.store.getSnapshot())

  useEffect(() => {
    const unsubscribe = form.store.subscribe(() => {
      setState(form.store.getSnapshot())
    })
    form.refresh()
    return unsubscribe
  }, [form])

  if (state.status === 'unavailable') {
    return (
      <div className={css.page}>
        <p className={css.notExposed}>{t('settings.notExposed')}</p>
      </div>
    )
  }
  if (state.status === 'loading') {
    return <div className={css.page}><p style={{ color: '#888' }}>加载中...</p></div>
  }

  const renderBoolean = (field: string, labelKey: string, hintKey: string) => {
    const f = state.fields[field]
    const mode = !f.overridden ? 'inherit' : f.text === 'true' ? 'on' : f.text === 'false' ? 'off' : 'inherit'
    return (
      <div className={css.pageField}>
        <span className={css.pageFieldLabel}>{t(labelKey)}</span>
        <div className={css.pageFieldControl}>
          <div className={css.segment} role="group">
            <button type="button" className={css.segmentButton} data-active={mode === 'inherit' ? '' : undefined} disabled={!state.writable} onClick={() => form.resetField(field)}>继承</button>
            <button type="button" className={css.segmentButton} data-active={mode === 'on' ? '' : undefined} disabled={!state.writable} onClick={() => form.setBoolean(field, true)}>开</button>
            <button type="button" className={css.segmentButton} data-active={mode === 'off' ? '' : undefined} disabled={!state.writable} onClick={() => form.setBoolean(field, false)}>关</button>
          </div>
        </div>
        <span className={css.pageFieldHint}>{t(hintKey)}</span>
      </div>
    )
  }

  const renderText = (field: string, labelKey: string, hintKey: string) => {
    const f = state.fields[field]
    return (
      <div className={css.pageField}>
        <span className={css.pageFieldLabel}>{t(labelKey)}</span>
        <div className={css.pageFieldControl}>
          <input
            type="text"
            className={css.textInput}
            value={f.text}
            disabled={!state.writable}
            data-invalid={f.invalid ? '' : undefined}
            onChange={(e) => form.editText(field, e.target.value)}
            style={{ flex: 1, maxWidth: 360 }}
          />
          {f.overridden ? (
            <button type="button" className={css.resetButton} disabled={!state.writable} onClick={() => form.resetField(field)}>恢复默认</button>
          ) : null}
        </div>
        <span className={css.pageFieldHint}>{t(hintKey)}</span>
      </div>
    )
  }

  return (
    <div className={css.page}>
      <h2 className={css.pageTitle}>{t('settings.title')}</h2>
      <p className={css.pageDesc}>配置内置浏览器的运行参数，修改后点击保存生效。</p>

      <div className={css.pageCard}>
        {state.writable ? null : <p className={css.readOnly}>{t('settings.readOnly')}</p>}

        {renderBoolean('enabled', 'settings.enabled', 'settings.enabledHint')}
        {renderBoolean('announceToAgent', 'settings.announceToAgent', 'settings.announceToAgentHint')}
        {renderBoolean('allowPrivateAccess', 'settings.allowPrivate', 'settings.allowPrivateHint')}
        {renderText('defaultHome', 'settings.defaultHome', 'settings.defaultHomeHint')}
        {renderText('maxTabs', 'settings.maxTabs', 'settings.maxTabsHint')}
        {renderText('browserExecutable', 'settings.browserExecutable', 'settings.browserExecutableHint')}
        {renderText('proxyServer', 'settings.proxyServer', 'settings.proxyServerHint')}

        <div className={css.pageFooter}>
          {state.failed ? <span className={css.saveFailed}>{t('settings.saveFailed')}</span> : null}
          <button type="button" className={css.discardButton} disabled={!state.dirty || state.saving} onClick={() => form.discard()}>{t('settings.discard')}</button>
          <button type="button" className={css.saveButton} disabled={!state.dirty || state.invalid || state.saving} onClick={() => { void form.save() }}>{state.saving ? t('settings.saving') : t('settings.save')}</button>
        </div>
      </div>
    </div>
  )
}
