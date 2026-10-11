import { useState } from 'react'
import { Link } from 'react-router'
import { call } from '../../api'
import { Badge, ErrorBox, TextInput } from '../../components/ui'
import { useLoad } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { usePlayed } from './Played'
import { RuleErrors } from './RuleErrors'

/** The season's phase, progress and the one step that moves it on. */
export function SeasonCard() {
  const { league, reload, refreshing } = useLeague()
  const slug = league.slug
  const phase = league.season.phase
  const standings = useLoad(() => call('season.standings', slug), [slug, phase], { keepPrevious: true })
  // Not kept across phases: the finish button waits for this phase's bracket.
  const playoffs = useLoad(() => (phase === 'playoffs' ? call('season.playoffs', slug) : Promise.resolve(null)), [slug, phase])
  const checklist = useLoad(() => call('checklist.list', slug), [slug, phase], { keepPrevious: true })
  const [error, setError] = useState<unknown>(null)
  const [running, setRunning] = useState(false)
  const [nextLabel, setNextLabel] = useState('')
  // Also wait for the new snapshot, so the old phase's button can't be pressed twice.
  const busy = running || refreshing
  const byDay = usePlayed()

  const run = async (fn: () => Promise<unknown>, confirmText: string) => {
    if (busy || !window.confirm(confirmText)) return
    setRunning(true)
    setError(null)
    try {
      await fn()
      reload()
    } catch (e) {
      setError(e)
    } finally {
      setRunning(false)
    }
  }

  const s = t.season
  const played = standings.state === 'ready' ? standings.value.played : 0
  // The whole regular season, including rounds not built yet.
  const total = standings.state === 'ready' ? standings.value.total : 0
  const pending = checklist.state === 'ready' ? checklist.value.filter((c) => c.appliedAt === null).length : 0
  // Unknown (null) until this phase's bracket has loaded.
  const seriesLeft = playoffs.state === 'ready' && playoffs.value ? playoffs.value.series.filter((x) => x.winner === null).length : null

  return (
    <div className="card">
      <div className="card-head">
        <div className="row">
          <h2>{league.season.label}</h2>
          <Badge tone="accent">{t.office.phases[phase]}</Badge>
          {phase === 'regular' ? <span className="muted">{s.progress(played, total)}</span> : null}
        </div>
        {pending > 0 ? (
          <Link to="inbox" className="badge warn">
            {s.pending2k(pending)}
          </Link>
        ) : null}
      </div>

      {phase === 'preseason' ? (
        <div className="row">
          <p className="help">
            {byDay
              ? t.played.preseasonHelp
              : league.config.season.schedule.kind === 'round-robin' && league.config.season.schedule.build === 'manual'
                ? s.preseasonHelpManual
                : s.preseasonHelp}
          </p>
          <button className="btn primary" disabled={busy} onClick={() => void run(() => call('season.start', slug), s.confirmStart)}>
            {s.start}
          </button>
        </div>
      ) : null}

      {phase === 'regular' ? (
        <div className="row">
          <Link className="btn" to="schedule">
            {s.enterScores}
          </Link>
          {total > 0 && played >= total ? (
            <button
              className="btn primary"
              disabled={busy}
              onClick={() =>
                void run(
                  () => call('season.startPlayoffs', slug),
                  // 2K 일정대로: a last session left open closes with it.
                  `${league.config.season.playoffs.enabled ? s.confirmStartPlayoffs : s.confirmEndSeason}${byDay ? `\n\n${t.played.playoffsNote}` : ''}`,
                )
              }
            >
              {league.config.season.playoffs.enabled ? s.startPlayoffs : s.endSeason}
            </button>
          ) : null}
        </div>
      ) : null}

      {phase === 'playoffs' ? (
        <div className="row">
          <Link className="btn" to="playoffs">
            {s.bracket}
          </Link>
          {seriesLeft === 0 ? (
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => void run(() => call('season.finishPlayoffs', slug), s.confirmFinishPlayoffs)}
            >
              {s.finishPlayoffs}
            </button>
          ) : seriesLeft !== null ? (
            <span className="muted">{s.seriesLeft(seriesLeft)}</span>
          ) : null}
        </div>
      ) : null}

      {phase === 'draft' ? (
        <div className="row">
          <Link className="btn primary" to="draft">
            {s.toDraft}
          </Link>
        </div>
      ) : null}

      {phase === 'offseason' ? (
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <TextInput value={nextLabel} onChange={setNextLabel} placeholder={s.nextLabelPlaceholder} width={200} />
          <button
            className="btn primary"
            disabled={busy || nextLabel.trim() === ''}
            onClick={() => void run(() => call('season.next', slug, nextLabel.trim()), s.confirmNext(nextLabel.trim()))}
          >
            {s.nextSeason}
          </button>
        </div>
      ) : null}

      {error ? <RuleErrors error={error} /> : null}
      {standings.state === 'error' ? <ErrorBox error={standings.error} onRetry={standings.reload} /> : null}
      {playoffs.state === 'error' ? <ErrorBox error={playoffs.error} onRetry={playoffs.reload} /> : null}
    </div>
  )
}
