import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  GmLoreSettings,
  LoreDocView,
  LoreEditableView,
  LoreErrorView,
  LoreSectionKey,
  PlayerLoreSettings,
  TeamLoreSettings,
  WorldLoreSettings,
} from '@shared/lore'
import { call } from '../../../api'
import { ErrorBox, Loading, Notice } from '../../../components/ui'
import { useLoad } from '../../../hooks'
import { t } from '../../../i18n'
import { AutoTextarea } from './controls'
import { getDraft, setDraft } from './drafts'
import { GmTab, HooksTab, PlayerTraitsTab, RelationshipsTab, StoryTab, TeamTab, WorldTab, type LoreContext } from './forms'

const tl = t.lore

/** Deep equality for the form's plain data: key order and empty optional keys don't count. */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => same(x, (b as unknown[])[i]))
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined)
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined)
  return ka.length === kb.length && ka.every((k) => same(ra[k], rb[k]))
}

/** Text as the textarea holds it (\n only), for comparing. */
const lf = (s: string) => s.replace(/\r\n?/g, '\n')

/** Raw text back in the file's own line endings and byte order mark. */
function toDisk(text: string, original: string): string {
  let out = lf(text)
  // The file's usual line ending (a file with both keeps the one most of its lines use).
  const crlf = (original.match(/\r\n/g) ?? []).length
  const bare = (original.match(/\n/g) ?? []).length - crlf
  if (crlf > bare) out = out.replace(/\n/g, '\r\n')
  if (original.startsWith('\uFEFF') && !out.startsWith('\uFEFF')) out = `\uFEFF${out}`
  return out
}

const timeOf = (d: Date) => d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
const dateTimeOf = (iso: string) => new Date(iso).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })

export interface EditorHeader {
  title: string
  detail: string
  kindLabel: string
}

/** Loads one file and edits it; remounts when the file changes. */
export function LoreEditor(props: {
  slug: string
  file: string
  /** Where unsaved edits are kept: this league's scope, and draftKeyOf. */
  draftScope: string
  draftKey: string
  header: EditorHeader
  ctx: Omit<LoreContext, 'disabled'>
  /** Shown under the header (the AI draft bar). */
  tools?: ReactNode
  onChanged: () => void
  onRemoved: () => void
}) {
  const doc = useLoad(() => call('lore.open', props.slug, props.file), [props.slug, props.file])
  if (doc.state === 'loading') return <div className="lore-editor-pad"><Loading /></div>
  if (doc.state === 'error') return <div className="lore-editor-pad"><ErrorBox error={doc.error} onRetry={doc.reload} /></div>
  return <EditorBody key={props.file} {...props} initial={doc.value} />
}

type Tab = 'story' | 'traits' | 'relationships' | 'hooks' | 'gm' | 'team' | 'world' | 'raw'
type Message = { tone: 'ok' | 'info' | 'warn' | 'err'; text: string } | null

function EditorBody({
  slug,
  file,
  draftScope,
  draftKey,
  header,
  ctx,
  tools,
  initial,
  onChanged,
  onRemoved,
}: {
  slug: string
  file: string
  draftScope: string
  draftKey: string
  header: EditorHeader
  ctx: Omit<LoreContext, 'disabled'>
  tools?: ReactNode
  initial: LoreDocView
  onChanged: () => void
  onRemoved: () => void
}) {
  const draft0 = useRef(getDraft(draftScope, draftKey)).current
  const [doc, setDoc] = useState(initial)
  const [base, setBase] = useState<LoreEditableView | null>(draft0?.base ?? initial.editable)
  const [form, setForm] = useState<LoreEditableView | null>(draft0?.next ?? initial.editable)
  const [raw, setRaw] = useState(draft0?.raw ?? { version: initial.version, text: initial.text })
  const [resumed, setResumed] = useState(draft0 !== null)
  const [tab, setTab] = useState<Tab>(initial.editable ? 'story' : 'raw')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<Message>(null)
  const [error, setError] = useState<unknown>(null)
  const [conflict, setConflict] = useState<{ fields: string[]; doc: LoreDocView } | null>(null)
  const [rawProblem, setRawProblem] = useState<{ kind: 'changed'; doc: LoreDocView } | { kind: 'invalid'; errors: LoreErrorView[] } | null>(null)
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [history, setHistory] = useState<{ open: boolean; id: string | null; text: string | null }>({ open: false, id: null, text: null })

  const formDirty = form !== null && base !== null && !same(form, base)
  const rawDirty = lf(raw.text) !== lf(doc.text)
  const dirty = formDirty || rawDirty

  // Unsaved edits survive switching files and restarts.
  useEffect(() => {
    setDraft(draftScope, draftKey, dirty ? { base, next: form, raw: rawDirty ? raw : null, at: Date.now() } : null)
  }, [draftScope, draftKey, dirty, base, form, raw, rawDirty])

  // A note about the last save goes once you start editing again.
  useEffect(() => {
    if (dirty) setMessage((m) => (m && (m.tone === 'ok' || m.tone === 'info') ? null : m))
  }, [dirty])

  // Back from another editor (Obsidian, Notepad…): with nothing unsaved here, show the file as it is now.
  const quiet = useRef({ dirty, saving, version: doc.version })
  quiet.current = { dirty, saving, version: doc.version }
  useEffect(() => {
    const onFocus = () => {
      if (quiet.current.dirty || quiet.current.saving) return
      call('lore.open', slug, file).then(
        (d) => {
          if (quiet.current.dirty || quiet.current.saving || d.version === quiet.current.version) return
          settle(d)
          setMessage({ tone: 'info', text: tl.reloaded })
        },
        () => {},
      )
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [slug, file])

  const settle = (d: LoreDocView) => {
    setDoc(d)
    setBase(d.editable)
    setForm(d.editable)
    setRaw({ version: d.version, text: d.text })
    setResumed(false)
    setConflict(null)
    setRawProblem(null)
    if (!d.editable) setTab('raw')
  }

  const run = async (work: () => Promise<void>) => {
    if (saving) return
    setSaving(true)
    setMessage(null)
    setError(null)
    try {
      await work()
    } catch (e) {
      setError(e)
    } finally {
      setSaving(false)
    }
  }

  const saveForm = (from: LoreEditableView, overwrite = false) =>
    run(async () => {
      if (!form) return
      const r = await call('lore.save', slug, { mode: 'form', file, base: from, next: form, overwrite })
      if (r.status === 'saved' || r.status === 'unchanged') {
        settle(r.doc)
        setSavedAt(new Date())
        setMessage({ tone: r.status === 'saved' && r.merged ? 'info' : 'ok', text: r.status === 'unchanged' ? tl.unchanged : r.merged ? tl.merged : tl.savedNote })
        onChanged()
      } else if (r.status === 'conflict') {
        setConflict({ fields: r.fields, doc: r.doc })
      } else if (r.status === 'gone') {
        setMessage({ tone: 'err', text: tl.gone })
        onChanged()
      } else if (r.status === 'error') {
        setMessage({ tone: 'err', text: tl.saveErrors[r.code] ?? r.code })
      }
    })

  const saveRaw = (version: string, force: boolean) =>
    run(async () => {
      const r = await call('lore.save', slug, { mode: 'raw', file, version, text: toDisk(raw.text, doc.text), force })
      if (r.status === 'saved' || r.status === 'unchanged') {
        settle(r.doc)
        setSavedAt(new Date())
        setMessage({ tone: 'ok', text: r.status === 'unchanged' ? tl.unchanged : tl.savedNote })
        onChanged()
      } else if (r.status === 'changed') setRawProblem({ kind: 'changed', doc: r.doc })
      else if (r.status === 'invalid') setRawProblem({ kind: 'invalid', errors: r.errors })
      else if (r.status === 'gone') {
        setMessage({ tone: 'err', text: tl.gone })
        onChanged()
      }
    })

  const save = () => {
    if (!doc.utf8) return
    if (rawDirty) return void saveRaw(raw.version, false)
    if (formDirty && base) return void saveForm(base)
  }
  const discard = () => {
    if (dirty && !window.confirm(tl.confirmDiscard)) return
    settle(doc)
    setMessage(null)
  }

  // Ctrl+S saves from anywhere on the screen.
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        saveRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const openBackup = async (id: string) => {
    setError(null)
    try {
      const { text } = await call('lore.backupText', slug, file, id)
      setHistory({ open: true, id, text })
    } catch (e) {
      setError(e)
    }
  }
  const restore = (id: string) => {
    if (!window.confirm(dirty ? tl.confirmRestoreDirty : tl.confirmRestore)) return
    void run(async () => {
      const d = await call('lore.restore', slug, file, id)
      settle(d)
      setSavedAt(new Date())
      setHistory({ open: false, id: null, text: null })
      setMessage({ tone: 'ok', text: tl.savedNote })
      onChanged()
    })
  }
  const remove = () => {
    if (!window.confirm(tl.confirmRemove(file))) return
    void run(async () => {
      await call('lore.remove', slug, file)
      setDraft(draftScope, draftKey, null)
      onRemoved()
    })
  }
  const reveal = () => void call('lore.reveal', slug, file).catch(setError)

  // ── The form, per kind ────────────────────────────────────────────────

  const formCtx: LoreContext = { ...ctx, disabled: rawDirty || saving }
  const editSettings = <S,>(f: (s: S) => void) =>
    setForm((cur) => {
      if (!cur) return cur
      const next = structuredClone(cur)
      f(next.settings as S)
      return next
    })
  const setSection = (key: LoreSectionKey, text: string) => setForm((cur) => (cur ? { ...cur, sections: { ...cur.sections, [key]: text } } : cur))

  const tabs: { id: Tab; label: string; count?: number }[] = []
  if (form) {
    tabs.push({ id: 'story', label: tl.tabs.story! })
    if (form.kind === 'player') {
      tabs.push({ id: 'traits', label: tl.tabs.traits! })
      tabs.push({ id: 'relationships', label: tl.tabs.relationships!, count: form.settings.relationships.length })
      tabs.push({ id: 'hooks', label: tl.tabs.hooks!, count: form.settings.hooks.length })
    } else if (form.kind === 'gm') {
      tabs.push({ id: 'gm', label: tl.tabs.gm! })
      tabs.push({ id: 'relationships', label: tl.tabs.relationships!, count: form.settings.relationships.length })
    } else if (form.kind === 'team') tabs.push({ id: 'team', label: tl.tabs.team! })
    else tabs.push({ id: 'world', label: tl.tabs.world! })
  }
  tabs.push({ id: 'raw', label: tl.tabs.raw! })
  const current = tabs.some((x) => x.id === tab) ? tab : 'raw'

  const body = () => {
    if (current === 'raw' || !form) {
      return (
        <div className="lore-tab">
          {!form ? <Notice tone="warn">{tl.noForm}</Notice> : null}
          {formDirty ? <Notice tone="info">{tl.rawLocked}</Notice> : <p className="help">{tl.rawIntro}</p>}
          {doc.errors.length > 0 && !rawDirty ? <ProblemList errors={doc.errors} /> : null}
          {rawProblem?.kind === 'invalid' ? (
            <Notice tone="warn">
              <div className="stack">
                <b>{tl.rawInvalid}</b>
                <ProblemList errors={rawProblem.errors} />
                <div className="row">
                  <button type="button" className="btn small" onClick={() => void saveRaw(raw.version, true)}>
                    {tl.rawForce}
                  </button>
                </div>
              </div>
            </Notice>
          ) : null}
          {rawProblem?.kind === 'changed' ? (
            <Notice tone="warn">
              <div className="stack">
                <b>{tl.rawChanged}</b>
                <div className="row">
                  <button type="button" className="btn small primary" onClick={() => void saveRaw(rawProblem.doc.version, false)}>
                    {tl.rawOverwrite}
                  </button>
                  <button type="button" className="btn small" onClick={() => settle(rawProblem.doc)}>
                    {tl.rawReload}
                  </button>
                </div>
              </div>
            </Notice>
          ) : null}
          <AutoTextarea mono value={raw.text} ariaLabel={tl.tabs.raw} minRows={20} readOnly={formDirty || saving} onChange={(text) => setRaw((r) => ({ ...r, text }))} />
        </div>
      )
    }
    if (current === 'story') {
      return (
        <StoryTab
          kind={form.kind}
          sections={form.sections}
          canon={form.settings.canon}
          split={doc.splitSections}
          disabled={formCtx.disabled}
          onSection={setSection}
          onCanon={(canon) => editSettings<{ canon: boolean }>((s) => void (s.canon = canon))}
        />
      )
    }
    if (form.kind === 'player' && current === 'traits') return <PlayerTraitsTab value={form.settings} edit={editSettings<PlayerLoreSettings>} disabled={formCtx.disabled} />
    if ((form.kind === 'player' || form.kind === 'gm') && current === 'relationships') {
      return (
        <RelationshipsTab
          kind={form.kind}
          value={form.settings.relationships}
          ctx={formCtx}
          onChange={(v) => editSettings<{ relationships: typeof v }>((s) => void (s.relationships = v))}
        />
      )
    }
    if (form.kind === 'player' && current === 'hooks') {
      const rivals = form.settings.relationships.filter((r) => r.type === 'rival' || r.type === 'dislikes').map((r) => r.with)
      return <HooksTab value={form.settings.hooks} rivals={rivals} ctx={formCtx} onChange={(v) => editSettings<PlayerLoreSettings>((s) => void (s.hooks = v))} />
    }
    if (form.kind === 'gm' && current === 'gm') return <GmTab value={form.settings} edit={editSettings<GmLoreSettings>} disabled={formCtx.disabled} />
    if (form.kind === 'team' && current === 'team') return <TeamTab value={form.settings} edit={editSettings<TeamLoreSettings>} ctx={formCtx} />
    if (form.kind === 'world' && current === 'world') return <WorldTab value={form.settings} edit={editSettings<WorldLoreSettings>} ctx={formCtx} />
    return null
  }

  const status = saving ? tl.status.saving : dirty ? tl.status.dirty : savedAt ? tl.status.savedAt(timeOf(savedAt)) : tl.status.saved

  return (
    <div className="lore-editor">
      <header className="lore-editor-head">
        <div className="lore-editor-title">
          <span className="lore-kind">{header.kindLabel}</span>
          <h2>{header.title}</h2>
          {header.detail ? <span className="lore-editor-detail">{header.detail}</span> : null}
        </div>
        <div className="lore-editor-actions">
          <span className={`lore-status${dirty ? ' dirty' : ''}${saving ? ' saving' : ''}`} role="status">
            {status}
          </span>
          <button type="button" className="btn small ghost" disabled={!dirty || saving} onClick={discard}>
            {tl.discard}
          </button>
          <button type="button" className="btn small primary" disabled={!dirty || saving || !doc.utf8} title={tl.saveHint} onClick={save}>
            {tl.save}
            <kbd>{tl.saveHint}</kbd>
          </button>
        </div>
        <div className="lore-editor-meta">
          <code>{file}</code>
          <button type="button" className="link" onClick={reveal}>
            {tl.reveal}
          </button>
          <button type="button" className="link" aria-expanded={history.open} onClick={() => setHistory((h) => ({ ...h, open: !h.open }))}>
            {tl.history(doc.backups.length)}
          </button>
          <button type="button" className="link danger" onClick={remove}>
            {tl.remove}
          </button>
        </div>
        <nav className="lore-tabs" role="tablist">
          {tabs.map((x) => (
            <button key={x.id} type="button" role="tab" aria-selected={current === x.id} className={current === x.id ? 'on' : ''} onClick={() => setTab(x.id)}>
              {x.label}
              {x.count ? <span className="lore-tab-count">{x.count}</span> : null}
            </button>
          ))}
        </nav>
      </header>
      {tools ? <div className="lore-editor-tools">{tools}</div> : null}

      {history.open ? (
        <div className="lore-history">
          <div className="lore-history-list">
            <b>{tl.historyTitle}</b>
            <p className="help">{tl.historyHelp}</p>
            {doc.backups.length === 0 ? <p className="lore-empty">{tl.historyEmpty}</p> : null}
            <ul>
              {doc.backups.map((b) => (
                <li key={b.id} className={history.id === b.id ? 'on' : ''}>
                  <button type="button" onClick={() => void openBackup(b.id)}>
                    {dateTimeOf(b.at)} <span className="muted">{tl.bytes(b.size)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {history.text !== null && history.id ? (
            <div className="lore-history-preview">
              <div className="row">
                <button type="button" className="btn small primary" disabled={saving} onClick={() => restore(history.id!)}>
                  {tl.restore}
                </button>
                <button type="button" className="btn small ghost" onClick={() => setHistory({ open: true, id: null, text: null })}>
                  {tl.close}
                </button>
              </div>
              <pre>{history.text}</pre>
            </div>
          ) : null}
        </div>
      ) : null}


      <div className="lore-editor-body">
        {resumed && dirty ? (
          <Notice tone="info">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span>{tl.resumed}</span>
              <button type="button" className="btn small ghost" onClick={discard}>
                {tl.discard}
              </button>
            </div>
          </Notice>
        ) : null}
        {conflict ? (
          <Notice tone="warn">
            <div className="stack">
              <b>{tl.conflictTitle}</b>
              <span>{tl.conflictBody(conflict.fields.map((f) => tl.fieldNames[f] ?? f).join(', '))}</span>
              <div className="row">
                <button
                  type="button"
                  className="btn small primary"
                  onClick={() => {
                    // Mine wins only where both changed; everything else changed elsewhere is kept.
                    setConflict(null)
                    if (base) void saveForm(base, true)
                  }}
                >
                  {tl.conflictMine}
                </button>
                <button type="button" className="btn small" onClick={() => settle(conflict.doc)}>
                  {tl.conflictTheirs}
                </button>
              </div>
            </div>
          </Notice>
        ) : null}
        {!doc.utf8 ? <Notice tone="err">{tl.notUtf8}</Notice> : null}
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
        {error ? <ErrorBox error={error} /> : null}
        {rawDirty && current !== 'raw' && form ? <Notice tone="info">{tl.formLocked}</Notice> : null}
        {body()}
      </div>
    </div>
  )
}

export function ProblemList({ errors }: { errors: LoreErrorView[] }) {
  return (
    <ul className="lore-errors">
      {errors.map((e, i) => (
        <li key={i} title={e.message}>
          <code>{tl.errorAt(e.file, e.line)}</code> {e.code === 'field' ? tl.errorText.field(e.field ?? '') : tl.errorText[e.code]}
          {(e.code === 'yaml' || e.code === 'field') && e.message ? <span className="lore-detail">{e.message}</span> : null}
        </li>
      ))}
    </ul>
  )
}

