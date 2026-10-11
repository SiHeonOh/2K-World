import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import type { AiStatus } from '@shared/ai'
import { confirmIssues, rowsPoints, suggestedScore, type ConfirmSide } from '@shared/boxcheck'
import type { ConfirmIssue, ConfirmView, GameRef, JobInfo, ReadRow, ReadTeam } from '@shared/gameday'
import type { BoxIssue } from '@shared/season'
import { ApiError, call } from '../../api'
import { AiStatusCard, QueueNotice } from '../../components/AiStatusCard'
import { Badge, ErrorBox, IssueList, Loading, Notice, Select } from '../../components/ui'
import { useLoad } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { LockerRoom } from './LockerRoom'
import { PlayedPanel, usePlayed, useRoundName } from './Played'
import { RuleErrors, ruleText, withTeamNames } from './RuleErrors'

/** A box score usually takes two screenshots (one per team). */
const MAX_PAIR = 2

interface Shot {
  token: string
  url: string
}

const MAX_SHOTS = 4
const POLL_MS = 1000
const waiting = (j: JobInfo | null) => j !== null && (j.status === 'queued' || j.status === 'running')

/** Refusals from the game-day steps, in Korean; anything else as the League engine explains it. */
function GameDayErrors({ error, teamName }: { error: unknown; teamName: (id: string) => string }) {
  if (error instanceof ApiError && error.code === 'rule' && error.shape.rules) {
    const format = withTeamNames(teamName)
    return (
      <Notice tone="err">
        <IssueList
          items={error.shape.rules.map((r) => {
            const fn = t.gameday.refusals[r.code]
            return { level: 'error' as const, text: fn ? fn(format(r.params)) : ruleText(r.code, format(r.params)) }
          })}
        />
      </Notice>
    )
  }
  return <RuleErrors error={error} />
}

/** Paste two box-score screenshots, let Claude read them, confirm, record. */
export function GameDay() {
  const { league, reload } = useLeague()
  const slug = league.slug
  const [tick, setTick] = useState(0)
  const games = useLoad(() => call('season.games', slug), [slug, tick], { keepPrevious: true })
  // Whether regular-season games are still to be built (rounds built by hand), for the empty-picker message.
  const schedule = useLoad(() => call('schedule.info', slug), [slug, tick], { keepPrevious: true })
  // (Shown when nothing is left to play: then every game built is played, so unplayed means unbuilt.)
  const roundsToBuild = schedule.state === 'ready' && schedule.value.editable && schedule.value.played < schedule.value.total
  // 2K 일정대로: the game just played is picked here, and 오늘 경기 끝 closes the session.
  const played = usePlayed()
  const session = played && schedule.state === 'ready' && schedule.value.editable ? (schedule.value.session ?? null) : null
  const roundName = useRoundName()
  const [ai, setAi] = useState<AiStatus | null>(null)
  const [gameId, setGameId] = useState<number | null>(null)
  const [shots, setShotsState] = useState<Shot[]>([])
  const [jobId, setJobId] = useState<number | null>(null)
  const [job, setJob] = useState<JobInfo | null>(null)
  const [view, setView] = useState<ConfirmView | null>(null)
  const [flip, setFlip] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState<BoxIssue[] | null>(null)
  /** When the shown job was picked up from an earlier visit: its start time. */
  const [resumed, setResumed] = useState<string | null>(null)
  const [tooMany, setTooMany] = useState(false)
  const [starting, setStarting] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [lookingUp, setLookingUp] = useState(false)

  // Shots live in a ref too, so async saves and unmount cleanup see the latest list.
  const shotsRef = useRef<Shot[]>([])
  const pendingSaves = useRef(0)
  const startingRef = useRef(false)
  /** Bumped whenever the shown job changes by hand, so a slower lookup doesn't replace it. */
  const lookup = useRef(0)
  const alive = useRef(true)
  const setShots = useCallback((next: Shot[]) => {
    shotsRef.current = next
    setShotsState(next)
  }, [])
  const discard = useCallback((token: string) => void call('gameday.discardImage', slug, token).catch(() => undefined), [slug])

  // Leaving the screen (or the league): screenshots that weren't read are deleted.
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      for (const s of shotsRef.current) {
        URL.revokeObjectURL(s.url)
        void call('gameday.discardImage', slug, s.token).catch(() => undefined)
      }
      shotsRef.current = []
      setShotsState([])
    }
  }, [slug])

  useEffect(() => {
    let on = true
    void call('ai.status', slug).then((s) => on && setAi(s))
    return () => {
      on = false
    }
  }, [slug])

  const teamName = useCallback((id: string) => league.teams.find((tm) => tm.id === id)?.shortName ?? id, [league.teams])
  const open = useMemo(() => (games.state === 'ready' ? games.value.filter((g) => g.status === 'scheduled') : []), [games])
  const current = open.find((g) => g.id === gameId) ?? open[0] ?? null
  const currentId = current?.id ?? null
  // Moves still to make in 2K block recording a game of those teams: said before a read is spent, not at the save.
  const checklist = useLoad(() => call('checklist.list', slug), [slug, tick], { keepPrevious: true })
  const waiting2k = useMemo(
    () => new Set((checklist.state === 'ready' ? checklist.value : []).filter((c) => c.appliedAt === null).flatMap((c) => c.teamIds)),
    [checklist],
  )
  const blocked = current ? [current.home, current.away].filter((id) => waiting2k.has(id)) : []

  // Picking a game picks up its latest reading where it was left: still waiting, failed, or read but not
  // recorded. Only scheduled games are listed, so a reading that was confirmed (its game is final) never comes back.
  useEffect(() => {
    setJobId(null)
    setJob(null)
    setView(null)
    setFlip(false)
    setResumed(null)
    if (currentId === null) return
    const gen = ++lookup.current
    setLookingUp(true)
    call('gameday.jobs', slug, currentId)
      .then((jobs) => {
        if (gen !== lookup.current) return
        const latest = jobs[0]
        if (!latest || latest.status === 'cancelled') return
        setJob(latest)
        setJobId(latest.id)
        setResumed(latest.createdAt)
      })
      .catch((e) => gen === lookup.current && setError(e))
      .finally(() => gen === lookup.current && setLookingUp(false))
    return () => {
      // A newer lookup (or none) takes over.
      if (gen === lookup.current) {
        lookup.current++
        setLookingUp(false)
      }
    }
  }, [slug, currentId])

  // While the job waits, poll it and the queue together.
  useEffect(() => {
    if (jobId === null) return
    let on = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async () => {
      timer = null
      try {
        const [j, s] = await Promise.all([call('gameday.job', slug, jobId), call('ai.status', slug)])
        if (!on) return
        setJob(j)
        setAi(s)
        if (waiting(j)) timer = setTimeout(() => void poll(), POLL_MS)
      } catch (e) {
        if (on) setError(e)
      }
    }
    void poll()
    return () => {
      on = false
      if (timer) clearTimeout(timer)
    }
  }, [jobId, slug])

  // Once read, fetch the confirm view (again after a side swap).
  const readDone = job !== null && job.id === jobId && job.status === 'done'
  useEffect(() => {
    if (!readDone || jobId === null) return
    let on = true
    call('gameday.confirmView', slug, jobId, flip)
      .then((v) => on && setView(v))
      .catch((e) => on && setError(e))
    return () => {
      on = false
    }
  }, [readDone, jobId, slug, flip])

  const adding = current !== null && jobId === null && view === null && !lookingUp

  // Screenshots: pasted (only while adding them), dropped or picked; four at most.
  const addFiles = useCallback(
    async (files: File[]) => {
      setError(null)
      setTooMany(false)
      for (const file of files.filter((f) => f.type.startsWith('image/'))) {
        if (shotsRef.current.length + pendingSaves.current >= MAX_SHOTS) {
          setTooMany(true)
          break
        }
        pendingSaves.current++
        try {
          const bytes = new Uint8Array(await file.arrayBuffer())
          const { token } = await call('gameday.saveImage', slug, bytes)
          if (!alive.current || shotsRef.current.length >= MAX_SHOTS) {
            discard(token)
            continue
          }
          setShots([...shotsRef.current, { token, url: URL.createObjectURL(file) }])
        } catch (e) {
          setError(e)
        } finally {
          pendingSaves.current--
        }
      }
    },
    [slug, discard, setShots],
  )
  useEffect(() => {
    if (!adding) return
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])]
      if (files.length > 0) void addFiles(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [adding, addFiles])

  const folderInfo = useLoad(() => call('gameday.screenshotFolder'), [])
  const shotFolder = folderInfo.state === 'ready' ? folderInfo.value.folder : null
  const [importing, setImporting] = useState(false)
  /** The newest screenshots from the 2K screenshot folder, as if pasted. */
  const importLatest = async () => {
    if (importing) return
    setImporting(true)
    setError(null)
    try {
      const { files } = await call('gameday.latestShots', Math.max(1, MAX_PAIR - shotsRef.current.length))
      if (files.length === 0) throw new Error(g.folderEmpty)
      // Oldest first, the order they were taken in.
      await addFiles(
        [...files].reverse().map((f) => new File([f.bytes as BlobPart], f.name, { type: /\.png$/i.test(f.name) ? 'image/png' : 'image/jpeg' })),
      )
    } catch (e) {
      setError(e)
    } finally {
      setImporting(false)
    }
  }

  const removeShot = (token: string) => {
    const shot = shotsRef.current.find((s) => s.token === token)
    if (!shot) return
    URL.revokeObjectURL(shot.url)
    setShots(shotsRef.current.filter((s) => s.token !== token))
    setTooMany(false)
    discard(token)
  }

  const start = async () => {
    if (!current || startingRef.current || shotsRef.current.length === 0) return
    startingRef.current = true
    setStarting(true)
    setError(null)
    setSaved(null)
    try {
      const sent = shotsRef.current
      const { jobId: id } = await call('gameday.read', slug, current.id, sent.map((s) => s.token))
      // The files moved into the game's folder; only the previews go.
      for (const s of sent) URL.revokeObjectURL(s.url)
      setShots(shotsRef.current.filter((s) => !sent.includes(s)))
      lookup.current++
      setView(null)
      setFlip(false)
      setResumed(null)
      setJob(null)
      setJobId(id)
    } catch (e) {
      setError(e)
    } finally {
      startingRef.current = false
      setStarting(false)
    }
  }

  const retry = async () => {
    if (!job || retrying) return
    setRetrying(true)
    setError(null)
    try {
      const { jobId: id } = await call('gameday.retry', slug, job.id)
      lookup.current++
      setResumed(null)
      setJob(null)
      setJobId(id)
    } catch (e) {
      setError(e)
    } finally {
      setRetrying(false)
    }
  }

  /** Back to adding screenshots for this game. */
  const startOver = () => {
    lookup.current++
    setLookingUp(false)
    setJobId(null)
    setJob(null)
    setView(null)
    setFlip(false)
    setResumed(null)
    setError(null)
  }

  const ready = ai ? ai.claude.installed && ai.claude.loggedIn && !ai.billing : false
  const playerName = (id: string) => league.players.find((p) => p.id === id)?.name ?? id
  const statName = (id: string) => league.config.stats.columns.find((c) => c.id === id)?.name ?? id
  const boxText = (w: BoxIssue) =>
    w.code === 'line-points'
      ? t.box['line-points']({ player: playerName(w.playerId), points: w.points, expected: w.expected })
      : w.code === 'team-points'
        ? t.box['team-points']({ team: teamName(w.teamId), points: w.points, score: w.score })
        : t.box['made-over-attempts']({ player: playerName(w.playerId), column: statName(w.column) })
  const g = t.gameday
  const shownJob = job !== null && job.id === jobId ? job : null

  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <h1>{g.title}</h1>
          <p className="sub">{g.intro}</p>
        </div>
      </div>
      {ai && !ready ? <AiStatusCard status={ai} onChange={setAi} /> : null}
      {ai?.fake ? <Notice tone="info">{t.ai.demo}</Notice> : null}
      {error ? <GameDayErrors error={error} teamName={teamName} /> : null}
      {saved ? (
        <Notice tone="ok">
          {g.saved}
          {saved.length > 0 ? <IssueList items={saved.map((w) => ({ level: 'warning' as const, text: boxText(w) }))} /> : null}
        </Notice>
      ) : null}

      {view === null && session !== null && games.state === 'ready' ? (
        <PlayedPanel
          session={session}
          games={games.value}
          onAdded={(id) => {
            setError(null)
            setSaved(null)
            setGameId(id)
            setTick((x) => x + 1)
          }}
          onChanged={() => setTick((x) => x + 1)}
        />
      ) : null}
      {view === null && current && adding ? (
        <div className="grid-2 pregame">
          <LockerRoom key={`h-${current.home}`} teamId={current.home} title={`${t.mood.pregame} · ${teamName(current.home)}`} compact />
          <LockerRoom key={`a-${current.away}`} teamId={current.away} title={`${t.mood.pregame} · ${teamName(current.away)}`} compact />
        </div>
      ) : null}
      {view === null ? (
        <div className="card">
          {games.state === 'loading' || lookingUp ? <Loading /> : null}
          {games.state === 'error' ? <ErrorBox error={games.error} onRetry={games.reload} /> : null}
          {games.state === 'ready' && open.length === 0 ? (
            session !== null ? (
              <p className="help">{t.played.noOpenGames}</p>
            ) : roundsToBuild ? (
              <p className="help">
                {g.noGamesManual} <Link to={`/l/${encodeURIComponent(league.slug)}/schedule`}>{g.toSchedule}</Link>
              </p>
            ) : (
              <p className="help">{g.noGames}</p>
            )
          ) : null}
          {current ? (
            <div className="row">
              <span className="label">{g.game}</span>
              <Select
                ariaLabel={g.pickGame}
                value={String(current.id)}
                options={open.slice(0, 60).map((x) => ({
                  value: String(x.id),
                  label: `${x.stage === 'regular' ? roundName(x.round) : t.schedule.stages[x.stage]} · ${teamName(x.home)} vs ${teamName(x.away)}${
                    waiting2k.has(x.home) || waiting2k.has(x.away) ? ` · ${g.waiting2kShort}` : ''
                  }`,
                }))}
                onChange={(v) => {
                  setError(null)
                  setGameId(Number(v))
                }}
              />
              {/* No screenshots? Type the score and box score in 일정: this game, its box score open. */}
              <Link
                className="btn small"
                to={`/l/${encodeURIComponent(league.slug)}/schedule?${current.stage === 'regular' ? `round=${current.round}` : 'tab=playoffs'}&game=${current.id}`}
              >
                ✎ {g.typeInstead}
              </Link>
            </div>
          ) : null}
          {current && adding ? <p className="help">{t.played.typeHelp}</p> : null}
          {blocked.length > 0 ? (
            <Notice tone="warn">
              {g.blocked2k(blocked.map(teamName).join(', '))} <Link to={`/l/${encodeURIComponent(league.slug)}/inbox`}>{g.toInbox}</Link>
            </Notice>
          ) : null}
          {adding ? (
            <div
              className="dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                void addFiles([...e.dataTransfer.files])
              }}
            >
              <p>{g.paste}</p>
              {shotFolder ? (
                <button className="btn small primary" disabled={importing} onClick={() => void importLatest()}>
                  {g.fromFolder(Math.max(1, MAX_PAIR - shots.length))}
                </button>
              ) : (
                <p className="help">{g.noFolder}</p>
              )}
              <label className="btn small">
                {g.pick}
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  multiple
                  hidden
                  onChange={(e) => {
                    void addFiles([...(e.target.files ?? [])])
                    e.target.value = ''
                  }}
                />
              </label>
              {shots.length > 0 ? (
                <div className="shots">
                  {shots.map((s, i) => (
                    <figure key={s.token}>
                      <img src={s.url} alt={g.shots(i + 1)} />
                      <button className="btn ghost small" onClick={() => removeShot(s.token)}>
                        {g.remove}
                      </button>
                    </figure>
                  ))}
                </div>
              ) : null}
              {tooMany ? <p className="help">{g.tooMany}</p> : null}
            </div>
          ) : null}
          {adding ? (
            <div className="row">
              <button className="btn primary" disabled={shots.length === 0 || !ready || starting || blocked.length > 0} onClick={() => void start()}>
                {g.read}
              </button>
              {starting ? <span className="spin" /> : null}
              {shots.length > 0 ? <span className="muted">{g.shots(shots.length)}</span> : null}
              {!ready && ai ? <span className="muted">{g.notReady}</span> : null}
            </div>
          ) : null}
          {current && jobId !== null && resumed ? <Notice tone="info">{g.resumed(new Date(resumed).toLocaleString())}</Notice> : null}
          {current && shownJob ? (
            <div className="row">
              {waiting(shownJob) ? (
                <>
                  <span className="spin" /> {shownJob.status === 'queued' ? g.queued : g.reading}
                </>
              ) : null}
              {shownJob.status === 'done' && !error ? <Loading /> : null}
              {shownJob.status === 'done' && error ? (
                <button className="btn ghost" onClick={startOver}>
                  {g.startOver}
                </button>
              ) : null}
              {shownJob.status === 'failed' || shownJob.status === 'cancelled' ? (
                <>
                  <Notice tone="err">
                    {g.failed}
                    {shownJob.errorKind ? ` · ${t.ai.errorKinds[shownJob.errorKind] ?? shownJob.errorKind}` : ''}
                    {shownJob.error ? `: ${shownJob.error}` : ''}
                  </Notice>
                  <button className="btn" disabled={retrying || !ready || blocked.length > 0} onClick={() => void retry()}>
                    {g.retryRead}
                  </button>
                  <button className="btn ghost" onClick={startOver}>
                    {g.startOver}
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
          {current ? <QueueNotice status={ai} job={shownJob} onChange={setAi} /> : null}
        </div>
      ) : (
        <Confirm
          key={view.jobId}
          view={view}
          onFlip={() => setFlip((f) => !f)}
          onCancel={startOver}
          onSaved={(w) => {
            setSaved(w)
            startOver()
            setTick((x) => x + 1)
            reload()
          }}
        />
      )}
    </div>
  )
}

/**
 * The user's changes on the confirm screen, kept apart from what was read.
 * Stats are keyed by read team and row, so they survive a side swap; player
 * picks are keyed by team too (a pick only makes sense for that team), so
 * swapping back brings them back. A final score typed by hand is keyed by
 * read team too; one not typed follows the suggestion (the screenshot's
 * total, else the rows' sum) as the rows are edited.
 */
type Picks = Record<string, string | null>
type Stats = Record<string, Record<string, number>>
type Finals = Record<number, string>

/** The screenshots a reading was made from, as object URLs (revoked when the screen goes). */
function useReadShots(slug: string, jobId: number, count: number): string[] {
  const [urls, setUrls] = useState<string[]>([])
  useEffect(() => {
    if (count === 0) return
    let on = true
    let made: string[] = []
    call('gameday.shots', slug, jobId)
      .then(({ files }) => {
        made = files.map((f) => URL.createObjectURL(new Blob([f.bytes as BlobPart], { type: /\.png$/i.test(f.name) ? 'image/png' : 'image/jpeg' })))
        if (on) setUrls(made)
        else for (const u of made) URL.revokeObjectURL(u)
      })
      // Gone or unreadable: the tables still show.
      .catch(() => undefined)
    return () => {
      on = false
      for (const u of made) URL.revokeObjectURL(u)
    }
  }, [slug, jobId, count])
  return urls
}

/** Thumbnails beside the confirm tables; one opens large on top (a click or Esc closes it). */
function ReadShots({ urls }: { urls: string[] }) {
  const g = t.gameday
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => {
    if (open === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <aside className="read-shots" aria-label={g.shotsTitle}>
      <div className="read-shots-head">
        <strong>{g.shotsTitle}</strong> <span className="muted">{g.shotsHelp}</span>
      </div>
      {urls.map((u, i) => (
        <button key={u} type="button" className="shot-thumb" aria-label={g.shotAlt(i + 1)} onClick={() => setOpen(i)}>
          <img src={u} alt={g.shotAlt(i + 1)} />
        </button>
      ))}
      {open !== null && urls[open] ? (
        <div className="shot-zoom" role="dialog" aria-modal="true" aria-label={g.shotAlt(open + 1)} onClick={() => setOpen(null)}>
          <img src={urls[open]} alt={g.shotAlt(open + 1)} />
          <button type="button" className="btn small" onClick={() => setOpen(null)}>
            {g.closeShot}
          </button>
        </div>
      ) : null}
    </aside>
  )
}

function Confirm({
  view,
  onFlip,
  onCancel,
  onSaved,
}: {
  view: ConfirmView
  onFlip: () => void
  onCancel: () => void
  onSaved: (warnings: BoxIssue[]) => void
}) {
  const { league } = useLeague()
  const g = t.gameday
  const config = league.config
  const statKey = (team: ReadTeam, row: number) => `${team.readIndex}:${row}`
  const pickKey = (team: ReadTeam, row: number) => `${team.readIndex}:${team.teamId}:${row}`
  const [picks, setPicks] = useState<Picks>({})
  /** Guessed rows ticked 맞아요, by pickKey. */
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [stats, setStats] = useState<Stats>({})
  const [finals, setFinals] = useState<Finals>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const shots = useReadShots(league.slug, view.jobId, view.images)
  const roundName = useRoundName()
  const teamName = (id: string) => league.teams.find((tm) => tm.id === id)?.shortName ?? id
  const statName = (id: string) => config.stats.columns.find((c) => c.id === id)?.name ?? id

  const pickOf = (team: ReadTeam, r: ReadRow): string | null => {
    const k = pickKey(team, r.row)
    return k in picks ? picks[k]! : r.playerId
  }
  const statsOf = (team: ReadTeam, r: ReadRow): Record<string, number> => stats[statKey(team, r.row)] ?? r.stats
  const sides = [view.home, view.away]

  // The final score: typed, or the suggestion. The checks run on the numbers as they stand now.
  const sideOf = (team: ReadTeam): ConfirmSide => ({ teamId: team.teamId, rows: team.rows.map((r) => ({ source: r.source, stats: statsOf(team, r) })), shown: team.shown })
  const homeSide = sideOf(view.home)
  const awaySide = sideOf(view.away)
  const finalOf = (team: ReadTeam, side: ConfirmSide): number => {
    const typed = finals[team.readIndex]
    return typed === undefined ? suggestedScore(config, side) : typed === '' ? NaN : Number(typed)
  }
  const homeScore = finalOf(view.home, homeSide)
  const awayScore = finalOf(view.away, awaySide)
  const scoresOk = Number.isInteger(homeScore) && Number.isInteger(awayScore)
  const tie = scoresOk && homeScore === awayScore
  const issues = scoresOk ? confirmIssues(config, homeSide, awaySide, { home: homeScore, away: awayScore }) : []
  const flipped = issues.find((i) => i.code === 'winner-differs')
  const recordedElsewhere = view.usedFor.filter((u) => u.status === 'final')
  const readElsewhere = view.usedFor.filter((u) => u.status !== 'final')

  const allPicks = sides.flatMap((team) => team.rows.map((r) => pickOf(team, r)))
  const chosen = allPicks.filter((p): p is string => p !== null)
  const duplicate = new Set(chosen).size !== chosen.length
  const unmatched = allPicks.filter((p) => p === null).length
  // A guessed name is remembered for every later game, so it's saved only once you've looked:
  // ticked 맞아요, or picked from its list. Exact and learned names need nothing.
  const needsCheck = (team: ReadTeam, r: ReadRow) =>
    (r.how === 'guess' || r.how === 'elimination') && r.playerId !== null && !(pickKey(team, r.row) in picks)
  const unchecked = sides.flatMap((team) => team.rows.filter((r) => needsCheck(team, r) && !checked[pickKey(team, r.row)])).length
  const canSave =
    !busy && !duplicate && scoresOk && !tie && unchecked === 0 && view.problem === null && recordedElsewhere.length === 0 && view.waiting2k.length === 0

  const gameName = (u: GameRef) => `${g.gameLabel(u.stage, u.round, roundName)} · ${teamName(u.home)} vs ${teamName(u.away)}`
  const issueText = (i: ConfirmIssue): string => {
    switch (i.code) {
      case 'line-points':
        return g.issues['line-points']({ team: teamName(i.teamId), source: i.source, points: i.points, expected: i.expected })
      case 'made-over-attempts':
        return g.issues['made-over-attempts']({ team: teamName(i.teamId), source: i.source, column: statName(i.column) })
      case 'shown-total':
        return g.issues['shown-total']({ team: teamName(i.teamId), rows: i.rows, shown: i.shown })
      case 'final-vs-rows':
        return g.issues['final-vs-rows']({ team: teamName(i.teamId), rows: i.rows, score: i.score })
      case 'winner-differs': {
        const loser = i.winner === view.home.teamId ? view.away.teamId : view.home.teamId
        return g.issues['winner-differs']({
          winner: teamName(i.winner),
          loser: teamName(loser),
          home: teamName(view.home.teamId),
          away: teamName(view.away.teamId),
          homeRows: i.rows.home,
          awayRows: i.rows.away,
        })
      }
    }
  }
  /** Cells a row check points at, keyed by read team and row: the points cell, or the made column. */
  const flagged = new Map<string, Map<string, string>>()
  const pts = config.stats.columns.find((c) => c.meaning === 'points')?.id
  for (const i of issues) {
    if (i.code !== 'line-points' && i.code !== 'made-over-attempts') continue
    const team = i.teamId === view.home.teamId ? view.home : view.away
    const column = i.code === 'line-points' ? pts : i.column
    if (!column) continue
    const cells = flagged.get(statKey(team, i.row)) ?? new Map<string, string>()
    cells.set(column, issueText(i))
    flagged.set(statKey(team, i.row), cells)
  }

  const save = async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      const rows = sides.flatMap((team) =>
        team.rows.flatMap((r) => {
          const playerId = pickOf(team, r)
          return playerId === null ? [] : [{ team, r, playerId }]
        }),
      )
      const result = await call('gameday.confirm', league.slug, {
        jobId: view.jobId,
        gameId: view.gameId,
        homeScore,
        awayScore,
        lines: rows.map(({ team, r, playerId }) => ({ playerId, teamId: team.teamId, stats: statsOf(team, r) })),
        names: rows.map(({ team, r, playerId }) => ({ teamId: team.teamId, source: r.source, playerId, row: r.row })),
      })
      onSaved(result.warnings)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const scoreBox = (team: ReadTeam, side: ConfirmSide, score: number) => {
    const typed = finals[team.readIndex]
    const from = typed !== undefined ? 'typed' : team.shown !== null ? 'shown' : 'rows'
    return (
      <span className="final-box">
        <span className="final-team">{teamName(team.teamId)}</span>
        <input
          className="score"
          inputMode="numeric"
          aria-label={g.scoreLabel(teamName(team.teamId))}
          value={typed ?? String(suggestedScore(config, side))}
          onChange={(e) => {
            const v = e.target.value.replace(/[^0-9]/g, '')
            setFinals((prev) => ({ ...prev, [team.readIndex]: v }))
          }}
        />
        <span className="muted small">
          {g.scoreFrom[from]}
          {typed !== undefined ? (
            <>
              {' · '}
              <button
                type="button"
                className="link"
                onClick={() =>
                  setFinals((prev) => {
                    const { [team.readIndex]: _gone, ...rest } = prev
                    return rest
                  })
                }
              >
                {g.resetScore}
              </button>
            </>
          ) : null}
          {Number.isInteger(score) && from !== 'rows' && rowsPoints(config, side.rows) !== score ? ` · ${g.rowsSum(rowsPoints(config, side.rows))}` : ''}
        </span>
      </span>
    )
  }

  const table = (team: ReadTeam) => {
    const roster = league.players.filter((p) => p.teamId === team.teamId)
    // Anyone else, in case the game was played before a trade.
    const others = league.players.filter((p) => p.teamId !== team.teamId)
    const side = team === view.home ? homeSide : awaySide
    return (
      <div className="card flush">
        <div className="card-head" style={{ padding: '10px 14px' }}>
          <h3>
            {teamName(team.teamId)} <span className="muted">{team.label}</span>
          </h3>
          <span className="muted">
            {g.rowsSum(rowsPoints(config, side.rows))}
            {team.shown !== null ? ` · ${g.shownTotal(team.shown)}` : ''}
          </span>
        </div>
        <div className="table-wrap">
          <table className="data compact">
            <thead>
              <tr>
                <th>{g.source}</th>
                <th>{g.player}</th>
                {config.stats.columns.map((c) => (
                  <th key={c.id} className="center">
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {team.rows.map((r) => {
                const k = pickKey(team, r.row)
                const pick = pickOf(team, r)
                const suggested = pick === r.playerId && !(k in picks)
                const unsure = r.how === 'guess' || r.how === 'elimination' || r.how === 'same-name'
                const check = needsCheck(team, r)
                const tone = pick === null ? 'row-err' : suggested && unsure && !(check && checked[k]) ? 'row-warn' : ''
                const rowStats = statsOf(team, r)
                const cells = flagged.get(statKey(team, r.row))
                return (
                  <tr key={k} className={tone}>
                    <td>
                      {r.source} <span className="muted">{pick === r.playerId ? g.how[r.how] : ''}</span>
                      {check ? (
                        <label className="name-ok" title={g.nameOkHelp}>
                          <input type="checkbox" checked={Boolean(checked[k])} onChange={(e) => setChecked((prev) => ({ ...prev, [k]: e.target.checked }))} />
                          {g.nameOk}
                        </label>
                      ) : null}
                    </td>
                    <td>
                      <select
                        className="compact"
                        aria-label={`${r.source} ${g.player}`}
                        value={pick ?? ''}
                        onChange={(e) => {
                          const v = e.target.value
                          setPicks((prev) => ({ ...prev, [k]: v === '' ? null : v }))
                        }}
                      >
                        <option value="">{g.pickPlayer}</option>
                        <optgroup label={g.rosterGroup}>
                          {roster.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </optgroup>
                        {others.length > 0 ? (
                          <optgroup label={g.othersGroup}>
                            {others.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name} ({teamName(p.teamId)})
                              </option>
                            ))}
                          </optgroup>
                        ) : null}
                      </select>
                    </td>
                    {config.stats.columns.map((c) => {
                      const why = cells?.get(c.id)
                      return (
                        <td key={c.id} className="center">
                          <input
                            className={why ? 'stat flagged' : 'stat'}
                            inputMode="numeric"
                            aria-label={`${r.source} ${c.name}`}
                            aria-invalid={why ? true : undefined}
                            title={why}
                            value={rowStats[c.id] ?? ''}
                            onChange={(e) => {
                              const v = e.target.value.replace(/[^0-9]/g, '')
                              const sk = statKey(team, r.row)
                              setStats((prev) => ({ ...prev, [sk]: { ...(prev[sk] ?? r.stats), [c.id]: v === '' ? 0 : Number(v) } }))
                            }}
                          />
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>{g.confirmTitle}</h2>
          <button className="btn small" onClick={onFlip}>
            {g.swapSides}
          </button>
        </div>
        <p className="help">{g.confirmHelp}</p>
        {view.problem ? <Notice tone="err">{g.problem[view.problem]}</Notice> : null}
        {view.waiting2k.length > 0 ? (
          <Notice tone="err">
            {g.blocked2k(view.waiting2k.map(teamName).join(', '))} <Link to={`/l/${encodeURIComponent(league.slug)}/inbox`}>{g.toInbox}</Link>
          </Notice>
        ) : null}
        {recordedElsewhere.map((u) => (
          <Notice key={u.id} tone="err">
            {g.usedRecorded(gameName(u))}
          </Notice>
        ))}
        {readElsewhere.map((u) => (
          <Notice key={u.id} tone="warn">
            {g.usedElsewhere(gameName(u))}
          </Notice>
        ))}
        {view.sidesUncertain ? <Notice tone="warn">{g.sidesUncertain}</Notice> : null}
        {view.notes ? <Notice tone="info">{g.notes(view.notes)}</Notice> : null}
        <div className="row final-row">
          <span className="label">{g.finalScore}</span>
          {scoreBox(view.home, homeSide, homeScore)}
          <span className="final-colon">:</span>
          {scoreBox(view.away, awaySide, awayScore)}
          {scoresOk && !tie ? <Badge tone="ok">{g.wins(teamName(homeScore > awayScore ? view.home.teamId : view.away.teamId))}</Badge> : null}
        </div>
        <p className="help">{g.finalHelp}</p>
        {flipped ? <Notice tone="err">{issueText(flipped)}</Notice> : null}
      </div>
      <div className={shots.length > 0 ? 'confirm-grid with-shots' : 'confirm-grid'}>
        <div className="confirm-tables">
          {table(view.home)}
          {table(view.away)}
        </div>
        {shots.length > 0 ? <ReadShots urls={shots} /> : null}
      </div>
      <div className="card">
        {issues.length > 0 ? (
          <Notice tone="warn">
            <strong>{g.checksTitle}</strong>
            <IssueList items={issues.map((i) => ({ level: i.code === 'winner-differs' ? ('error' as const) : ('warning' as const), text: issueText(i) }))} />
          </Notice>
        ) : null}
        {unmatched > 0 ? <Notice tone="warn">{g.unmatched(unmatched)}</Notice> : null}
        {unchecked > 0 ? <Notice tone="warn">{g.unchecked(unchecked)}</Notice> : null}
        {duplicate ? <Notice tone="err">{g.duplicatePlayer}</Notice> : null}
        {tie ? <Notice tone="err">{g.tie}</Notice> : null}
        {error ? <GameDayErrors error={error} teamName={teamName} /> : null}
        <div className="row">
          <button className="btn" onClick={onCancel}>
            {g.startOver}
          </button>
          <button className="btn primary" disabled={!canSave} onClick={() => void save()}>
            {g.save}
          </button>
        </div>
      </div>
    </>
  )
}
