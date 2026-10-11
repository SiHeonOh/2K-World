import { Link, useParams } from 'react-router'
import { Badge, OvrBadge } from '../../components/ui'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { LockerRoom } from './LockerRoom'
import { RosterTable } from './RosterTable'
import { averageOverall, overallColumn, rosterOf, teamAverageRange } from './util'

export function TeamPage() {
  const { league } = useLeague()
  const { teamId = '' } = useParams()
  const team = league.teams.find((tm) => tm.id === teamId)
  if (!team) {
    return (
      <div className="page">
        <p>{t.errors.codes['not-found']}</p>
      </div>
    )
  }
  const roster = rosterOf(league, team.id)
  const division = league.config.structure.divisions.find((d) => d.id === team.divisionId)
  const conference = league.config.structure.conferences.find((c) => c.id === division?.conferenceId)
  const overall = overallColumn(league.config)
  const avg = averageOverall(roster, league.config)
  const range = teamAverageRange(league)

  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <p className="muted">
            <Link to="../.." relative="path">
              {t.office.title}
            </Link>
            {' / '}
            {[conference?.name, division?.name].filter(Boolean).join(' · ')}
          </p>
          <h1 className="row">
            {team.shortName}
            {overall ? <OvrBadge value={avg} min={range.lo} max={range.hi} /> : null}
          </h1>
          <p className="sub">
            {team.name} · {t.office.control} {t.wizard.gm.controls[team.control]}
          </p>
        </div>
        <div className="row">
          <Badge>{t.office.count(roster.length)}</Badge>
          <Link className="btn small" to={`/l/${encodeURIComponent(league.slug)}/lore?team=${encodeURIComponent(team.id)}`}>
            {t.lore.teamLore}
          </Link>
          <Link className="btn small" to={`/l/${encodeURIComponent(league.slug)}/lore?gm=${encodeURIComponent(team.id)}`}>
            {t.lore.gmLore}
          </Link>
          <Link className="btn small" to={`/l/${encodeURIComponent(league.slug)}/roster?school=${encodeURIComponent(team.id)}`}>
            {t.roster.title}
          </Link>
          <Link className="btn small" to={`/l/${encodeURIComponent(league.slug)}/lore?table=players&school=${encodeURIComponent(team.id)}`}>
            {t.lore.tables.players}
          </Link>
        </div>
      </div>
      <div className="card flush">
        <RosterTable league={league} players={roster} />
      </div>
      <LockerRoom teamId={team.id} />
      {roster.some((p) => p.notes) ? (
        <div className="card">
          <h3>{t.office.notes}</h3>
          <ul>
            {roster
              .filter((p) => p.notes)
              .map((p) => (
                <li key={p.id}>
                  <b>{p.name}</b>: {p.notes}
                </li>
              ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
