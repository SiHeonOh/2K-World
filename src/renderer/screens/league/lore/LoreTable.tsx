import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { LeagueSnapshot } from '@shared/league'
import {
  GM_TRAITS,
  MEDIA_STYLES,
  NEGOTIATION_STYLES,
  PHILOSOPHIES,
  PLAYER_TRAITS,
  type GmLoreSettings,
  type LoreCreateTarget,
  type LoreEditableView,
  type LoreTableRow,
  type LoreTableView,
  type PlayerLoreSettings,
  type TeamLoreSettings,
} from '@shared/lore'
import { call } from '../../../api'
import { ErrorBox, Loading, Notice } from '../../../components/ui'
import { useLoad } from '../../../hooks'
import { t } from '../../../i18n'
import { getDraft, setDraft } from './drafts'

const tl = t.lore
export type TableKind = 'players' | 'gms' | 'schools'
const KINDS: TableKind[] = ['players', 'gms', 'schools']
const ROW_KIND: Record<TableKind, LoreTableRow['kind']> = { players: 'player', gms: 'gm', schools: 'team' }

const draftKeyOfRow = (r: LoreTableRow) => (r.kind === 'player' ? `player:${r.playerId}` : `${r.kind}:${r.teamId}`)
const all3 = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 3])) as Record<K, number>

/** What a file that doesn't exist yet would hold: the parser's defaults (the template's start). */
function blankEditable(row: LoreTableRow, league: LeagueSnapshot): LoreEditableView {
  const sections = { public: '', rumor: '', secret: '' }
  const team = league.teams.find((x) => x.id === row.teamId)
  const school = team?.shortName ?? row.teamId
  if (row.kind === 'player') {
    const name = league.players.find((p) => p.id === row.playerId)?.name ?? ''
    return { kind: 'player', settings: { id: name, traits: all3(PLAYER_TRAITS), media: 'normal', relationships: [], hooks: [], canon: true }, sections }
  }
  if (row.kind === 'gm') {
    return {
      kind: 'gm',
      settings: { id: `${school} 단장`, name: null, team: school, philosophy: 'balanced', traits: all3(GM_TRAITS), negotiation: 'fair', relationships: [], canon: true },
      sections,
    }
  }
  return { kind: 'team', settings: { id: school, colors: [], fans: { size: 3, temperament: 3, pride: 3 }, rivals: [], canon: true }, sections }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Many files' settings on one screen: players' traits, GMs' profiles, schools' fan culture. */
export function LoreTable({
  slug,
  league,
  kind,
  team,
  onKind,
  onTeam,
  onOpen,
  onClose,
}: {
  slug: string
  league: LeagueSnapshot
  kind: TableKind
  team: string
  onKind: (k: TableKind) => void
  onTeam: (teamId: string) => void
  onOpen: (row: LoreTableRow) => void
  onClose: () => void
}) {
  const data = useLoad(() => call('lore.table', slug), [slug], { keepPrevious: true })
  const [loads, setLoads] = useState(0)
  // Kept out here: the table below starts over after a save, the message about it shouldn't.
  const [result, setResult] = useState<SaveResult | null>(null)
  if (data.state === 'loading') return <div className="page"><Loading /></div>
  if (data.state === 'error') return <div className="page"><ErrorBox error={data.error} onRetry={data.reload} /></div>
  return (
    <TableBody
      key={loads}
      slug={slug}
      league={league}
      view={data.value}
      kind={kind}
      team={team}
      onKind={onKind}
      onTeam={onTeam}
      onOpen={onOpen}
      onClose={onClose}
      result={result}
      onResult={setResult}
      onReload={() => {
        data.reload()
        setLoads((n) => n + 1)
      }}
    />
  )
}

interface SaveResult {
  saved: number
  problems: string[]
}

interface Edit {
  base: LoreEditableView
  next: LoreEditableView
}

function TableBody({
  slug,
  league,
  view,
  kind,
  team,
  onKind,
  onTeam,
  onOpen,
  onClose,
  onReload,
  result,
  onResult,
}: {
  slug: string
  league: LeagueSnapshot
  view: LoreTableView
  kind: TableKind
  team: string
  onKind: (k: TableKind) => void
  onTeam: (teamId: string) => void
  onOpen: (row: LoreTableRow) => void
  onClose: () => void
  onReload: () => void
  result: SaveResult | null
  onResult: (r: SaveResult | null) => void
}) {
  const scope = view.draftScope
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<unknown>(null)
  // Each row's starting point and edits: from its draft (the editor's too), else the file.
  const [edits, setEdits] = useState<Map<string, Edit>>(() => {
    const m = new Map<string, Edit>()
    for (const r of view.rows) {
      const d = getDraft(scope, draftKeyOfRow(r))
      const start = r.editable ?? blankEditable(r, league)
      m.set(draftKeyOfRow(r), { base: d?.base ?? start, next: d?.next ?? start })
    }
    return m
  })
  const school = useMemo(() => new Map(league.teams.map((x) => [x.id, x.shortName])), [league])
  const slotName = useMemo(() => new Map(league.config.roster.slots.map((s) => [s.id, s.name])), [league])
  const slotOrder = useMemo(() => new Map(league.config.roster.slots.map((s, i) => [s.id, i])), [league])
  const teamOrder = useMemo(() => new Map(league.teams.map((x, i) => [x.id, i])), [league])
  const playerOf = useMemo(() => new Map(league.players.map((p) => [p.id, p])), [league])

  const rows = view.rows
    .filter((r) => r.kind === ROW_KIND[kind] && (team === '' || r.teamId === team))
    .filter((r) => {
      const q = query.trim().normalize('NFC').toLowerCase()
      if (!q) return true
      const name = r.kind === 'player' ? (playerOf.get(r.playerId!)?.name ?? '') : (school.get(r.teamId) ?? '')
      return `${name} ${school.get(r.teamId) ?? ''}`.normalize('NFC').toLowerCase().includes(q)
    })
    .sort((a, b) => {
      const ta = teamOrder.get(a.teamId) ?? 0
      const tb = teamOrder.get(b.teamId) ?? 0
      if (ta !== tb || a.kind !== 'player') return ta - tb
      const pa = playerOf.get(a.playerId!)
      const pb = playerOf.get(b.playerId!)
      return (slotOrder.get(pa?.slotId ?? '') ?? 99) - (slotOrder.get(pb?.slotId ?? '') ?? 99)
    })

  const dirtyKeys = [...edits].filter(([, e]) => !same(e.base, e.next)).map(([k]) => k)
  const rawBusy = (key: string) => getDraft(scope, key)?.raw != null
  const disabled = saving !== null

  const change = (row: LoreTableRow, f: (s: Record<string, unknown>) => void) => {
    const key = draftKeyOfRow(row)
    const e = edits.get(key)!
    const next = structuredClone(e.next)
    f(next.settings as unknown as Record<string, unknown>)
    setEdits(new Map(edits).set(key, { base: e.base, next }))
    // The same drafts the editor uses: an edit here shows there, unsaved, and the other way round.
    setDraft(scope, key, same(e.base, next) ? null : { base: e.base, next, raw: null, at: Date.now() })
  }

  const targetOf = (r: LoreTableRow): LoreCreateTarget =>
    r.kind === 'player' ? { kind: 'player', playerId: r.playerId! } : r.kind === 'gm' ? { kind: 'gm', teamId: r.teamId } : { kind: 'team', teamId: r.teamId }

  /** Saves every changed row, one file at a time; a file that isn't there yet is made first. */
  const saveAll = async () => {
    const todo = view.rows.filter((r) => dirtyKeys.includes(draftKeyOfRow(r)) && !r.broken && !rawBusy(draftKeyOfRow(r)))
    if (todo.length === 0) return
    setSaving({ done: 0, total: todo.length })
    onResult(null)
    setError(null)
    let saved = 0
    const problems: string[] = []
    try {
      for (const [i, r] of todo.entries()) {
        const key = draftKeyOfRow(r)
        const e = edits.get(key)!
        const label = labelOf(r)
        let file = r.file
        if (!file) file = (await call('lore.create', slug, targetOf(r))).file
        const res = await call('lore.save', slug, { mode: 'form', file, base: e.base, next: e.next })
        if (res.status === 'saved' || res.status === 'unchanged') {
          setDraft(scope, key, null)
          saved++
        } else if (res.status === 'conflict') problems.push(tl.tableConflict(label))
        else if (res.status === 'error') problems.push(`${label}: ${tl.saveErrors[res.code] ?? res.code}`)
        else problems.push(`${label}: ${tl.gone}`)
        setSaving({ done: i + 1, total: todo.length })
      }
    } catch (e) {
      setError(e)
    }
    setSaving(null)
    onResult({ saved, problems })
    onReload()
  }

  const discardAll = () => {
    if (!window.confirm(tl.tableConfirmDiscard(dirtyKeys.length))) return
    for (const k of dirtyKeys) setDraft(scope, k, null)
    setEdits((m) => {
      const out = new Map(m)
      for (const k of dirtyKeys) out.set(k, { base: m.get(k)!.base, next: m.get(k)!.base })
      return out
    })
  }

  function labelOf(r: LoreTableRow): string {
    if (r.kind === 'player') return playerOf.get(r.playerId!)?.name ?? r.playerId!
    return r.kind === 'gm' ? tl.gmOf(school.get(r.teamId) ?? '') : (school.get(r.teamId) ?? r.teamId)
  }

  // Arrow keys move between cells, like a spreadsheet.
  const grid = useRef<HTMLTableElement>(null)
  const moveFocus = (e: KeyboardEvent, row: number, col: number) => {
    const d = e.key === 'ArrowDown' ? [1, 0] : e.key === 'ArrowUp' ? [-1, 0] : null
    if (!d) return false
    e.preventDefault()
    grid.current?.querySelector<HTMLElement>(`[data-cell="${row + d[0]!}:${col + d[1]!}"]`)?.focus()
    return true
  }

  const traitKeys = kind === 'players' ? PLAYER_TRAITS : kind === 'gms' ? GM_TRAITS : (['size', 'temperament', 'pride'] as const)
  const traitInfo = kind === 'players' ? tl.playerTraits : kind === 'gms' ? tl.gmTraits : tl.fanTraits

  return (
    <div className="lore-table-page">
      <div className="lore-table-head">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="row">
            <button type="button" className="btn small ghost" onClick={onClose}>
              ← {tl.backToList}
            </button>
            <h1>{tl.tables[kind]}</h1>
          </div>
          <div className="row">
            {dirtyKeys.length > 0 ? <span className="lore-status dirty">{tl.tableDirty(dirtyKeys.length)}</span> : <span className="lore-status">{tl.status.saved}</span>}
            <button type="button" className="btn small ghost" disabled={disabled || dirtyKeys.length === 0} onClick={discardAll}>
              {tl.discard}
            </button>
            <button type="button" className="btn small primary" disabled={disabled || dirtyKeys.length === 0} onClick={() => void saveAll()}>
              {saving ? tl.tableSaving(saving.done, saving.total) : tl.tableSaveAll(dirtyKeys.length)}
            </button>
          </div>
        </div>
        <p className="help">{tl.tableIntro[kind]}</p>
        <div className="row">
          <div className="segmented" role="radiogroup" aria-label={tl.tablesTitle}>
            {KINDS.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => onKind(k)}>
                {tl.tables[k]}
              </button>
            ))}
          </div>
          <select className="compact" aria-label={tl.tableSchool} value={team} onChange={(e) => onTeam(e.target.value)}>
            <option value="">{tl.tableAllSchools}</option>
            {league.teams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.shortName}
              </option>
            ))}
          </select>
          <input type="search" className="lore-search narrow" value={query} placeholder={tl.search} aria-label={tl.search} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {result ? (
          <Notice tone={result.problems.length ? 'warn' : 'ok'}>
            <div className="stack">
              <span>{tl.tableSaved(result.saved)}</span>
              {result.problems.map((p) => (
                <span key={p}>{p}</span>
              ))}
            </div>
          </Notice>
        ) : null}
        {error ? <ErrorBox error={error} /> : null}
      </div>

      <div className="lore-table-wrap">
        <table className="lore-grid" ref={grid}>
          <thead>
            <tr>
              <th className="sticky">{kind === 'players' ? tl.tableWho.player : kind === 'gms' ? tl.tableWho.gm : tl.tableWho.team}</th>
              {kind === 'gms' ? (
                <>
                  <th>{tl.gmName}</th>
                  <th>{tl.philosophy}</th>
                  <th>{tl.negotiation}</th>
                </>
              ) : null}
              {traitKeys.map((k) => (
                <th key={k} title={`${traitInfo[k]?.help ?? ''}\n1 ${traitInfo[k]?.low ?? ''} ↔ 5 ${traitInfo[k]?.high ?? ''}`}>
                  {traitInfo[k]?.name ?? k}
                </th>
              ))}
              {kind === 'players' ? <th>{tl.media}</th> : null}
              <th title={tl.canonHelp}>{tl.tableCanon}</th>
              <th>{tl.tabs.story}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => {
              const key = draftKeyOfRow(r)
              const e = edits.get(key)!
              const s = e.next.settings as unknown as Record<string, unknown>
              const b = e.base.settings as unknown as Record<string, unknown>
              const traits = (kind === 'schools' ? s.fans : s.traits) as Record<string, number>
              const baseTraits = (kind === 'schools' ? b.fans : b.traits) as Record<string, number>
              const locked = disabled || r.broken || rawBusy(key)
              const p = r.playerId ? playerOf.get(r.playerId) : undefined
              let col = 0
              return (
                <tr key={key} className={`${!same(e.base, e.next) ? 'dirty' : ''}${r.file === null ? ' nofile' : ''}`}>
                  <th className="sticky who" scope="row">
                    <button type="button" className="lore-grid-name" onClick={() => onOpen(r)} title={tl.tableOpen}>
                      <b>{labelOf(r)}</b>
                      <span className="muted">
                        {[team === '' && r.kind === 'player' ? school.get(r.teamId) : null, p?.slotId ? slotName.get(p.slotId) : null].filter(Boolean).join(' · ')}
                      </span>
                    </button>
                    {r.broken ? <span className="lore-grid-note err">{tl.tableBroken}</span> : r.file === null ? <span className="lore-grid-note">{tl.noFile}</span> : null}
                    {rawBusy(key) ? <span className="lore-grid-note">{tl.tableRawBusy}</span> : null}
                  </th>
                  {kind === 'gms' ? (
                    <>
                      <td className={s.name !== b.name ? 'changed' : ''}>
                        <input
                          type="text"
                          className="compact"
                          value={(s.name as string | null) ?? ''}
                          placeholder={tl.gmNamePlaceholder}
                          aria-label={`${labelOf(r)} ${tl.gmName}`}
                          maxLength={40}
                          disabled={locked}
                          data-cell={`${ri}:${col++}`}
                          onKeyDown={(ev) => moveFocus(ev, ri, col - 1)}
                          onChange={(ev) => change(r, (x) => void (x.name = ev.target.value.trim() === '' ? null : ev.target.value))}
                        />
                      </td>
                      <td className={s.philosophy !== b.philosophy ? 'changed' : ''}>
                        <select
                          className="compact"
                          value={s.philosophy as string}
                          aria-label={`${labelOf(r)} ${tl.philosophy}`}
                          disabled={locked}
                          onChange={(ev) => change(r, (x) => void (x.philosophy = ev.target.value as GmLoreSettings['philosophy']))}
                        >
                          {PHILOSOPHIES.map((v) => (
                            <option key={v} value={v}>
                              {tl.philosophies[v]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className={s.negotiation !== b.negotiation ? 'changed' : ''}>
                        <select
                          className="compact"
                          value={s.negotiation as string}
                          aria-label={`${labelOf(r)} ${tl.negotiation}`}
                          disabled={locked}
                          onChange={(ev) => change(r, (x) => void (x.negotiation = ev.target.value as GmLoreSettings['negotiation']))}
                        >
                          {NEGOTIATION_STYLES.map((v) => (
                            <option key={v} value={v}>
                              {tl.negotiationStyles[v]}
                            </option>
                          ))}
                        </select>
                      </td>
                    </>
                  ) : null}
                  {traitKeys.map((k) => {
                    const c = col++
                    return (
                      <td key={k} className={traits[k] !== baseTraits[k] ? 'changed' : ''}>
                        <MiniScale
                          value={traits[k] ?? 3}
                          label={`${labelOf(r)} ${traitInfo[k]?.name ?? k}`}
                          cell={`${ri}:${c}`}
                          disabled={locked}
                          onMove={(ev) => moveFocus(ev, ri, c)}
                          onChange={(v) =>
                            change(r, (x) => {
                              const target = (kind === 'schools' ? x.fans : x.traits) as Record<string, number>
                              target[k] = v
                            })
                          }
                        />
                      </td>
                    )
                  })}
                  {kind === 'players' ? (
                    <td className={s.media !== b.media ? 'changed' : ''}>
                      <select
                        className="compact"
                        value={s.media as string}
                        aria-label={`${labelOf(r)} ${tl.media}`}
                        disabled={locked}
                        onChange={(ev) => change(r, (x) => void (x.media = ev.target.value as PlayerLoreSettings['media']))}
                      >
                        {MEDIA_STYLES.map((v) => (
                          <option key={v} value={v}>
                            {tl.mediaStyles[v]}
                          </option>
                        ))}
                      </select>
                    </td>
                  ) : null}
                  <td className={s.canon !== b.canon ? 'changed center' : 'center'}>
                    <input
                      type="checkbox"
                      checked={!(s.canon as boolean)}
                      aria-label={`${labelOf(r)} ${tl.tableCanon}`}
                      disabled={locked}
                      onChange={(ev) => change(r, (x) => void ((x as unknown as TeamLoreSettings).canon = !ev.target.checked))}
                    />
                  </td>
                  <td>
                    <button type="button" className="lore-grid-story" onClick={() => onOpen(r)} title={tl.tableOpen}>
                      {(['public', 'rumor', 'secret'] as const).map((sec) => (
                        <span key={sec} className={`lore-dot ${sec}${r.sizes && r.sizes[sec] > 0 ? ' filled' : ''}`} />
                      ))}
                      <span className="muted">{tl.tableEdit}</span>
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {rows.length === 0 ? <p className="lore-empty pad">{tl.noMatch}</p> : null}
      </div>
    </div>
  )
}

/**
 * A 1–5 value as five small steps: click a step, or focus it and type 1–5;
 * ←/→ change it by one, ↑/↓ go to the row above or below.
 */
function MiniScale({
  value,
  label,
  cell,
  disabled,
  onChange,
  onMove,
}: {
  value: number
  label: string
  cell: string
  disabled: boolean
  onChange: (v: number) => void
  onMove: (e: KeyboardEvent) => boolean
}) {
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || onMove(e)) return
    if (/^[1-5]$/.test(e.key)) {
      e.preventDefault()
      if (Number(e.key) !== value) onChange(Number(e.key))
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const v = Math.min(5, Math.max(1, value + (e.key === 'ArrowRight' ? 1 : -1)))
      if (v !== value) onChange(v)
    }
  }
  return (
    <div
      className={`lore-mini${disabled ? ' disabled' : ''}`}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={1}
      aria-valuemax={5}
      aria-valuenow={value}
      data-cell={cell}
      onKeyDown={key}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          className={`step${n <= value ? ' filled' : ''}${n === value ? ' on' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault()
            if (disabled) return
            ;(e.currentTarget.parentElement as HTMLElement).focus()
            if (n !== value) onChange(n)
          }}
        />
      ))}
      <span className="num">{value}</span>
    </div>
  )
}
