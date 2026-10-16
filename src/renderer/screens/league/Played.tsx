import { useState } from 'react'
import type { LeagueConfig } from '@shared/config/schema'
import { playedMode, roundLabel } from '@shared/played'
import type { GameRow } from '@shared/season'
import { settingsOf, type SectionLock } from '@shared/settings'
import { call } from '../../api'
import { Loading, Notice } from '../../components/ui'
import { useLoad } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { RuleErrors, ruleText } from './RuleErrors'

/**
 * 2K 일정대로 (`season.schedule.build: 'played'`) on the screens: the game
 * picker (two schools with a meeting left; the first one picked hosts) and
 * 오늘 경기 끝, which closes the open session (N일차). 일정 and 경기일 both
 * use them.
 */

/** Round names for this league: "3라운드" (long) or "R3" (short), or "3일차" in 2K 일정대로. */
export function useRoundName(form: 'short' | 'long' = 'long'): (n: number) => string {
  const { league } = useLeague()
  return (n: number) => roundLabel(league.config, n, form)
}

/** Whether this league plays 2K 일정대로. */
export function usePlayed(): boolean {
  return playedMode(useLeague().league.config)
}

/**
 * Picks the two schools of a game just played in 2K: first the home school
 * (each school shows its games played so far), then its opponent, from the
 * schools it still has a meeting left with. 홈/원정 바꾸기 swaps them before
 * the game is added to the open session.
 */
export function PairPicker({ refreshKey, onAdded }: { refreshKey: string; onAdded: (added: { gameId: number; round: number }) => void }) {
  const { league } = useLeague()
  const slug = league.slug
  const tp = t.played
  const pairs = useLoad(() => call('schedule.pairs', slug), [slug, refreshKey], { keepPrevious: true })
  const [first, setFirst] = useState<string | null>(null)
  const [second, setSecond] = useState<string | null>(null)
  const [flipped, setFlipped] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const name = (id: string) => league.teams.find((tm) => tm.id === id)?.shortName ?? id

  const reset = () => {
    setFirst(null)
    setSecond(null)
    setFlipped(false)
  }

  if (pairs.state === 'loading') {
    return (
      <div className="round-builder played-picker">
        <Loading />
      </div>
    )
  }
  if (pairs.state === 'error') {
    return (
      <div className="round-builder played-picker">
        <RuleErrors error={pairs.error} onRetry={pairs.reload} />
      </div>
    )
  }
  const p = pairs.value
  const stats = new Map(p.teams.map((x) => [x.teamId, x]))
  const anyLeft = Object.values(p.open).some((list) => list.length > 0)
  // A pick the reloaded list no longer allows (another screen added that game) starts over.
  const opponents = first ? (p.open[first] ?? []) : []
  const pickedSecond = second !== null && opponents.some((o) => o.teamId === second) ? second : null
  const home = pickedSecond && flipped ? pickedSecond : first
  const away = pickedSecond && flipped ? first : pickedSecond

  const add = async () => {
    if (busy || !home || !away) return
    setBusy(true)
    setError(null)
    try {
      const added = await call('schedule.addPlayed', slug, { home, away })
      reset()
      pairs.reload()
      onAdded(added)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const chip = (id: string, opts: { on?: boolean; disabled?: boolean; onClick: () => void; meetingsLeft?: number }) => {
    const s = stats.get(id)
    return (
      <button
        key={id}
        className={`team-chip ${opts.on ? 'on' : ''} ${opts.disabled ? 'met' : ''}`}
        disabled={busy || opts.disabled}
        aria-pressed={opts.on ?? false}
        title={opts.disabled ? tp.noOpponents(name(id)) : opts.meetingsLeft !== undefined && p.meetings > 1 ? tp.meetingsLeft(opts.meetingsLeft) : undefined}
        onClick={opts.onClick}
      >
        {name(id)}
        {s ? <span className="muted"> {tp.gp(s.played)}</span> : null}
      </button>
    )
  }

  return (
    <div className="round-builder played-picker">
      <strong>{tp.pickerTitle(p.session)}</strong>
      {!anyLeft ? (
        <p className="help">{tp.allMet}</p>
      ) : home && away ? (
        <div className="row">
          <span className="played-staged">{tp.staged(name(home), name(away))}</span>
          <button className="btn small ghost" disabled={busy} title={tp.flip} aria-label={tp.flip} onClick={() => setFlipped((f) => !f)}>
            ⇄ {tp.flip}
          </button>
          <button className="btn small primary" disabled={busy} onClick={() => void add()}>
            {tp.add}
          </button>
          <button className="btn small ghost" disabled={busy} onClick={reset}>
            {tp.repick}
          </button>
        </div>
      ) : (
        <>
          <p className="help">{first ? tp.pickSecond(name(first)) : tp.pickFirst}</p>
          <div className="team-chips">
            {first
              ? [
                  chip(first, { on: true, onClick: reset }),
                  ...opponents.map((o) =>
                    chip(o.teamId, {
                      meetingsLeft: o.left,
                      onClick: () => {
                        setSecond(o.teamId)
                        setFlipped(false)
                      },
                    }),
                  ),
                ]
              : league.teams.map((tm) => chip(tm.id, { disabled: (p.open[tm.id] ?? []).length === 0, onClick: () => setFirst(tm.id) }))}
          </div>
          {first && opponents.length === 0 ? <p className="help">{tp.noOpponents(name(first))}</p> : null}
        </>
      )}
      {error ? <RuleErrors error={error} /> : null}
    </div>
  )
}

/**
 * 오늘 경기 끝: closes the open session after asking (the confirm says what
 * follows), so the round-ups and the rest come. While a game in it is
 * unplayed it says which, with 빼기 for each; with no games it waits.
 */
export function EndDay({ session, games, onClosed, onChanged }: { session: number; games: GameRow[]; onClosed: (result: { round: number; next: number }) => void; onChanged: () => void }) {
  const { league } = useLeague()
  const slug = league.slug
  const tp = t.played
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const name = (id: string) => league.teams.find((tm) => tm.id === id)?.shortName ?? id
  const unplayed = games.filter((g) => g.status !== 'final')
  const { config } = league
  const every = config.gm.tradeWindowEveryRounds
  // No schedule (every 0): windows open only from 단장실, so closing a day says nothing about them.
  const windows = every > 0 && config.trades.enabled && config.trades.phases.includes('regular') && league.teams.some((tm) => tm.control === 'ai')
  const tradeWindow: 'now' | number | null = !windows ? null : session % every === 0 ? 'now' : (Math.floor(session / every) + 1) * every

  const act = async (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  const end = () =>
    act(async () => {
      if (!window.confirm(tp.confirmEnd({ round: session, games: games.length, community: config.community.enabled, loreSweep: config.lore.roundSweep, window: tradeWindow }))) return
      onClosed(await call('schedule.closeSession', slug))
    })

  return (
    <div className="round-builder played-end">
      <div className="row">
        <button className="btn primary" disabled={busy || games.length === 0 || unplayed.length > 0} onClick={() => void end()}>
          {busy ? tp.ending : tp.endDay}
        </button>
        <span className="help">{games.length === 0 ? tp.endEmpty(session) : tp.endDayHelp(session)}</span>
      </div>
      {unplayed.length > 0 ? (
        <Notice tone="warn">
          {tp.endUnplayed(session, unplayed.length)}
          <ul className="played-unplayed">
            {unplayed.map((g) => (
              <li key={g.id}>
                {name(g.home)} vs {name(g.away)}{' '}
                <button
                  className="btn small ghost"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await call('schedule.remove', slug, g.id)
                      onChanged()
                    })
                  }
                >
                  {tp.removeGame}
                </button>
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {error ? <RuleErrors error={error} /> : null}
    </div>
  )
}

/**
 * 리그 설정 in a running regular season: the rest of 일정 is locked, but a
 * league built by rounds may switch to 2K 일정대로 once no built game waits
 * unplayed (`lock` says whether it can now, and why not). It saves just that
 * change; `onSaved` gets the new schedule so the screen's own form follows.
 */
export function PlayedSwitch({ lock, disabled, onSaved }: { lock: SectionLock; disabled: boolean; onSaved: (schedule: LeagueConfig['season']['schedule']) => void }) {
  const { league } = useLeague()
  const tp = t.played
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [done, setDone] = useState(false)
  const save = async () => {
    if (busy || !lock.open || !window.confirm(tp.confirmSwitch)) return
    const now = settingsOf(league.config, league.teams)
    if (now.schedule.kind !== 'round-robin') return
    const schedule = { ...now.schedule, build: 'played' as const }
    setBusy(true)
    setError(null)
    try {
      await call('leagues.saveSettings', league.slug, { ...now, schedule })
      setDone(true)
      onSaved(schedule)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="settings-section played-switch" aria-label={tp.switchTitle}>
      <div className="section-head">
        <h2>{tp.switchTitle}</h2>
      </div>
      <p className="help">{tp.switchHelp}</p>
      {!lock.open && lock.code ? <Notice tone="warn">{ruleText(lock.code, lock.params)}</Notice> : null}
      {done ? <Notice tone="ok">{tp.switched}</Notice> : null}
      {error ? <RuleErrors error={error} /> : null}
      <div className="row">
        <button className="btn" disabled={busy || disabled || !lock.open} onClick={() => void save()}>
          {tp.switchButton}
        </button>
      </div>
    </section>
  )
}

/**
 * 경기일 in 2K 일정대로: add the game just played (it becomes the one to
 * record), and 오늘 경기 끝 once the session has games.
 */
export function PlayedPanel({
  session,
  games,
  onAdded,
  onChanged,
}: {
  session: number
  /** This season's regular-season games (the session's are picked out here). */
  games: GameRow[]
  onAdded: (gameId: number) => void
  onChanged: () => void
}) {
  const tp = t.played
  const [closed, setClosed] = useState<{ round: number; next: number } | null>(null)
  const mine = games.filter((g) => g.stage === 'regular' && g.round === session)
  const signature = games.map((g) => `${g.id}:${g.status}:${g.home}:${g.away}`).join(',')
  return (
    <div className="card flush played-panel">
      <div className="card-head" style={{ padding: '12px 16px' }}>
        <h2>{tp.session(session)}</h2>
        <span className="muted">{tp.gp(mine.filter((g) => g.status === 'final').length)}</span>
      </div>
      {closed ? (
        <div style={{ padding: '0 16px' }}>
          <Notice tone="ok">{tp.closed(closed.round, closed.next)}</Notice>
        </div>
      ) : null}
      <PairPicker
        refreshKey={signature}
        onAdded={(added) => {
          setClosed(null)
          onAdded(added.gameId)
        }}
      />
      {mine.length > 0 ? (
        <EndDay
          session={session}
          games={mine}
          onClosed={(r) => {
            setClosed(r)
            onChanged()
          }}
          onChanged={onChanged}
        />
      ) : null}
    </div>
  )
}
