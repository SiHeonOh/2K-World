import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { LeagueSnapshot } from '@shared/league'
import type { LoreCreateTarget, LoreFileView, LoreIndexView, LoreKind } from '@shared/lore'
import type { SuggestionTarget } from '@shared/suggestions'
import { isFolderSafe } from '@shared/setup'
import { call } from '../../../api'
import { Badge, ErrorBox, Loading, Notice } from '../../../components/ui'
import { useLoad } from '../../../hooks'
import { t } from '../../../i18n'
import { useLeague } from '../LeagueLayout'
import { draftKeyOf, useDraftKeys } from './drafts'
import { LoreEditor, ProblemList, type EditorHeader } from './LoreEditor'
import { LoreTable, type TableKind } from './LoreTable'
import { peopleOf } from './people'
import { AiDraftBar, AiDraftCard } from './AiDraft'

const tl = t.lore
type Filter = 'all' | 'player' | 'team' | 'gm' | 'world' | 'empty' | 'problems'
const FILTERS: Filter[] = ['all', 'player', 'team', 'gm', 'world', 'empty', 'problems']

/** One row in the list: a file, or someone who should have one. */
interface Item {
  key: string
  /** Where its unsaved edits are kept. */
  draftKey: string
  kind: LoreKind
  label: string
  detail: string
  /** Null: no file yet (clicking offers to make one). */
  file: string | null
  target: LoreCreateTarget | null
  sizes: LoreFileView['sizes'] | null
  problem: 'error' | 'unlinked' | 'misplaced' | 'duplicate' | null
}

interface Group {
  key: string
  title: string
  items: Item[]
}

const folderKey = (s: string) => s.normalize('NFC').toLowerCase()
const folderOf = (file: string) => (file.startsWith('teams/') ? (file.split('/')[1] ?? '') : null)
const baseName = (file: string) => file.split('/').pop()!.replace(/\.md$/i, '')
/** The player, school or GM a list row is about (from where its drafts are kept), for an AI draft. */
function targetOfKey(key: string | undefined): SuggestionTarget | null {
  const m = key?.match(/^(player|team|gm):(.+)$/)
  if (!m) return null
  return m[1] === 'player' ? { kind: 'player', playerId: m[2]! } : { kind: m[1] as 'team' | 'gm', teamId: m[2]! }
}

function buildGroups(league: LeagueSnapshot, index: LoreIndexView): Group[] {
  const slotOrder = new Map(league.config.roster.slots.map((s, i) => [s.id, i]))
  const slotName = new Map(league.config.roster.slots.map((s) => [s.id, s.name]))
  const misplaced = new Set(index.misplaced.map((m) => m.file))
  const duplicate = new Set(index.duplicates.flatMap((d) => d.files.filter((f) => f !== d.kept)))
  const errorFiles = [...new Set(index.errors.map((e) => e.file))]
  const used = new Set<string>()
  const fileItem = (f: LoreFileView, label: string, detail: string): Item => {
    used.add(f.file)
    return {
      key: f.file,
      draftKey: draftKeyOf(f.link, f.file),
      kind: f.kind,
      label,
      detail,
      file: f.file,
      target: null,
      sizes: f.sizes,
      problem: misplaced.has(f.file) ? 'misplaced' : duplicate.has(f.file) ? 'duplicate' : null,
    }
  }
  const loose = (file: string, kind: LoreKind, problem: Item['problem']): Item => {
    used.add(file)
    return { key: file, draftKey: draftKeyOf(null, file), kind, label: baseName(file), detail: '', file, target: null, sizes: null, problem: duplicate.has(file) ? 'duplicate' : problem }
  }

  const groups: Group[] = league.teams.map((team) => {
    const items: Item[] = []
    const teamFile = index.files.find((f) => f.link?.kind === 'team' && f.link.teamId === team.id)
    items.push(
      teamFile
        ? fileItem(teamFile, team.shortName, tl.kinds.team!)
        : { key: `team:${team.id}`, draftKey: `team:${team.id}`, kind: 'team', label: team.shortName, detail: tl.kinds.team!, file: null, target: { kind: 'team', teamId: team.id }, sizes: null, problem: null },
    )
    const gmFile = index.files.find((f) => f.link?.kind === 'gm' && f.link.teamId === team.id)
    items.push(
      gmFile
        ? fileItem(gmFile, tl.gmOf(team.shortName), tl.kinds.gm!)
        : { key: `gm:${team.id}`, draftKey: `gm:${team.id}`, kind: 'gm', label: tl.gmOf(team.shortName), detail: tl.kinds.gm!, file: null, target: { kind: 'gm', teamId: team.id }, sizes: null, problem: null },
    )
    const roster = league.players
      .filter((p) => p.teamId === team.id)
      .sort((a, b) => (slotOrder.get(a.slotId ?? '') ?? 99) - (slotOrder.get(b.slotId ?? '') ?? 99) || a.name.localeCompare(b.name, 'ko'))
    for (const p of roster) {
      const f = index.files.find((x) => x.link?.kind === 'player' && x.link.playerId === p.id)
      const detail = p.slotId ? (slotName.get(p.slotId) ?? '') : ''
      items.push(
        f ? fileItem(f, p.name, detail) : { key: `player:${p.id}`, draftKey: `player:${p.id}`, kind: 'player', label: p.name, detail, file: null, target: { kind: 'player', playerId: p.id }, sizes: null, problem: null },
      )
    }
    // Files in this school's folder that match nobody, or don't read.
    for (const f of index.files) if (!used.has(f.file) && f.link === null && folderOf(f.file) !== null && folderKey(folderOf(f.file)!) === folderKey(team.shortName)) items.push(loose(f.file, f.kind, 'unlinked'))
    for (const file of errorFiles) if (!used.has(file) && folderOf(file) !== null && folderKey(folderOf(file)!) === folderKey(team.shortName)) items.push(loose(file, 'player', 'error'))
    return { key: team.id, title: team.shortName, items }
  })

  const world: Item[] = index.files.filter((f) => f.kind === 'world' && !used.has(f.file)).map((f) => fileItem(f, f.linkedTo ?? baseName(f.file), tl.kinds.world!))
  for (const file of errorFiles) if (!used.has(file) && file.startsWith('world/')) world.push(loose(file, 'world', 'error'))
  world.push({ key: 'new:world', draftKey: '', kind: 'world', label: tl.newWorld, detail: '', file: null, target: { kind: 'world', title: '' }, sizes: null, problem: null })
  groups.push({ key: 'world', title: tl.worldGroup, items: world })

  const rest: Item[] = [
    ...index.files.filter((f) => !used.has(f.file)).map((f) => loose(f.file, f.kind, 'unlinked')),
    ...errorFiles.filter((f) => !used.has(f)).map((f) => loose(f, 'player', 'error')),
  ]
  if (rest.length > 0) groups.push({ key: 'rest', title: tl.unsorted, items: rest })
  return groups
}

function keep(item: Item, filter: Filter, query: string): boolean {
  if (item.key === 'new:world') return filter === 'all' || filter === 'world'
  const q = query.trim().normalize('NFC').toLowerCase()
  if (q && !`${item.label} ${item.detail} ${item.file ?? ''}`.normalize('NFC').toLowerCase().includes(q)) return false
  switch (filter) {
    case 'all':
      return true
    case 'empty':
      return item.file === null || (item.sizes !== null && item.sizes.public + item.sizes.rumor + item.sizes.secret === 0)
    case 'problems':
      return item.problem !== null
    default:
      return item.kind === filter && item.problem !== 'error'
  }
}

/** The 로어 screen: everyone who can have lore on the left, the editor (or the overview) on the right. */
export function LoreScreen() {
  const { league } = useLeague()
  const slug = league.slug
  const [params, setParams] = useSearchParams()
  const index = useLoad(() => call('lore.index', slug), [slug], { keepPrevious: true })
  const drafts = useDraftKeys(index.state === 'ready' ? index.value.draftScope : '')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const value = index.state === 'ready' ? index.value : null
  const groups = useMemo(() => (value ? buildGroups(league, value) : []), [league, value])
  const people = useMemo(() => peopleOf(league, value?.firstTeams ?? {}), [league, value])
  const selected = params.get('f')
  const creating = params.get('new')
  const listRef = useRef<HTMLDivElement>(null)

  // Files may have changed in another editor while the app was in the background.
  const reload = index.reload
  useEffect(() => {
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [reload])

  // Arriving from a link (or making a file): show the row in the list.
  useEffect(() => {
    const key = selected ?? (creating === 'world' ? 'new:world' : creating)
    if (!key || !listRef.current) return
    const row = [...listRef.current.querySelectorAll<HTMLElement>('[data-key]')].find((el) => el.dataset.key === key)
    row?.scrollIntoView({ block: 'nearest' })
  }, [selected, creating, groups])

  // Links from other screens: ?player=, ?team=, ?gm= open that file (or the offer to make it).
  useEffect(() => {
    if (!value) return
    const player = params.get('player')
    const team = params.get('team')
    const gm = params.get('gm')
    if (!player && !team && !gm) return
    const file = value.files.find((f) =>
      player ? f.link?.kind === 'player' && f.link.playerId === player : f.link?.kind === (team ? 'team' : 'gm') && f.link.teamId === (team ?? gm),
    )?.file
    setParams(file ? { f: file } : { new: player ? `player:${player}` : team ? `team:${team}` : `gm:${gm}` }, { replace: true })
  }, [value, params, setParams])

  const table = params.get('table') as TableKind | null
  if (table === 'players' || table === 'gms' || table === 'schools') {
    const school = params.get('school') ?? ''
    return (
      <LoreTable
        slug={slug}
        league={league}
        kind={table}
        team={school}
        onKind={(k) => setParams(school ? { table: k, school } : { table: k })}
        onTeam={(id) => setParams(id ? { table, school: id } : { table })}
        onOpen={(row) => {
          index.reload()
          if (row.file) setParams({ f: row.file })
          else setParams({ new: row.kind === 'player' ? `player:${row.playerId}` : `${row.kind}:${row.teamId}` })
        }}
        onClose={() => {
          index.reload()
          setParams({})
        }}
      />
    )
  }

  if (index.state === 'loading') return <div className="page"><Loading /></div>
  if (index.state === 'error') return <div className="page"><ErrorBox error={index.error} onRetry={index.reload} /></div>
  const idx = index.value
  const allItems = groups.flatMap((g) => g.items)
  const selectedItem = selected ? allItems.find((i) => i.file === selected) : null
  const creatingItem = creating ? allItems.find((i) => i.file === null && i.key === creating) : null

  const header = (item: Item | null | undefined, file: string): EditorHeader => {
    if (!item) return { title: baseName(file), detail: '', kindLabel: '' }
    const group = groups.find((g) => g.items.includes(item))
    const school = group && group.key !== 'world' && group.key !== 'rest' ? group.title : ''
    const detail = item.kind === 'player' ? [school, item.detail].filter(Boolean).join(' · ') : item.kind === 'world' ? '' : school
    return { title: item.label, detail: item.kind === 'team' || item.kind === 'gm' ? '' : detail, kindLabel: tl.kinds[item.kind] ?? '' }
  }

  const select = (item: Item) => {
    if (item.file) setParams({ f: item.file })
    else if (item.target?.kind === 'world') setParams({ new: 'world' })
    else if (item.target) setParams({ new: item.key })
  }

  return (
    <div className="lore-shell">
      <aside className="lore-list" aria-label={tl.title}>
        <div className="lore-list-head">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h1>
              <button type="button" className="link plain" onClick={() => setParams({})}>
                {tl.title}
              </button>
            </h1>
            <div className="row" style={{ gap: 4 }}>
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  const teamId = selectedItem ? groups.find((g) => g.items.includes(selectedItem))?.key : undefined
                  setParams(teamId && league.teams.some((x) => x.id === teamId) ? { table: 'players', school: teamId } : { table: 'players' })
                }}
              >
                {tl.openTable}
              </button>
              <button type="button" className="btn ghost small" disabled={index.refreshing} onClick={index.reload}>
                {tl.reload}
              </button>
            </div>
          </div>
          <input type="search" className="lore-search" value={query} placeholder={tl.search} aria-label={tl.search} onChange={(e) => setQuery(e.target.value)} />
          <div className="lore-filters" role="radiogroup" aria-label={tl.title}>
            {FILTERS.map((f) => (
              <button key={f} type="button" role="radio" aria-checked={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                {tl.filters[f]}
              </button>
            ))}
          </div>
        </div>
        <div className="lore-list-body" ref={listRef}>
          <button type="button" className={`lore-item overview${!selected && !creating ? ' on' : ''}`} onClick={() => setParams({})}>
            {tl.overview}
          </button>
          {groups.map((g) => {
            const items = g.items.filter((i) => keep(i, filter, query))
            if (items.length === 0) return null
            const open = query.trim() !== '' || filter !== 'all' || !collapsed.has(g.key)
            const withFile = g.items.filter((i) => i.file !== null && i.key !== 'new:world').length
            const total = g.items.filter((i) => i.key !== 'new:world').length
            return (
              <div key={g.key} className="lore-group">
                <button
                  type="button"
                  className="lore-group-head"
                  aria-expanded={open}
                  onClick={() =>
                    setCollapsed((c) => {
                      const n = new Set(c)
                      if (n.has(g.key)) n.delete(g.key)
                      else n.add(g.key)
                      return n
                    })
                  }
                >
                  <span className="caret" aria-hidden>
                    {open ? '▾' : '▸'}
                  </span>
                  <span className="title">{g.title}</span>
                  {g.key !== 'world' && g.key !== 'rest' ? <span className="count">{tl.ofTotal(withFile, total)}</span> : null}
                </button>
                {open
                  ? items.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        data-key={item.file ?? item.key}
                        className={`lore-item ${item.kind}${item.file === null ? ' missing' : ''}${item.key === 'new:world' ? ' add' : ''}${(item.file && item.file === selected) || (!item.file && creating === (item.target?.kind === 'world' ? 'world' : item.key)) ? ' on' : ''}`}
                        onClick={() => select(item)}
                      >
                        <span className="lore-item-icon" aria-hidden>
                          {item.key === 'new:world' ? '+' : item.kind === 'team' ? '◆' : item.kind === 'gm' ? '◇' : item.kind === 'world' ? '✦' : '●'}
                        </span>
                        <span className="lore-item-label">{item.label}</span>
                        {item.detail && item.kind === 'player' ? <span className="lore-item-detail">{item.detail}</span> : null}
                        <span className="lore-item-marks">
                          {item.file && drafts.has(item.draftKey) ? <span className="lore-unsaved" title={tl.unsavedDot} /> : null}
                          {item.problem ? <Badge tone={item.problem === 'error' ? 'err' : 'warn'}>!</Badge> : null}
                          {item.file === null && item.key !== 'new:world' ? <span className="lore-nofile">{tl.noFile}</span> : null}
                          {item.sizes ? <Dots sizes={item.sizes} /> : null}
                        </span>
                      </button>
                    ))
                  : null}
              </div>
            )
          })}
          {groups.every((g) => g.items.every((i) => !keep(i, filter, query))) ? <p className="lore-empty pad">{tl.noMatch}</p> : null}
        </div>
      </aside>

      <section className="lore-pane">
        {selected ? (
          <LoreEditor
            key={selected}
            slug={slug}
            file={selected}
            draftScope={idx.draftScope}
            draftKey={selectedItem?.draftKey ?? draftKeyOf(null, selected)}
            header={header(selectedItem, selected)}
            ctx={{ league, people, firstTeams: idx.firstTeams }}
            tools={targetOfKey(selectedItem?.draftKey) ? <AiDraftBar slug={slug} target={targetOfKey(selectedItem?.draftKey)!} /> : null}
            onChanged={index.reload}
            onRemoved={() => {
              index.reload()
              setParams({})
            }}
          />
        ) : creating ? (
          <CreatePanel
            key={creating}
            slug={slug}
            label={creating === 'world' ? null : (creatingItem?.label ?? '')}
            target={creating === 'world' ? { kind: 'world', title: '' } : (creatingItem?.target ?? null)}
            onCreated={(file) => {
              index.reload()
              setParams({ f: file })
            }}
          />
        ) : (
          <Overview index={idx} league={league} groups={groups} reload={index.reload} onOpen={(file) => setParams({ f: file })} onTable={(k) => setParams({ table: k })} />
        )}
      </section>
    </div>
  )
}

/** Which of 공개 / 소문 / 비밀 have text. */
function Dots({ sizes }: { sizes: LoreFileView['sizes'] }) {
  return (
    <span className="lore-dots">
      {(['public', 'rumor', 'secret'] as const).map((k) => (
        <span key={k} className={`lore-dot ${k}${sizes[k] > 0 ? ' filled' : ''}`} title={sizes[k] > 0 ? tl.filled(tl.sections[k]!) : tl.emptySection(tl.sections[k]!)} />
      ))}
    </span>
  )
}

/** Offers to make a missing file from the template (or a new world topic, with its title). */
function CreatePanel({ slug, label, target, onCreated }: { slug: string; label: string | null; target: LoreCreateTarget | null; onCreated: (file: string) => void }) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  if (!target) return <div className="lore-editor-pad"><p className="lore-empty">{tl.noMatch}</p></div>
  const world = target.kind === 'world'
  const cleanTitle = title.trim()
  const titleOk = cleanTitle !== '' && cleanTitle.length <= 60 && isFolderSafe(cleanTitle) && !cleanTitle.startsWith('_') && !cleanTitle.startsWith('.')
  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const { file } = await call('lore.create', slug, world ? { kind: 'world', title: cleanTitle } : target)
      onCreated(file)
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }
  return (
    <div className="lore-editor-pad">
      <div className="card lore-create">
        <h2>{world ? tl.newWorld : tl.createTitle(label ?? '')}</h2>
        <p className="help">{tl.createBody}</p>
        {world ? (
          <>
            <input
              type="text"
              className={`lore-input${cleanTitle !== '' && !titleOk ? ' invalid' : ''}`}
              value={title}
              maxLength={60}
              placeholder={tl.newWorldPrompt}
              aria-label={tl.newWorldPrompt}
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229 && titleOk && !busy && void create()}
            />
            {cleanTitle !== '' && !titleOk ? <span className="help err">{tl.badWorldTitle}</span> : null}
          </>
        ) : null}
        {error ? <ErrorBox error={error} /> : null}
        <div className="row">
          <button type="button" className="btn primary" disabled={busy || (world && !titleOk)} onClick={() => void create()}>
            {busy ? tl.creating : tl.createButton}
          </button>
        </div>
        {target.kind !== 'world' ? <AiDraftBar slug={slug} target={target} /> : null}
      </div>
    </div>
  )
}

/** Nothing picked: how the folder is doing, what needs you, and the one-click setup. */
function Overview({
  index,
  league,
  groups,
  reload,
  onOpen,
  onTable,
}: {
  index: LoreIndexView
  league: LeagueSnapshot
  groups: Group[]
  reload: () => void
  onOpen: (file: string) => void
  onTable: (kind: TableKind) => void
}) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const players = league.players.length
  const playerFiles = index.files.filter((f) => f.link?.kind === 'player')
  const missingCount = index.missing.length + index.missingTeams.length + index.missingGms.length
  const unlinked = groups.flatMap((g) => g.items).filter((i) => i.problem === 'unlinked' && i.file)

  const act = async (work: () => Promise<string>) => {
    setBusy(true)
    setNote(null)
    setError(null)
    try {
      setNote(await work())
      reload()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  const createMissing = () => {
    if (!window.confirm(tl.confirmCreateMissing(missingCount))) return
    void act(async () => tl.created((await call('lore.createMissing', league.slug)).created))
  }
  const moveAgain = () => void act(async () => ((await call('lore.sync', league.slug)).moved === 0 ? tl.movedNone : ''))
  const openFolder = () => void call('app.openDataFolder', league.slug).catch(setError)
  const nothingWrong = index.errors.length === 0 && unlinked.length === 0 && index.misplaced.length === 0 && index.duplicates.length === 0

  return (
    <div className="lore-overview">
      <div className="page-head">
        <div>
          <h1>{tl.title}</h1>
          <p className="sub">{tl.intro}</p>
          <p className="sub lore-folder">{tl.folderAt(index.folder)}</p>
        </div>
        <div className="row">
          <button className="btn small" onClick={reload}>
            {tl.reload}
          </button>
          <button className="btn small" onClick={openFolder}>
            {tl.openFolder}
          </button>
        </div>
      </div>
      {error ? <ErrorBox error={error} /> : null}
      {note ? <Notice tone="ok">{note}</Notice> : null}

      <div className="lore-stats">
        <Stat label={tl.stats.files} value={String(index.files.length)} />
        <Stat label={tl.stats.players} value={tl.ofTotal(playerFiles.length, players)} ratio={players ? playerFiles.length / players : 0} />
        <Stat label={tl.stats.written} value={tl.ofTotal(playerFiles.filter((f) => f.sizes.public > 0).length, players)} ratio={players ? playerFiles.filter((f) => f.sizes.public > 0).length / players : 0} />
        <Stat label={tl.stats.secrets} value={String(playerFiles.filter((f) => f.sizes.secret > 0).length)} />
      </div>

      {!index.exists ? <Notice tone="info">{tl.noFolder}</Notice> : null}
      <div className="card">
        <div className="card-head">
          <h3>{tl.tablesTitle}</h3>
        </div>
        <p className="help">{tl.tablesHelp}</p>
        <div className="row">
          {(['players', 'gms', 'schools'] as const).map((k) => (
            <button key={k} type="button" className="btn small" onClick={() => onTable(k)}>
              {tl.tables[k]}
            </button>
          ))}
        </div>
      </div>
      <AiDraftCard league={league} />
      {missingCount > 0 ? (
        <div className="card">
          <div className="card-head">
            <h3>{tl.createMissing(missingCount)}</h3>
            <button className="btn primary small" disabled={busy} onClick={createMissing}>
              {tl.createMissing(missingCount)}
            </button>
          </div>
          <p className="help">{tl.createMissingHelp}</p>
        </div>
      ) : null}

      {index.errors.length > 0 ? (
        <div className="card">
          <h3>
            <Badge tone="err">{tl.errors(new Set(index.errors.map((e) => e.file)).size)}</Badge>
          </h3>
          <p className="help">{tl.errorsHelp}</p>
          <ProblemList errors={index.errors} />
          <div className="row">
            {[...new Set(index.errors.map((e) => e.file))].map((f) => (
              <button key={f} type="button" className="btn small" onClick={() => onOpen(f)}>
                {baseName(f)}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {unlinked.length > 0 ? (
        <div className="card">
          <h3>
            <Badge tone="warn">{tl.unlinkedFiles(unlinked.length)}</Badge>
          </h3>
          <p className="help">{tl.unlinkedHelp}</p>
          <div className="row">
            {unlinked.map((i) => (
              <button key={i.key} type="button" className="btn small" onClick={() => onOpen(i.file!)}>
                {i.file}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {index.misplaced.length > 0 ? (
        <div className="card">
          <div className="row">
            <h3>
              <Badge tone="warn">{tl.misplaced(index.misplaced.length)}</Badge>
            </h3>
            <button className="btn small" disabled={busy} onClick={moveAgain}>
              {tl.moveAgain}
            </button>
          </div>
          <p className="sub">{tl.misplacedIntro}</p>
          <ul className="lore-errors">
            {index.misplaced.map((m) => (
              <li key={m.file}>
                <code>{m.file}</code> {tl.movesTo(m.to)}
                <div className="sub">{m.taken ? tl.taken : tl.stuck}</div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {index.duplicates.length > 0 ? (
        <div className="card">
          <h3>
            <Badge tone="warn">{tl.duplicates(index.duplicates.length)}</Badge>
          </h3>
          <p className="sub">{tl.duplicatesIntro}</p>
          <ul className="lore-errors">
            {index.duplicates.map((d) => (
              <li key={d.files.join('|')}>
                {d.name}
                {d.files.map((f) => (
                  <div key={f}>
                    <button type="button" className="link" onClick={() => onOpen(f)}>
                      <code>{f}</code>
                    </button>{' '}
                    {f === d.kept ? <Badge tone="info">{tl.used}</Badge> : <Badge>{tl.unused}</Badge>}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {nothingWrong ? <p className="help">{missingCount === 0 ? `${tl.allGood} ${tl.pickHint}` : tl.pickHint}</p> : null}
    </div>
  )
}

function Stat({ label, value, ratio }: { label: string; value: string; ratio?: number }) {
  return (
    <div className="lore-stat">
      <span className="lore-stat-label">{label}</span>
      <b>{value}</b>
      {ratio !== undefined ? (
        <span className="lore-stat-bar">
          <span style={{ width: `${Math.round(ratio * 100)}%` }} />
        </span>
      ) : null}
    </div>
  )
}
