import { leagueChampion, type SeriesRow } from '@shared/season'
import { call } from '../../api'
import { Badge, Loading } from '../../components/ui'
import { useLoad } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { RuleErrors } from './RuleErrors'
import { PastSeasonNotice, SeasonPicker, useSeasonPick } from './SeasonPicker'

export function Playoffs() {
  const { league } = useLeague()
  const season = useSeasonPick()
  const view = useLoad(() => call('season.playoffs', league.slug, season.arg), [`${league.slug}:${season.seasonId}`, league.season.phase], {
    keepPrevious: true,
  })
  const teamName = (id: string | null) => (id === null ? t.playoffs.tbd : (league.teams.find((tm) => tm.id === id)?.shortName ?? id))
  const groupName = (g: string | null) =>
    g === null ? t.playoffs.finals : (league.config.structure.conferences.find((c) => c.id === g)?.name ?? (g === 'league' ? '' : g))

  if (view.state === 'loading') return <div className="page"><Loading /></div>
  if (view.state === 'error') {
    return (
      <div className="page">
        <PastSeasonNotice season={season} />
        <RuleErrors error={view.error} onRetry={view.reload} />
      </div>
    )
  }
  const { series } = view.value
  if (series.length === 0) {
    return (
      <div className="page">
        <div className="page-head">
          <h1>{t.playoffs.title}</h1>
          <SeasonPicker season={season} />
        </div>
        <PastSeasonNotice season={season} />
        <div className="card">
          <p className="help">{season.past ? t.playoffs.noneThen : t.playoffs.notYet}</p>
        </div>
      </div>
    )
  }

  const groups = [...new Set(series.map((s) => s.group))]
  // As the wiki says it: with no final, a one-group bracket's last round crowns the champion.
  const champion = leagueChampion(series)

  return (
    <div className="page wide">
      <div className="page-head">
        <h1>{t.playoffs.title}</h1>
        <div className="row">
          {champion ? (
            <Badge tone="accent">
              {t.playoffs.champion} · {teamName(champion)}
            </Badge>
          ) : null}
          <SeasonPicker season={season} />
        </div>
      </div>
      <PastSeasonNotice season={season} />
      {groups.map((g) => {
        const mine = series.filter((s) => s.group === g)
        const playIn = mine.filter((s) => s.stage === 'play-in')
        const rounds = [...new Set(mine.filter((s) => s.stage !== 'play-in').map((s) => s.round))].sort((a, b) => a - b)
        // A league-wide bracket has no group title.
        const title = groupName(g)
        return (
          <section key={g ?? 'finals'} className="card">
            {title ? <h2>{title}</h2> : null}
            <div className="bracket">
              {playIn.length > 0 ? (
                <div className="bracket-col">
                  <h3>{t.playoffs.playIn}</h3>
                  {playIn.map((s) => (
                    <SeriesCard key={s.id} s={s} teamName={teamName} />
                  ))}
                </div>
              ) : null}
              {rounds.map((r) => {
                const inRound = mine.filter((s) => s.stage !== 'play-in' && s.round === r)
                const isFinals = inRound.every((s) => s.stage === 'finals')
                return (
                  <div key={r} className="bracket-col">
                    <h3>{isFinals ? t.playoffs.finals : t.playoffs.round(r)}</h3>
                    {inRound.map((s) => (
                      <SeriesCard key={s.id} s={s} teamName={teamName} />
                    ))}
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function SeriesCard({ s, teamName }: { s: SeriesRow; teamName: (id: string | null) => string }) {
  const side = (team: string | null, seed: number | null, wins: number) => (
    <div className={`series-team ${s.winner !== null && s.winner === team ? 'won' : ''} ${s.winner !== null && s.winner !== team ? 'lost' : ''}`}>
      <span className="seed">{seed ?? ''}</span>
      <span className="name">{teamName(team)}</span>
      <span className="wins">{team === null ? '' : wins}</span>
    </div>
  )
  return (
    <div className="series-card">
      {side(s.high, s.highSeed, s.highWins)}
      {side(s.low, s.lowSeed, s.lowWins)}
      <div className="series-meta muted">{t.playoffs.bestOf(s.bestOf)}</div>
    </div>
  )
}
