import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { BoxIssue, GameRow } from '@shared/season'
import { call } from '../../api'
import { Badge, IssueList, Loading, Notice } from '../../components/ui'
import { useLoad } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { EndDay, PairPicker, useRoundName } from './Played'
import { RuleErrors, withTeamNames } from './RuleErrors'
import { PastSeasonNotice, SeasonPicker, useSeasonPick } from './SeasonPicker'
import { rosterOf } from './util'

type Tab = number | 'playoffs'

export function Schedule() {
  const { league } = useLeague()
  const slug = league.slug
  const phase = league.season.phase
  const [tick, setTick] = useState(0)
  // A past season is read only: no scores, no box-score edits, no round building.
  const season = useSeasonPick()
  const key = `${slug}:${season.seasonId}`
  const games = useLoad(() => call('season.games', slug, season.arg), [key, tick], { keepPrevious: true })
  const info = useLoad(() => call('schedule.info', slug, season.arg), [key, tick, phase], { keepPrevious: true })
  const checklist = useLoad(() => call('checklist.list', slug), [slug, tick], { keepPrevious: true })
  // 경기일 links here with ?round=N (or ?tab=playoffs) to type a game in by hand, and &game=<id> to open its box score.
  const [params] = useSearchParams()
  const [tab, setTab] = useState<Tab | null>(() => {
    if (params.get('tab') === 'playoffs') return 'playoffs'
    const r = Number(params.get('round'))
    return Number.isInteger(r) && r > 0 ? r : null
  })
  const askedGame = Number(params.get('game')) || null
  const roundName = useRoundName()
  // 2K 일정대로: the session 오늘 경기 끝 just closed, and the one now open.
  const [closedNote, setClosedNote] = useState<{ round: number; next: number } | null>(null)
  // Box-score warnings per game id, kept here so they survive the reload after a save.
  const [warnings, setWarnings] = useState<Record<number, BoxIssue[]>>({})

  const items = checklist.state === 'ready' ? checklist.value : null
  const waiting = useMemo(() => new Set((items ?? []).filter((c) => c.appliedAt === null).flatMap((c) => c.teamIds)), [items])

  if (games.state === 'loading' || info.state === 'loading') return <div className="page"><Loading /></div>
  if (games.state === 'error' || info.state === 'error') {
    return (
      <div className="page">
        <PastSeasonNotice season={season} />
        {games.state === 'error' ? <RuleErrors error={games.error} onRetry={games.reload} /> : null}
        {/* An unknown season fails both reads: one notice is enough. */}
        {info.state === 'error' && games.state !== 'error' ? <RuleErrors error={info.error} onRetry={info.reload} /> : null}
      </div>
    )
  }

  const shape = info.value
  const all = games.value
  const regular = all.filter((g) => g.stage === 'regular')
  const playoff = all.filter((g) => g.stage !== 'regular')
  // 2K 일정대로: rounds are sessions (N일차); the ones before the open session are closed.
  const played = shape.build === 'played'
  const session = played ? (shape.session ?? null) : null
  // A round robin shows every round from the start, built or not; a custom game count shows the rounds drawn.
  const drawn = [...new Set(regular.map((g) => g.round))]
  const preseason = !season.past && phase === 'preseason'
  const rounds = preseason ? [] : [...new Set([...Array.from({ length: shape.rounds }, (_, i) => i + 1), ...drawn])].sort((a, b) => a - b)
  const stateOf = (r: number) => {
    const list = regular.filter((g) => g.round === r)
    if (played) {
      const closed = session !== null && r < session
      return { list, full: closed, done: closed }
    }
    const full = shape.perRound > 0 ? list.length >= shape.perRound : list.length > 0
    return { list, full, done: full && list.every((g) => g.status === 'final') }
  }
  const firstOpen = rounds.find((r) => !stateOf(r).done)
  // A round asked for that doesn't exist (say, a link from another season) falls back like no choice at all.
  const chosen = typeof tab === 'number' && !rounds.includes(tab) ? null : tab
  const current: Tab | null = chosen ?? (playoff.some((g) => g.status === 'scheduled') ? 'playoffs' : (firstOpen ?? rounds.at(-1) ?? null))
  const shown = current === 'playoffs' ? playoff : regular.filter((g) => g.round === current)
  const round = current === 'playoffs' || current === null ? null : stateOf(current)

  const saved = () => {
    // Stay on this tab so its warnings and other typed scores stay in view.
    setTab((x) => x ?? current)
    setTick((x) => x + 1)
  }

  return (
    <div className="page wide">
      <div className="page-head">
        <h1>{t.schedule.title}</h1>
        <div className="row">
          {firstOpen !== undefined && current !== firstOpen ? (
            <button className="btn small" onClick={() => setTab(firstOpen)}>
              {played ? t.played.jumpOpen : t.schedule.jumpOpen}
            </button>
          ) : null}
          <SeasonPicker season={season} />
        </div>
      </div>
      <PastSeasonNotice season={season} />
      {closedNote ? <Notice tone="ok">{t.played.closed(closedNote.round, closedNote.next)}</Notice> : null}
      {preseason ? (
        <div className="card">
          <p className="help">{shape.build === 'manual' ? t.schedule.notStartedManual : played ? t.played.notStarted : t.schedule.notStarted}</p>
        </div>
      ) : null}
      {rounds.length > 0 ? (
        <div className="round-tabs">
          {rounds.map((r) => {
            const s = stateOf(r)
            // A session being played isn't half-built: it has no fixed size.
            const status = s.done ? 'done' : s.list.length === 0 ? 'empty' : !s.full && !played ? 'partial' : 'ready'
            return (
              <button
                key={r}
                className={`${current === r ? 'on' : ''} ${status}`}
                aria-pressed={current === r}
                aria-label={played ? t.played.sessionTab(r, s.done ? 'closed' : s.list.length === 0 ? 'empty' : 'open') : t.schedule.roundTab(r, status)}
                title={shape.perRound > 0 && !s.full ? t.schedule.built(s.list.length, shape.perRound) : undefined}
                onClick={() => setTab(r)}
              >
                {played ? t.played.session(r) : r}
                {s.done ? <span className="mark" aria-hidden="true">✓</span> : null}
              </button>
            )
          })}
          {playoff.length > 0 ? (
            <button className={current === 'playoffs' ? 'on' : ''} aria-pressed={current === 'playoffs'} onClick={() => setTab('playoffs')}>
              {t.schedule.playoffsTab}
            </button>
          ) : null}
        </div>
      ) : null}
      {current !== null ? (
        <div className="card flush">
          <div className="card-head" style={{ padding: '12px 16px' }}>
            <h2>{current === 'playoffs' ? t.schedule.playoffsTab : roundName(current)}</h2>
            {round && shape.perRound > 0 && !round.full ? <Badge tone="warn">{t.schedule.built(round.list.length, shape.perRound)}</Badge> : null}
            {played && typeof current === 'number' && !season.past ? (
              current === session ? <Badge tone="accent">{t.played.openBadge}</Badge> : <Badge>{t.played.closedBadge}</Badge>
            ) : null}
          </div>
          {shown.length === 0 ? (
            <p className="help" style={{ padding: 16 }}>
              {round && shape.editable ? (played ? (current === session ? t.played.emptySession : t.schedule.noGames) : t.schedule.emptyRound) : t.schedule.noGames}
            </p>
          ) : null}
          <div className="games">
            {shown.map((g) => (
              <GameLine
                key={g.id}
                game={g}
                waiting={waiting}
                warnings={warnings[g.id] ?? NO_WARNINGS}
                onWarnings={(w) => setWarnings((prev) => ({ ...prev, [g.id]: w }))}
                onSaved={saved}
                scheduling={shape.editable}
                readOnly={season.past}
                openBox={g.id === askedGame}
              />
            ))}
          </div>
          {round && current !== 'playoffs' && current !== null && shape.editable && played ? (
            current === session ? (
              <>
                {/* Keyed by session: a school picked in one session mustn't carry over to the next. */}
                <PairPicker key={current} refreshKey={regular.map((g) => `${g.id}:${g.status}:${g.home}:${g.away}`).join(',')} onAdded={saved} />
                {round.list.length > 0 ? (
                  <EndDay
                    session={current}
                    games={round.list}
                    onClosed={(r) => {
                      setClosedNote(r)
                      setTab(r.next)
                      setTick((x) => x + 1)
                    }}
                    onChanged={saved}
                  />
                ) : null}
              </>
            ) : (
              <p className="help" style={{ padding: '0 16px 12px' }}>
                {t.played.closedSession}
              </p>
            )
          ) : null}
          {round && current !== 'playoffs' && current !== null && shape.editable && !played ? (
            // Keyed by round: a school picked in one round mustn't carry over to another.
            <RoundBuilder key={current} round={current} games={round.list} perRound={shape.perRound} onChanged={saved} />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const NO_WARNINGS: BoxIssue[] = []

/** Box lines being typed: per player, the team he played for and his stats as text. */
type Lines = Record<string, { teamId: string; stats: Record<string, string> }>

/** An open box score: each team's rows (fixed when opened) and the lines typed so far. */
interface Box {
  rows: Record<string, string[]>
  lines: Lines
}

function GameLine({
  game,
  waiting,
  warnings,
  onWarnings,
  onSaved,
  scheduling,
  readOnly,
  openBox: openAtStart = false,
}: {
  game: GameRow
  waiting: Set<string>
  warnings: BoxIssue[]
  onWarnings: (w: BoxIssue[]) => void
  onSaved: () => void
  /** Unplayed regular-season games can be flipped or taken out. */
  scheduling: boolean
  /** A past season's game: its box score can be looked at, nothing else. */
  readOnly: boolean
  /** 경기일's 직접 입력 asked for this game: its box score opens (and it scrolls into view) at once. */
  openBox?: boolean
}) {
  const { league } = useLeague()
  const phase = league.season.phase
  const team = (id: string) => league.teams.find((tm) => tm.id === id)
  const [editing, setEditing] = useState(false)
  const [home, setHome] = useState(game.homeScore?.toString() ?? '')
  const [away, setAway] = useState(game.awayScore?.toString() ?? '')
  const [showBox, setShowBox] = useState(false)
  const [box, setBox] = useState<Box | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const blocked = !readOnly && game.status === 'scheduled' && (waiting.has(game.home) || waiting.has(game.away))
  const open = !readOnly && (editing || game.status === 'scheduled')
  // Regular games can be changed only in the regular season, playoff games only in the playoffs (and never a past season's).
  const editable = !readOnly && (game.stage === 'regular' ? phase === 'regular' : phase === 'playoffs')

  // Back to what is stored: scores from the game, box score refetched next time.
  const reset = () => {
    setHome(game.homeScore?.toString() ?? '')
    setAway(game.awayScore?.toString() ?? '')
    setBox(null)
    setShowBox(false)
    setError(null)
  }

  const openBox = async () => {
    setShowBox(true)
    if (box !== null) return
    setError(null)
    try {
      const stored = game.hasBox ? await call('season.boxScore', league.slug, game.id) : []
      const lines: Lines = {}
      for (const l of stored) {
        lines[l.playerId] = { teamId: l.teamId, stats: Object.fromEntries(Object.entries(l.stats).map(([k, v]) => [k, String(v)])) }
      }
      // Stored lines first, then current players who have no line (for either team). Looking only: just the stored lines.
      const rows: Record<string, string[]> = {}
      for (const teamId of [game.home, game.away]) {
        const kept = stored.filter((l) => l.teamId === teamId).map((l) => l.playerId)
        rows[teamId] = readOnly ? kept : [...kept, ...rosterOf(league, teamId).map((p) => p.id).filter((id) => !(id in lines))]
      }
      setBox({ rows, lines })
    } catch (e) {
      setError(e)
      setShowBox(false)
    }
  }

  // Asked for from 경기일 (직접 입력): the box score opens ready to type, once.
  const line = useRef<HTMLDivElement>(null)
  const asked = useRef(openAtStart)
  useEffect(() => {
    if (!asked.current) return
    asked.current = false
    line.current?.scrollIntoView({ block: 'center' })
    if (open) void openBox()
  })

  const homeWon = game.status === 'final' && (game.homeScore ?? 0) > (game.awayScore ?? 0)
  const valid = home.trim() !== '' && away.trim() !== '' && Number.isInteger(Number(home)) && Number.isInteger(Number(away))
  const canSave = !busy && valid && !blocked && editable

  const save = async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    onWarnings([])
    try {
      const boxLines =
        box === null
          ? null
          : Object.entries(box.lines)
              .filter(([, line]) => Object.values(line.stats).some((v) => v.trim() !== ''))
              .map(([playerId, { teamId, stats }]) => ({
                playerId,
                teamId,
                stats: Object.fromEntries(
                  Object.entries(stats)
                    .filter(([, v]) => v.trim() !== '')
                    .map(([k, v]) => [k, Number(v)]),
                ),
              }))
      const result = await call('season.recordScore', league.slug, {
        gameId: game.id,
        homeScore: Number(home),
        awayScore: Number(away),
        lines: boxLines,
      })
      onWarnings(result.warnings)
      setEditing(false)
      setShowBox(false)
      setBox(null)
      onSaved()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) void save()
  }

  /** 기록 취소: back to unplayed after a confirmation; the engine refuses (with the reason) where it isn't safe. */
  const unrecord = async () => {
    if (busy || !window.confirm(t.schedule.confirmUnrecord(teamName(game.home), teamName(game.away), `${game.homeScore} : ${game.awayScore}`))) return
    setBusy(true)
    setError(null)
    onWarnings([])
    try {
      await call('season.unrecord', league.slug, game.id)
      setEditing(false)
      setShowBox(false)
      setBox(null)
      setHome('')
      setAway('')
      onSaved()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const changeable = scheduling && game.stage === 'regular' && game.status === 'scheduled'
  const change = async (fn: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await fn()
      onSaved()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const name = (id: string) => league.players.find((p) => p.id === id)?.name ?? id
  const teamName = (id: string) => team(id)?.shortName ?? id
  const columnName = (id: string) => league.config.stats.columns.find((c) => c.id === id)?.name ?? id
  const warningText = (w: BoxIssue) =>
    w.code === 'line-points'
      ? t.box['line-points']({ player: name(w.playerId), points: w.points, expected: w.expected })
      : w.code === 'team-points'
        ? t.box['team-points']({ team: teamName(w.teamId), points: w.points, score: w.score })
        : t.box['made-over-attempts']({ player: name(w.playerId), column: columnName(w.column) })

  return (
    <div className="game-line" ref={line}>
      <div className="game-main">
        {game.stage !== 'regular' ? <Badge tone="info">{`${t.schedule.stages[game.stage]} · ${t.schedule.gameNo(game.round)}`}</Badge> : null}
        <span className={`gteam ${homeWon ? 'won' : ''}`}>
          {teamName(game.home)} <span className="muted">{t.schedule.home}</span>
        </span>
        {open ? (
          <span className="row" style={{ gap: 6 }}>
            <input
              className="score"
              inputMode="numeric"
              aria-label={`${teamName(game.home)} ${t.schedule.home}`}
              value={home}
              onChange={(e) => setHome(e.target.value.replace(/[^0-9]/g, ''))}
              onKeyDown={onEnter}
            />
            :
            <input
              className="score"
              inputMode="numeric"
              aria-label={`${teamName(game.away)} ${t.schedule.away}`}
              value={away}
              onChange={(e) => setAway(e.target.value.replace(/[^0-9]/g, ''))}
              onKeyDown={onEnter}
            />
          </span>
        ) : (
          <span className="final-score">
            {game.homeScore} : {game.awayScore}
          </span>
        )}
        <span className={`gteam ${game.status === 'final' && !homeWon ? 'won' : ''}`}>
          {teamName(game.away)} <span className="muted">{t.schedule.away}</span>
        </span>
        <span className="row" style={{ marginLeft: 'auto', gap: 6 }}>
          {changeable ? (
            <>
              <button
                className="btn small ghost"
                disabled={busy}
                title={t.schedule.build.flip}
                aria-label={`${teamName(game.home)}–${teamName(game.away)} ${t.schedule.build.flip}`}
                onClick={() => void change(() => call('schedule.flip', league.slug, game.id))}
              >
                ⇄
              </button>
              <button
                className="btn small ghost"
                disabled={busy}
                title={t.schedule.build.remove}
                aria-label={`${teamName(game.home)}–${teamName(game.away)} ${t.schedule.build.remove}`}
                onClick={() => void change(() => call('schedule.remove', league.slug, game.id))}
              >
                ✕
              </button>
            </>
          ) : null}
          {blocked ? <Badge tone="warn">{t.schedule.waiting2k}</Badge> : null}
          {game.hasBox && !open && !readOnly ? <Badge>{t.schedule.box}</Badge> : null}
          {readOnly && game.hasBox ? (
            <button className="btn small" onClick={() => (showBox ? setShowBox(false) : void openBox())}>
              {showBox ? t.schedule.hideBox : t.schedule.box}
            </button>
          ) : null}
          {open ? (
            <>
              <button className="btn small" onClick={() => (showBox ? setShowBox(false) : void openBox())}>
                {showBox ? t.schedule.hideBox : t.schedule.box}
              </button>
              {editing ? (
                <button
                  className="btn small ghost"
                  onClick={() => {
                    reset()
                    setEditing(false)
                  }}
                >
                  {t.schedule.cancel}
                </button>
              ) : null}
              {editing && game.status === 'final' ? (
                <button className="btn small danger" disabled={busy} onClick={() => void unrecord()}>
                  {t.schedule.unrecord}
                </button>
              ) : null}
              <button className="btn small primary" disabled={!canSave} onClick={() => void save()}>
                {game.status === 'final' ? t.schedule.save : t.schedule.record}
              </button>
            </>
          ) : editable ? (
            <button
              className="btn small"
              onClick={() => {
                reset()
                setEditing(true)
              }}
            >
              {t.schedule.edit}
            </button>
          ) : null}
        </span>
      </div>
      {(open || readOnly) && showBox && box !== null ? <BoxEditor game={game} box={box} onChange={setBox} readOnly={readOnly} /> : null}
      {error ? <RuleErrors error={error} format={withTeamNames(teamName)} /> : null}
      {warnings.length > 0 ? (
        <Notice tone="warn">
          <IssueList items={warnings.map((w) => ({ level: 'warning' as const, text: warningText(w) }))} />
        </Notice>
      ) : null}
    </div>
  )
}

function BoxEditor({ game, box, onChange, readOnly }: { game: GameRow; box: Box; onChange: (b: Box) => void; readOnly: boolean }) {
  const { league } = useLeague()
  const columns = league.config.stats.columns
  const players = useMemo(() => new Map(league.players.map((p) => [p.id, p])), [league.players])
  // Each player sits in one team's rows, so his line is always that team's.
  const set = (playerId: string, teamId: string, col: string, value: string) => {
    const stats = { ...box.lines[playerId]?.stats, [col]: value.replace(/[^0-9]/g, '') }
    onChange({ ...box, lines: { ...box.lines, [playerId]: { teamId, stats } } })
  }

  return (
    <div className="box-editor">
      {readOnly ? null : <p className="help">{t.schedule.boxHelp}</p>}
      {[game.home, game.away].map((teamId) => (
        <div key={teamId} className="table-wrap">
          <table className="data compact">
            <thead>
              <tr>
                <th>{league.teams.find((tm) => tm.id === teamId)?.shortName}</th>
                {columns.map((c) => (
                  <th key={c.id} className="center">
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(box.rows[teamId] ?? []).map((id) => {
                const playerName = players.get(id)?.name ?? id
                return (
                  <tr key={id}>
                    <td>{playerName}</td>
                    {columns.map((c) => (
                      <td key={c.id} className="center">
                        <input
                          className="stat"
                          inputMode="numeric"
                          aria-label={`${playerName} ${c.name}`}
                          value={box.lines[id]?.stats[c.id] ?? ''}
                          readOnly={readOnly}
                          onChange={(e) => set(id, teamId, c.id, e.target.value)}
                        />
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

/**
 * Building a round by hand: pick the home school, then its opponent. Each
 * possible opponent is checked against the rest of the season first, so a
 * pairing that would leave later rounds impossible to fill is greyed out.
 * 자동 채우기 completes the round; 비우기 takes out its unplayed games.
 */
function RoundBuilder({ round, games, perRound, onChanged }: { round: number; games: GameRow[]; perRound: number; onChanged: () => void }) {
  const { league } = useLeague()
  const slug = league.slug
  const b = t.schedule.build
  const [pick, setPick] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const signature = games.map((g) => `${g.id}:${g.home}:${g.away}`).join(',')
  const options = useLoad(() => (pick ? call('schedule.options', slug, round, pick) : Promise.resolve(null)), [`${round}:${pick}:${signature}`])
  const placed = new Set(games.flatMap((g) => [g.home, g.away]))
  const free = league.teams.filter((tm) => !placed.has(tm.id))
  const full = games.length >= perRound
  const unplayed = games.filter((g) => g.status === 'scheduled').length
  const name = (id: string) => league.teams.find((tm) => tm.id === id)?.shortName ?? id

  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await fn()
      setPick(null)
      onChanged()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const ready = options.state === 'ready' && options.value !== null ? options.value : null
  return (
    <div className="round-builder">
      <div className="row">
        <strong>{b.title(games.length, perRound)}</strong>
        <span className="row" style={{ marginLeft: 'auto', gap: 6 }}>
          {!full ? (
            <button className="btn small primary" disabled={busy} onClick={() => void act(() => call('schedule.fill', slug, round))}>
              {b.fill}
            </button>
          ) : null}
          {unplayed > 0 ? (
            <button
              className="btn small ghost"
              disabled={busy}
              onClick={() => {
                if (window.confirm(b.confirmClear(round, unplayed))) void act(() => call('schedule.clear', slug, round))
              }}
            >
              {b.clear}
            </button>
          ) : null}
        </span>
      </div>
      {full ? (
        <p className="help">{b.full}</p>
      ) : (
        <>
          <p className="help">
            {pick
              ? `${b.pickAway(name(pick))}${ready ? ` (${b.venue(ready.self.home, ready.self.away)})` : ''}`
              : b.pickHome}
          </p>
          <div className="team-chips">
            {free.map((tm) => {
              const isPick = pick === tm.id
              const option = !isPick && ready ? ready.options.find((o) => o.teamId === tm.id) : undefined
              const status = option?.status
              const checking = pick !== null && !isPick && ready === null
              const blocked = status === 'met' || status === 'dead-end' || status === 'placed'
              return (
                <button
                  key={tm.id}
                  className={`team-chip ${isPick ? 'on' : ''} ${status ?? ''}`}
                  disabled={busy || checking || blocked}
                  title={status && status !== 'ok' ? b.why[status] : undefined}
                  aria-pressed={isPick}
                  onClick={() => {
                    if (isPick) setPick(null)
                    else if (pick) void act(() => call('schedule.add', slug, { round, home: pick, away: tm.id }))
                    else setPick(tm.id)
                  }}
                >
                  {tm.shortName}
                  {option ? <span className="muted"> {b.venueShort(option.home, option.away)}</span> : null}
                </button>
              )
            })}
          </div>
          {pick && options.state === 'loading' ? <p className="help">{b.checking}</p> : null}
          {options.state === 'error' ? <RuleErrors error={options.error} /> : null}
        </>
      )}
      {error ? <RuleErrors error={error} /> : null}
    </div>
  )
}
