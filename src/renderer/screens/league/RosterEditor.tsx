import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import type { PlayerRow } from '@shared/league'
import { rosterProblems, type PlayerEdit, type RosterSaveResult } from '@shared/roster'
import { parseHeightCm } from '@shared/height'
import { ratingShort } from '@shared/labels'
import { folderKey, isFolderSafe } from '@shared/setup'
import { call } from '../../api'
import { IssueList, Notice } from '../../components/ui'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { RuleErrors, ruleText } from './RuleErrors'

const tr = t.roster

/** A player's facts as the inputs hold them (text), so half-typed values don't get lost. Slot '' is none. */
interface Row {
  slot: string
  name: string
  height: string
  nicknames: string
  notes: string
  ratings: Record<string, string>
}

const toRow = (p: PlayerRow): Row => ({
  slot: p.slotId ?? '',
  name: p.name,
  height: p.height,
  nicknames: p.nicknames.join(', '),
  notes: p.notes,
  ratings: Object.fromEntries(Object.entries(p.ratings).map(([k, v]) => [k, v === null ? '' : String(v)])),
})

const splitNicknames = (s: string) =>
  s
    .split(/[,，]/)
    .map((n) => n.trim())
    .filter(Boolean)

// ── Unsaved edits: only the fields you changed, per league season, in memory and localStorage ──

/** What you changed for one player; everything else shows (and saves) as the league has it. */
type Changes = Partial<Omit<Row, 'ratings'>> & { ratings?: Record<string, string> }

const STORE = 'twok.rosterDrafts.v2'
const memory = new Map<string, Record<string, Changes>>()
const readDrafts = (scope: string): Record<string, Changes> => {
  if (!memory.has(scope)) {
    try {
      memory.set(scope, (JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, Record<string, Changes>>)[scope] ?? {})
    } catch {
      memory.set(scope, {})
    }
  }
  return memory.get(scope)!
}
const writeDrafts = (scope: string, drafts: Record<string, Changes>) => {
  memory.set(scope, drafts)
  try {
    const all = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, Record<string, Changes>>
    // Drafts from this league's earlier seasons are stale: they go.
    const league = scope.split('|')[0]
    for (const k of Object.keys(all)) if (k.split('|')[0] === league && k !== scope) delete all[k]
    if (Object.keys(drafts).length === 0) delete all[scope]
    else all[scope] = drafts
    localStorage.setItem(STORE, JSON.stringify(all))
  } catch {
    // Unavailable: the edits stay for this session.
  }
}

/** The fields of `next` that differ from the league's row. */
function changesOf(was: Row, next: Row): Changes | null {
  const c: Changes = {}
  for (const k of ['slot', 'name', 'height', 'nicknames', 'notes'] as const) if (next[k] !== was[k]) c[k] = next[k]
  const ratings = Object.fromEntries(Object.entries(next.ratings).filter(([k, v]) => v !== (was.ratings[k] ?? '')))
  if (Object.keys(ratings).length > 0) c.ratings = ratings
  return Object.keys(c).length > 0 ? c : null
}

const NUMBER = /^-?\d+(\.\d+)?$/

/** Roster facts for many players at once: slots, names, heights, ratings, nicknames, notes. */
export function RosterEditor() {
  const { league, reload, refreshing } = useLeague()
  const { config } = league
  const [params, setParams] = useSearchParams()
  const school = params.get('school') ?? ''
  // One league's season: a draft never shows up in another league (or after a new season).
  const scope = `${league.slug}|${league.season.seed}`
  const [drafts, setDrafts] = useState<Record<string, Changes>>(() => readDrafts(scope))
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<RosterSaveResult | null>(null)
  const [error, setError] = useState<unknown>(null)
  const grid = useRef<HTMLTableElement>(null)

  useEffect(() => setDrafts(readDrafts(scope)), [scope])
  // Draft swaps go by slots, so the lineup can't change during the draft: a slot left unsaved from before it is dropped.
  const slotsLocked = league.season.phase === 'draft'
  useEffect(() => {
    if (!slotsLocked || !Object.values(drafts).some((c) => c.slot !== undefined)) return
    const all = Object.fromEntries(
      Object.entries(drafts).flatMap(([id, { slot: _slot, ...rest }]) => (Object.keys(rest).length > 0 ? [[id, rest] as const] : [])),
    )
    setDrafts(all)
    writeDrafts(scope, all)
  }, [slotsLocked, drafts, scope])

  const grades = useMemo(() => config.ratings.gradeScale.map((g) => g.label), [config])
  const teamName = useMemo(() => new Map(league.teams.map((x) => [x.id, x.shortName])), [league])
  const slotName = useMemo(() => new Map(config.roster.slots.map((s) => [s.id, s.name])), [config])
  const slotOrder = useMemo(() => new Map(config.roster.slots.map((s, i) => [s.id, i])), [config])
  const teamOrder = useMemo(() => new Map(league.teams.map((x, i) => [x.id, i])), [league])

  const players = league.players
    .filter((p) => school === '' || p.teamId === school)
    .filter((p) => {
      const q = query.trim().normalize('NFC').toLowerCase()
      if (!q) return true
      return [p.name, ...p.nicknames, teamName.get(p.teamId) ?? ''].some((s) => s.normalize('NFC').toLowerCase().includes(q))
    })
    .sort((a, b) => (teamOrder.get(a.teamId) ?? 0) - (teamOrder.get(b.teamId) ?? 0) || (slotOrder.get(a.slotId ?? '') ?? 99) - (slotOrder.get(b.slotId ?? '') ?? 99))

  const busy = saving || refreshing
  const rowOf = (p: PlayerRow): Row => {
    const was = toRow(p)
    const c = drafts[p.id]
    return c ? { ...was, ...c, ratings: { ...was.ratings, ...c.ratings } } : was
  }
  const edit = (p: PlayerRow, change: (r: Row) => Row) => {
    if (busy) return
    const changes = changesOf(toRow(p), change(rowOf(p)))
    const all = { ...drafts }
    if (changes) all[p.id] = changes
    else delete all[p.id]
    setDrafts(all)
    writeDrafts(scope, all)
    setResult(null)
  }
  const reserved = useMemo(() => new Set(league.teams.flatMap((x) => [folderKey(x.shortName), folderKey(`${x.shortName} 단장`)])), [league])

  /** What's wrong with a cell, or null. */
  const problems = (p: PlayerRow, r: Row): Record<string, string> => {
    const out: Record<string, string> = {}
    const name = r.name.trim()
    if (name === '') out.name = tr.problems.nameEmpty
    else if (name !== p.name) {
      // Only a changed name is checked, as the server does: an imported pair doesn't block other edits.
      if (name.length > 80 || !isFolderSafe(name) || /[()]/.test(name) || /^[_.]/.test(name)) out.name = tr.problems.nameBad
      else if (reserved.has(folderKey(name))) out.name = tr.problems.nameReserved
      else if (league.players.some((o) => o.id !== p.id && o.teamId === p.teamId && folderKey(drafts[o.id]?.name?.trim() ?? o.name) === folderKey(name))) out.name = tr.problems.nameTaken
    }
    if (r.height.trim() !== '' && parseHeightCm(r.height) === null) out.height = tr.problems.heightUnread
    for (const c of config.ratings.columns) {
      const v = (r.ratings[c.id] ?? '').trim()
      if (v === '' || c.kind !== 'number') continue
      const n = Number(v)
      if (!NUMBER.test(v) || n < c.min || n > c.max) out[`ratings.${c.id}`] = tr.problems.range(c.min, c.max)
    }
    return out
  }

  // Each team whose lineup is being changed, checked as the server will: every slot held once, so a half-made swap shows at once.
  const slotIssues = league.teams.flatMap((team) => {
    const roster = league.players.filter((p) => p.teamId === team.id)
    if (!roster.some((p) => drafts[p.id]?.slot !== undefined)) return []
    return rosterProblems(
      config.roster,
      roster.map((p) => rowOf(p).slot || null),
    ).flatMap((x) =>
      x.kind === 'slot'
        ? [{ teamId: team.id, text: ruleText(x.count === 0 ? 'roster-slot-empty' : 'roster-slot-doubled', { team: team.shortName, slot: x.slot, count: x.count }) }]
        : [],
    )
  })
  /** His team's lineup problems, for a slot cell he changed. */
  const slotBad = (p: PlayerRow) =>
    slotIssues
      .filter((x) => x.teamId === p.teamId)
      .map((x) => x.text)
      .join('\n')

  const dirty = league.players.filter((p) => drafts[p.id])
  const blocked = slotIssues.length > 0 || dirty.some((p) => Object.keys(problems(p, rowOf(p))).some((k) => k !== 'height'))

  const editsOf = (): PlayerEdit[] =>
    dirty.map((p) => {
      const r = rowOf(p)
      const was = toRow(p)
      const e: PlayerEdit = { playerId: p.id }
      if (r.slot !== was.slot && !slotsLocked) e.slotId = r.slot === '' ? null : r.slot
      if (r.name !== was.name) e.name = r.name.trim()
      if (r.height !== was.height) e.height = r.height
      if (r.nicknames !== was.nicknames) e.nicknames = splitNicknames(r.nicknames)
      if (r.notes !== was.notes) e.notes = r.notes
      const ratings: PlayerEdit['ratings'] = {}
      for (const c of config.ratings.columns) {
        const v = (r.ratings[c.id] ?? '').trim()
        if (v === (was.ratings[c.id] ?? '')) continue
        ratings[c.id] = v === '' ? null : c.kind === 'number' ? Number(v) : v
      }
      if (Object.keys(ratings).length > 0) e.ratings = ratings
      return e
    })

  const save = async () => {
    if (saving || dirty.length === 0 || blocked) return
    setSaving(true)
    setError(null)
    try {
      const r = await call('roster.update', league.slug, editsOf())
      setDrafts({})
      writeDrafts(scope, {})
      setResult(r)
      reload()
    } catch (e) {
      setError(e)
    } finally {
      setSaving(false)
    }
  }
  const discard = () => {
    if (!window.confirm(tr.confirmDiscard(dirty.length))) return
    setDrafts({})
    writeDrafts(scope, {})
  }

  // Enter and ↑/↓ move between rows in the same column, like a spreadsheet.
  const nav = (e: KeyboardEvent<HTMLElement>, row: number, col: number) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    const down = e.key === 'Enter' || e.key === 'ArrowDown'
    if (!down && e.key !== 'ArrowUp') return
    if (e.currentTarget.tagName === 'SELECT' && e.key !== 'Enter') return
    e.preventDefault()
    grid.current?.querySelector<HTMLElement>(`[data-cell="${row + (down ? 1 : -1)}:${col}"]`)?.focus()
  }

  return (
    <div className="roster-page">
      <div className="lore-table-head">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h1>{tr.title}</h1>
            <p className="help">{tr.intro}</p>
            <p className="help">{slotsLocked ? tr.slotsLocked : tr.slotHelp}</p>
          </div>
          <div className="row">
            {dirty.length > 0 ? <span className="lore-status dirty">{tr.dirty(dirty.length)}</span> : <span className="lore-status">{tr.allSaved}</span>}
            <button type="button" className="btn small ghost" disabled={busy || dirty.length === 0} onClick={discard}>
              {tr.discard}
            </button>
            <button type="button" className="btn small primary" disabled={busy || dirty.length === 0 || blocked} onClick={() => void save()}>
              {saving ? tr.saving : tr.save(dirty.length)}
            </button>
          </div>
        </div>
        <div className="row">
          <select className="compact" aria-label={tr.school} value={school} onChange={(e) => setParams(e.target.value ? { school: e.target.value } : {})}>
            <option value="">{tr.allSchools}</option>
            {league.teams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.shortName}
              </option>
            ))}
          </select>
          <input type="search" className="lore-search narrow" value={query} placeholder={tr.search} aria-label={tr.search} onChange={(e) => setQuery(e.target.value)} />
          {blocked ? <span className="roster-blocked">{tr.blocked}</span> : null}
        </div>
        {slotIssues.length > 0 ? (
          <div className="roster-slot-issues" role="status" aria-label={tr.slotIssues}>
            <IssueList items={slotIssues.map((x) => ({ level: 'error' as const, text: x.text }))} />
          </div>
        ) : null}
        {error ? <RuleErrors error={error} /> : null}
        {result ? <SaveSummary result={result} slug={league.slug} /> : null}
      </div>

      <div className="lore-table-wrap">
        <table className="lore-grid roster-grid" ref={grid}>
          <thead>
            <tr>
              {school === '' ? <th>{tr.schoolCol}</th> : null}
              <th>{tr.slot}</th>
              <th className="sticky">{tr.name}</th>
              <th>{tr.height}</th>
              {/* Korean names; the sheet's own name (what 2K and imports use) on hover. */}
              {config.ratings.columns.map((c) => (
                <th key={c.id} title={`${tr.columnSource(c.name)} · ${c.kind === 'number' ? tr.rangeHelp(c.min, c.max) : tr.gradeHelp}`}>
                  {ratingShort(c)}
                </th>
              ))}
              <th>{tr.nicknames}</th>
              <th>{tr.notes}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {players.map((p, ri) => {
              const r = rowOf(p)
              const was = toRow(p)
              const bad = problems(p, r)
              // A slot he was moved to while his team's lineup doesn't fit yet.
              if (r.slot !== was.slot && slotBad(p)) bad.slot = slotBad(p)
              const cls = (key: string, changed: boolean) => [changed ? 'changed' : '', bad[key] ? 'bad' : ''].filter(Boolean).join(' ')
              // Fixed column numbers for moving up and down: name, height, each rating, nicknames, slot.
              const NAME = 0
              const HEIGHT = 1
              const NICK = 2 + config.ratings.columns.length
              const SLOT = NICK + 1
              const expanded = open === p.id
              return [
                <tr key={p.id} className={drafts[p.id] ? 'dirty' : ''}>
                  {school === '' ? <td className="muted">{teamName.get(p.teamId)}</td> : null}
                  <td className={cls('slot', r.slot !== was.slot)} title={bad.slot}>
                    <select
                      className="compact slot"
                      value={r.slot}
                      aria-label={`${p.name} ${tr.slot}`}
                      aria-invalid={bad.slot ? true : undefined}
                      disabled={busy || slotsLocked}
                      title={slotsLocked ? tr.slotsLocked : undefined}
                      data-cell={`${ri}:${SLOT}`}
                      onKeyDown={(e) => nav(e, ri, SLOT)}
                      onChange={(e) => edit(p, (x) => ({ ...x, slot: e.target.value }))}
                    >
                      {/* No slot: only where the league allows it, or as the player has it now. */}
                      {config.roster.slotMode === 'free' || r.slot === '' || was.slot === '' ? <option value="">–</option> : null}
                      {config.roster.slots.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                      {[...new Set([was.slot, r.slot])]
                        .filter((s) => s !== '' && !slotName.has(s))
                        .map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                    </select>
                  </td>
                  <td className={`sticky who ${cls('name', r.name !== was.name)}`} title={bad.name}>
                    <input
                      type="text"
                      className="compact"
                      value={r.name}
                      aria-label={`${p.name} ${tr.name}`}
                      aria-invalid={bad.name ? true : undefined}
                      disabled={busy}
                      data-cell={`${ri}:${NAME}`}
                      onKeyDown={(e) => nav(e, ri, NAME)}
                      onChange={(e) => edit(p, (x) => ({ ...x, name: e.target.value }))}
                    />
                  </td>
                  <td className={cls('height', r.height !== was.height)} title={bad.height}>
                    <input
                      type="text"
                      className="compact narrow"
                      value={r.height}
                      aria-label={`${p.name} ${tr.height}`}
                      disabled={busy}
                      data-cell={`${ri}:${HEIGHT}`}
                      onKeyDown={(e) => nav(e, ri, HEIGHT)}
                      onChange={(e) => edit(p, (x) => ({ ...x, height: e.target.value }))}
                    />
                  </td>
                  {config.ratings.columns.map((rc, i) => {
                    const c = 2 + i
                    const v = r.ratings[rc.id] ?? ''
                    const key = `ratings.${rc.id}`
                    return (
                      <td key={rc.id} className={`center ${cls(key, v !== (was.ratings[rc.id] ?? ''))}`} title={bad[key]}>
                        {rc.kind === 'number' ? (
                          <input
                            type="text"
                            inputMode="decimal"
                            className="compact num"
                            value={v}
                            aria-label={`${p.name} ${rc.name}`}
                            aria-invalid={bad[key] ? true : undefined}
                            disabled={busy}
                            data-cell={`${ri}:${c}`}
                            onKeyDown={(e) => nav(e, ri, c)}
                            onChange={(e) => edit(p, (x) => ({ ...x, ratings: { ...x.ratings, [rc.id]: e.target.value } }))}
                          />
                        ) : (
                          <select
                            className="compact grade"
                            disabled={busy}
                            value={v}
                            aria-label={`${p.name} ${rc.name}`}
                            data-cell={`${ri}:${c}`}
                            onKeyDown={(e) => nav(e, ri, c)}
                            onChange={(e) => edit(p, (x) => ({ ...x, ratings: { ...x.ratings, [rc.id]: e.target.value } }))}
                          >
                            <option value="">–</option>
                            {grades.map((g) => (
                              <option key={g} value={g}>
                                {g}
                              </option>
                            ))}
                            {v !== '' && !grades.includes(v) ? <option value={v}>{v}</option> : null}
                          </select>
                        )}
                      </td>
                    )
                  })}
                  <td className={cls('nicknames', r.nicknames !== was.nicknames)}>
                    <input
                      type="text"
                      className="compact"
                      value={r.nicknames}
                      placeholder={tr.nicknamesHint}
                      aria-label={`${p.name} ${tr.nicknames}`}
                      disabled={busy}
                      data-cell={`${ri}:${NICK}`}
                      onKeyDown={(e) => nav(e, ri, NICK)}
                      onChange={(e) => edit(p, (x) => ({ ...x, nicknames: e.target.value }))}
                    />
                  </td>
                  <td className={cls('notes', r.notes !== was.notes)}>
                    <button type="button" className="roster-notes" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : p.id)} title={r.notes}>
                      {r.notes.trim() === '' ? <span className="muted">{tr.addNotes}</span> : r.notes.split('\n')[0]!.slice(0, 18) + (r.notes.length > 18 ? '…' : '')}
                    </button>
                  </td>
                  <td>
                    <Link className="roster-lore" to={`/l/${encodeURIComponent(league.slug)}/lore?player=${encodeURIComponent(p.id)}`} title={tr.loreHint}>
                      {tr.lore}
                    </Link>
                  </td>
                </tr>,
                expanded ? (
                  <tr key={`${p.id}-notes`} className="roster-notes-row">
                    <td colSpan={99}>
                      <label className="stack">
                        <span className="label">{tr.notesFor(r.name || p.name)}</span>
                        <textarea
                          rows={4}
                          value={r.notes}
                          maxLength={4000}
                          autoFocus
                          disabled={busy}
                          aria-label={`${p.name} ${tr.notes}`}
                          onChange={(e) => edit(p, (x) => ({ ...x, notes: e.target.value }))}
                        />
                      </label>
                    </td>
                  </tr>
                ) : null,
              ]
            })}
          </tbody>
        </table>
        {players.length === 0 ? <p className="lore-empty pad">{tr.noMatch}</p> : null}
      </div>
    </div>
  )
}

/** After a save: what renames took along, and what's left for you. */
function SaveSummary({ result, slug }: { result: RosterSaveResult; slug: string }) {
  return (
    <Notice tone={result.renamed.some((r) => r.loreReferences.length > 0 || r.wikiLinks > 0 || r.lore?.status === 'failed' || r.ambiguousReferences.length > 0) ? 'warn' : 'ok'}>
      <div className="stack">
        <span>{tr.saved(result.changed)}</span>
        {result.renamed.map((r) => (
          <div key={r.playerId} className="stack" style={{ gap: 2 }}>
            <b>{tr.renamed(r.from, r.to)}</b>
            {r.lore ? <span>{r.lore.status === 'moved' ? tr.loreMoved(r.lore.to) : tr.loreFailed(r.lore.from)}</span> : <span className="muted">{tr.noLore}</span>}
            {r.wikiTitle ? <span>{tr.wikiMoved(r.wikiTitle)}</span> : null}
            {r.wikiLinks > 0 ? <span>{tr.wikiLinks(r.wikiLinks, r.from)}</span> : null}
            {r.sharedName && r.ambiguousReferences.length > 0 ? (
              <span>
                {tr.sharedName(r.to)}{' '}
                {r.ambiguousReferences.map((f) => (
                  <Link key={f} className="roster-ref" to={`/l/${encodeURIComponent(slug)}/lore?f=${encodeURIComponent(f)}`}>
                    {f.split('/').pop()!.replace(/\.md$/, '')}
                  </Link>
                ))}
              </span>
            ) : null}
            {r.loreReferences.length > 0 ? (
              <span>
                {tr.loreRefs(r.from)}{' '}
                {r.loreReferences.map((f) => (
                  <Link key={f} className="roster-ref" to={`/l/${encodeURIComponent(slug)}/lore?f=${encodeURIComponent(f)}`}>
                    {f.split('/').pop()!.replace(/\.md$/, '')}
                  </Link>
                ))}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </Notice>
  )
}
