import { useState } from 'react'
import { Link } from 'react-router'
import type { StandingLine } from '@shared/season'
import { call } from '../../api'
import { Loading, Segmented } from '../../components/ui'
import { useLoad } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { usePlayed } from './Played'
import { RuleErrors } from './RuleErrors'
import { PastSeasonNotice, SeasonPicker, useSeasonPick } from './SeasonPicker'

type View = 'overall' | 'conference' | 'division'

export function Standings() {
  const { league } = useLeague()
  const season = useSeasonPick()
  // Keyed by season too: another season shows the loader, not the last season's table.
  const table = useLoad(() => call('season.standings', league.slug, season.arg), [`${league.slug}:${season.seasonId}`], { keepPrevious: true })
  const hasConferences = league.config.structure.conferences.length > 0
  const [view, setView] = useState<View>(hasConferences ? 'conference' : 'overall')
  const s = t.standings
  // 2K 일정대로: schools have played different numbers of games, so each line shows its own (GP).
  const played = usePlayed()
  const { playoffs } = league.config.season
  const direct = playoffs.enabled ? playoffs.directSeeds : 0
  const lastPlayIn = playoffs.enabled && playoffs.playIn.enabled ? direct + 4 : direct

  if (table.state === 'loading') return <div className="page"><Loading /></div>
  if (table.state === 'error') {
    return (
      <div className="page">
        <PastSeasonNotice season={season} />
        <RuleErrors error={table.error} onRetry={table.reload} />
      </div>
    )
  }
  const v = table.value
  // Playoff lines only make sense where seeds are drawn: conferences, or the league.
  const seeded = (scope: View) => (playoffs.bracket === 'conference' ? scope === 'conference' : scope === 'overall')

  const groups: { title: string; lines: StandingLine[]; seeded: boolean }[] =
    view === 'overall'
      ? [{ title: s.tabs.overall, lines: v.overall, seeded: seeded('overall') }]
      : view === 'conference'
        ? league.config.structure.conferences.map((c) => ({ title: c.name, lines: v.conferences[c.id] ?? [], seeded: seeded('conference') }))
        : league.config.structure.divisions.map((d) => ({ title: d.name, lines: v.divisions[d.id] ?? [], seeded: false }))

  const tabs = (['overall', 'conference', 'division'] as const).filter((x) => x !== 'conference' || hasConferences)
  const showCuts = direct > 0 && groups.some((g) => g.seeded)
  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <h1>{s.title}</h1>
          <p className="sub">{s.played(v.played, v.total)}</p>
        </div>
        <div className="row">
          <SeasonPicker season={season} />
          <Segmented value={view} options={tabs.map((x) => ({ value: x, label: s.tabs[x] }))} onChange={setView} />
        </div>
      </div>
      <PastSeasonNotice season={season} />
      {played ? <p className="help">{t.played.standingsNote}</p> : null}
      {showCuts ? (
        <div className="cut-legend muted">
          <span>
            <i className="cut-swatch playoffs" aria-hidden="true" />
            {s.playoffLine}
          </span>
          {lastPlayIn > direct ? (
            <span>
              <i className="cut-swatch playin" aria-hidden="true" />
              {s.playInLine}
            </span>
          ) : null}
        </div>
      ) : null}
      {groups.map((g) => (
        <div key={g.title} className="card flush">
          <div className="card-head" style={{ padding: '12px 16px' }}>
            <h2>{g.title}</h2>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="num">{s.rank}</th>
                  <th>{s.team}</th>
                  {played ? <th className="num">{t.played.gpColumn}</th> : null}
                  <th className="num">{s.w}</th>
                  <th className="num">{s.l}</th>
                  <th className="num">{s.pct}</th>
                  <th className="num">{s.gb}</th>
                  <th className="num">{s.home}</th>
                  <th className="num">{s.away}</th>
                  <th className="num">{s.conf}</th>
                  <th className="num">{s.div}</th>
                  <th className="num">{s.last10}</th>
                  <th className="num">{s.streak}</th>
                  <th className="num">{s.pf}</th>
                  <th className="num">{s.pa}</th>
                  <th className="num">{s.diff}</th>
                </tr>
              </thead>
              <tbody>
                {g.lines.map((l, i) => {
                  const team = league.teams.find((tm) => tm.id === l.teamId)
                  const line = g.seeded && (i + 1 === direct || i + 1 === lastPlayIn) && i + 1 < g.lines.length
                  return (
                    <tr key={l.teamId} className={line ? (i + 1 === direct ? 'cut-playoffs' : 'cut-playin') : ''}>
                      <td className="num">{i + 1}</td>
                      <td>
                        <Link to={`../team/${encodeURIComponent(l.teamId)}`} relative="path">
                          {team?.shortName ?? l.teamId}
                        </Link>
                      </td>
                      {played ? <td className="num">{l.wins + l.losses}</td> : null}
                      <td className="num">{l.wins}</td>
                      <td className="num">{l.losses}</td>
                      <td className="num">{l.pct.toFixed(3).replace(/^0/, '')}</td>
                      <td className="num">{l.gamesBehind === 0 ? '–' : l.gamesBehind.toFixed(1).replace(/\.0$/, '')}</td>
                      <td className="num">{l.home}</td>
                      <td className="num">{l.away}</td>
                      <td className="num">{l.conference}</td>
                      <td className="num">{l.division}</td>
                      <td className="num">{l.last10}</td>
                      <td className="num">{l.streak}</td>
                      <td className="num">{l.pointsFor}</td>
                      <td className="num">{l.pointsAgainst}</td>
                      <td className="num">{l.pointsFor - l.pointsAgainst > 0 ? '+' : ''}{l.pointsFor - l.pointsAgainst}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}
