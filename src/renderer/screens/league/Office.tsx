import { Link } from 'react-router'
import { formatHeight } from '@shared/height'
import { Badge, OvrBadge } from '../../components/ui'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { SeasonCard } from './SeasonCard'
import { averageOverall, groupTeams, overallColumn, overallOf, rosterOf, teamAverageRange } from './util'

export function Office() {
  const { league } = useLeague()
  const { config } = league
  const overall = overallColumn(config)
  const { lo, hi } = teamAverageRange(league)

  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <h1>{config.league.name}</h1>
          <p className="sub">
            {t.office.season(league.season.label, t.office.phases[league.season.phase])} · {league.teams.length}
            {t.office.teams} · {t.office.players} {league.players.length}
          </p>
        </div>
        <span className="row">
          <Link className="btn" to="players">
            {t.office.allPlayers}
          </Link>
          <Link className="btn" to="settings">
            {t.leagueSettings.title}
          </Link>
        </span>
      </div>

      <SeasonCard />

      {groupTeams(league).map((group) => (
        <section key={group.conference ?? '-'} className="conf-block">
          <h2>{group.conference ?? (league.config.structure.conferences.length ? t.office.noConference : t.office.teams)}</h2>
          <div className="stack" style={{ gap: 14 }}>
            {group.divisions.map((d) => (
              <div key={d.name} className="div-block">
                <h3>{d.name}</h3>
                <div className="grid-cards">
                  {d.teams.map((team) => {
                    const roster = rosterOf(league, team.id)
                    const avg = averageOverall(roster, config)
                    const best = [...roster].sort((a, b) => (overallOf(b, config) ?? 0) - (overallOf(a, config) ?? 0))[0]
                    return (
                      <Link key={team.id} to={`team/${encodeURIComponent(team.id)}`} className="team-card">
                        <div className="top">
                          <span className="name">{team.shortName}</span>
                          <span className="row" style={{ gap: 6 }}>
                            {team.control !== 'ai' ? (
                              <Badge tone={team.control === 'frozen' ? 'info' : 'accent'}>
                                {t.wizard.gm.controls[team.control]}
                              </Badge>
                            ) : null}
                            {overall ? <OvrBadge value={avg} min={lo} max={hi} /> : null}
                          </span>
                        </div>
                        {best ? (
                          <span className="muted">
                            {t.office.best} {best.name}
                            {overall ? ` ${overallOf(best, config) ?? ''}` : ''}
                            {best.heightCm ? ` · ${formatHeight(best.heightCm, config.playerFields.heightUnit)}` : ''}
                          </span>
                        ) : null}
                      </Link>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

    </div>
  )
}
