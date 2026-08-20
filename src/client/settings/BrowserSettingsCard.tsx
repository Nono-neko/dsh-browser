/**
 * The plugin settings card: registers into the official Plugins section's
 * `settings.plugin.item` slot (declared at runtime by dsh's settings-plugins
 * shell) and renders the staged form over the `dsh-browser` settings
 * namespace. The slot type is declared here with the shell's shape so this
 * standalone package can register without depending on the shell package.
 * @module dsh-browser/client/settings/BrowserSettingsCard
 */

import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserSettingsActions, CardState } from './card-form.ts'
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

/**
 * Render the plugin card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function BrowserSettingsCard(props: BrowserSettingsCardProps): JSX.Element {
  const { t, useBrowserSettingsCard, editText, setBoolean, resetField, save, discard } = props
  const state = useBrowserSettingsCard(s => s)

  if (state.status === 'unavailable') {
    return (
      <div className={css.card}>
        <p className={css.notExposed}>{t('settings.notExposed')}</p>
      </div>
    )
  }
  if (state.status === 'loading') {
    return <div className={css.card} />
  }

  return (
    <div className={css.card}>
      <div className={css.header}>
        <div className={css.headerCopy}>
          <h3 className={css.title}>{t('settings.title')}</h3>
          <p className={css.description}>{t('settings.description')}</p>
        </div>
        {state.dirty ? <span className={css.pending}>{t('settings.unsaved')}</span> : null}
      </div>

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

      {state.dirty || state.saving || state.failed ? (
        <div className={css.footer}>
          {state.failed ? <span className={css.saveFailed}>{t('settings.saveFailed')}</span> : null}
          <button
            type="button"
            className={css.discardButton}
            disabled={state.saving}
            onClick={discard}
          >
            {t('settings.discard')}
          </button>
          <button
            type="button"
            className={css.saveButton}
            disabled={state.saving || state.invalid || !state.writable}
            onClick={save}
          >
            {state.saving ? t('settings.saving') : t('settings.save')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
