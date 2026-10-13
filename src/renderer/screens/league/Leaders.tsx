import { useState } from 'react'
import { leaderLabel } from '@shared/labels'
import { call } from '../../api'
import { Field, Loading, NumberInput } from '../../components/ui'
import { useLoad } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { RuleErrors } from './RuleErrors'
import { PastSeasonNotice, SeasonPicker, useSeasonPick } from './SeasonPicker'

export function Leaders() {
  const { league } = useLeague()
  const [minGames, setMinGames] = useState(1)
  const season = useSeasonPick()
  // A player's team is the one in his box lines that season, so a traded player shows where he played.
  const boards = useLoad(() => call('season.leaders', league.slug, minGames, season.arg), [`${league.slug}:${season.seasonId}`, minGames], {
    keepPrevious: true,
  })
  const name = (id: string) => league.players.find((p) => p.id === id)?.name ?? id
  const team = (id: string) => league.teams.find((tm) => tm.id === id)?.shortName ?? id

  return (
    <div className="page wide">
      <div className="page-head">
        <h1>{t.leaders.title}</h1>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <SeasonPicker season={season} />
          <Field label={t.leaders.minGames}>
            {(id) => <NumberInput id={id} value={minGames} min={0} max={200} onChange={setMinGames} lazy />}
          </Field>
        </div>
      </div>
      <PastSeasonNotice season={season} />
      {boards.state === 'loading' ? <Loading /> : null}
      {boards.state === 'error' ? <RuleErrors error={boards.error} onRetry={boards.reload} /> : null}
      {boards.state === 'ready' && boards.value.every((b) => b.rows.length === 0) ? (
        <div className="card">
          <p className="help">{season.past ? t.leaders.noneThen : t.leaders.none}</p>
        </div>
      ) : null}
      {boards.state === 'ready' ? (
        <div className="grid-cards">
          {boards.value
            .filter((b) => b.rows.length > 0)
            .map((b) => (
              <div key={b.key} className="card">
                <div className="card-head">
                  <h3>{leaderLabel(league.config, b)}</h3>
                  <span className="muted">{b.kind === 'percent' ? t.leaders.percent : t.leaders.perGame}</span>
                </div>
                <ol className="leader-list">
                  {b.rows.map((r) => (
                    <li key={r.playerId}>
                      <span>
                        <b>{name(r.playerId)}</b> <span className="muted">{team(r.teamId)}</span>
                      </span>
                      <span className="value">{b.kind === 'percent' ? `${(r.value * 100).toFixed(1)}%` : r.value.toFixed(1)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
        </div>
      ) : null}
    </div>
  )
}
