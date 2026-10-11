import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Badge, TextInput } from '../../components/ui'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { RosterTable } from './RosterTable'

export function Players() {
  const { league } = useLeague()
  const [query, setQuery] = useState('')
  const teamName = useMemo(() => new Map(league.teams.map((tm) => [tm.id, `${tm.shortName} ${tm.name}`])), [league])
  const q = query.trim().toLowerCase()
  const players = q
    ? league.players.filter((p) =>
        [p.name, ...p.nicknames, teamName.get(p.teamId) ?? ''].some((s) => s.toLowerCase().includes(q)),
      )
    : league.players

  return (
    <div className="page wide">
      <div className="page-head">
        <h1>{t.office.allPlayers}</h1>
        <div className="row">
          <TextInput value={query} onChange={setQuery} placeholder={t.office.search} width={260} />
          <Badge>{t.office.count(players.length)}</Badge>
          <Link className="btn small" to="../roster" relative="path">
            {t.roster.title}
          </Link>
        </div>
      </div>
      <div className="card flush">
        <RosterTable league={league} players={players} showTeam />
      </div>
    </div>
  )
}
