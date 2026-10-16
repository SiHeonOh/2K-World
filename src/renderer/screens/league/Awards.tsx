import { useMemo, useState } from 'react'
import { awardGroups, awardLabel, awardTitle, byPeriod, groupOf, periodChoices, periodLabel, type AwardGroup } from '@shared/awards'
import type { PeriodicAward as PeriodicAwardConfig } from '@shared/config/schema'
import type { AwardRow } from '@shared/season'
import { call } from '../../api'
import { Loading, Select } from '../../components/ui'
import { useLoad } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { RuleErrors } from './RuleErrors'
import { PastSeasonNotice, SeasonPicker, useSeasonPick } from './SeasonPicker'

type Option = { value: string; label: string }

/** Player labels ("name (team)") and the pickers' options, built once per snapshot. */
interface Picker {
  /** Every player to pick from, or only those whose school passes `only` (one conference's or division's). */
  options: (only?: (teamId: string) => boolean) => Option[]
  /** A winner's label, with the team he won it for (kept with the award). */
  winner: (row: AwardRow) => string
}

export function Awards() {
  const { league } = useLeague()
  const [tick, setTick] = useState(0)
  // A past season's awards can be looked at, not given or taken back.
  const season = useSeasonPick()
  const readOnly = season.past
  // Kept while refetching, so the slots (and the period pickers) stay mounted after give/remove.
  const list = useLoad(() => call('awards.list', league.slug, season.arg), [`${league.slug}:${season.seasonId}`, tick], { keepPrevious: true })
  const [error, setError] = useState<unknown>(null)
  const { awards, structure } = league.config
  const picker = useMemo((): Picker => {
    const teams = new Map(league.teams.map((tm) => [tm.id, tm.shortName]))
    const players = new Map(league.players.map((p) => [p.id, p.name]))
    const all = league.players.map((p) => ({ teamId: p.teamId, value: p.id, label: `${p.name} (${teams.get(p.teamId) ?? ''})` }))
    return {
      options: (only) => [{ value: '', label: t.awards.pickPlayer }, ...all.filter((o) => !only || only(o.teamId)).map(({ value, label }) => ({ value, label }))],
      winner: (row) => `${players.get(row.playerId) ?? row.playerId} (${teams.get(row.teamId) ?? row.teamId})`,
    }
  }, [league.teams, league.players])
  const divisionOf = useMemo(() => new Map(league.teams.map((tm) => [tm.id, tm.divisionId])), [league.teams])

  const give = async (awardId: string, period: string, teamRank: number, playerId: string) => {
    setError(null)
    try {
      await call('awards.give', league.slug, { awardId, period, teamRank, playerId })
      setTick((x) => x + 1)
    } catch (e) {
      setError(e)
    }
  }
  /** An award as the confirm names it: "3주차 동부 이주의 선수", "올-리그 팀 2팀". */
  const awardText = (row: AwardRow) => {
    const seasonAward = awards.season.find((a) => a.id === row.awardId)
    if (seasonAward?.kind === 'selection') return `${seasonAward.name} ${t.awards.teamN(row.teamRank)}`
    return awardTitle(league.config, row)
  }
  const remove = async (id: number) => {
    // Taking an award back is news (the wiki gets a 수상 취소 line), so it asks first.
    const row = list.state === 'ready' ? list.value.find((r) => r.id === id) : undefined
    if (!window.confirm(t.awards.confirmRemove(row ? awardText(row) : '', row ? picker.winner(row) : ''))) return
    setError(null)
    try {
      await call('awards.remove', league.slug, id)
      setTick((x) => x + 1)
    } catch (e) {
      setError(e)
    }
  }

  const head = (
    <div className="page-head">
      <h1>{t.awards.title}</h1>
      <SeasonPicker season={season} />
    </div>
  )
  if (list.state === 'loading') return <div className="page"><Loading /></div>
  if (list.state === 'error') {
    return (
      <div className="page">
        {head}
        <PastSeasonNotice season={season} />
        <RuleErrors error={list.error} onRetry={list.reload} />
      </div>
    )
  }
  const rows = list.value
  const everyone = picker.options()

  return (
    <div className="page">
      {head}
      <PastSeasonNotice season={season} />
      {error ? <RuleErrors error={error} /> : null}
      <h2>{t.awards.season}</h2>
      {awards.season.map((a) => (
        <div key={a.id} className="card">
          <h3>{a.name}</h3>
          {Array.from({ length: a.kind === 'selection' ? a.teams : 1 }, (_, i) => i + 1).map((rank) => (
            <AwardSlot
              key={rank}
              title={a.kind === 'selection' ? `${a.name} ${t.awards.teamN(rank)}` : a.name}
              label={a.kind === 'selection' ? t.awards.teamN(rank) : ''}
              options={everyone}
              winner={picker.winner}
              limit={a.kind === 'selection' ? a.perTeam : 1}
              winners={rows.filter((r) => r.awardId === a.id && r.period === '' && r.teamRank === rank)}
              readOnly={readOnly}
              onGive={(playerId) => void give(a.id, '', rank, playerId)}
              onRemove={(id) => void remove(id)}
            />
          ))}
        </div>
      ))}
      {awards.periodic.length > 0 ? <h2>{t.awards.periodic}</h2> : null}
      {awards.periodic.map((a) => (
        <PeriodicAward
          key={a.id}
          award={a}
          picker={picker}
          choices={periodChoices(league.config, league.teams.length, a.period)}
          groups={awardGroups(structure, a.scope, league.teams)}
          groupOfTeam={(teamId) => groupOf(structure, a.scope, divisionOf.get(teamId))}
          rows={rows.filter((r) => r.awardId === a.id)}
          readOnly={readOnly}
          onGive={(period, playerId) => void give(a.id, period, 1, playerId)}
          onRemove={(id) => void remove(id)}
        />
      ))}
    </div>
  )
}

/** One place to fill: its winners (each can be taken back) and, while there's room, a player picker. `title` names it in full for screen readers. */
function AwardSlot({
  title,
  label,
  options,
  winner,
  limit,
  winners,
  readOnly,
  onGive,
  onRemove,
}: {
  title: string
  label: string
  options: Option[]
  winner: (row: AwardRow) => string
  limit: number
  winners: AwardRow[]
  readOnly: boolean
  onGive: (playerId: string) => void
  onRemove: (id: number) => void
}) {
  const [pick, setPick] = useState('')
  return (
    <div className="row award-slot" role="group" aria-label={title}>
      {label ? <b className="award-slot-label">{label}</b> : null}
      {winners.map((w) => (
        <span key={w.id} className="badge accent">
          {winner(w)}
          {readOnly ? null : (
            <button className="btn ghost small icon" aria-label={t.awards.remove} onClick={() => onRemove(w.id)}>
              ✕
            </button>
          )}
        </span>
      ))}
      {readOnly && winners.length === 0 ? <span className="muted">{t.awards.noneThen}</span> : null}
      {!readOnly && winners.length < limit ? (
        <>
          <Select compact ariaLabel={t.app.cellLabel(title, t.awards.pickPlayer)} value={pick} options={options} onChange={setPick} />
          <button
            className="btn small"
            disabled={pick === ''}
            onClick={() => {
              onGive(pick)
              setPick('')
            }}
          >
            {t.awards.give}
          </button>
        </>
      ) : null}
    </div>
  )
}

/**
 * A weekly or monthly award: a period picker (1주차, 2주차…, or 10월 to 5월),
 * starting at the latest period given, else the first; then each period given
 * so far and the one picked. Given per conference or division, a period has a
 * place for each, `winners` deep, and each place's picker lists only the
 * players of its schools. Codes (w3, m2) are what's kept, never what's shown.
 */
function PeriodicAward({
  award,
  picker,
  choices,
  groups,
  groupOfTeam,
  rows,
  readOnly,
  onGive,
  onRemove,
}: {
  award: PeriodicAwardConfig
  picker: Picker
  /** The periods to pick from, first to last. */
  choices: string[]
  groups: AwardGroup[]
  groupOfTeam: (teamId: string) => string | null
  rows: AwardRow[]
  readOnly: boolean
  onGive: (period: string, playerId: string) => void
  onRemove: (id: number) => void
}) {
  const given = [...new Set(rows.map((r) => r.period))].sort(byPeriod)
  const [period, setPeriod] = useState(() => given.at(-1) ?? choices[0] ?? '')
  // Looking back, only the periods that were given.
  const periods = [...new Set([...given, ...(readOnly ? [] : [period])])].filter((p) => p !== '').sort(byPeriod)
  // A period given before that's past the picker's range stays pickable.
  const pickable = [...new Set([...choices, ...given])].sort(byPeriod).map((p) => ({ value: p, label: periodLabel(p) }))
  // A winner whose school fits no group now (none should) still shows, with the schools in none.
  const known = new Set(groups.map((g) => g.id))
  const placeOf = (r: AwardRow) => (known.has(r.group) ? r.group : null)
  const places = rows.some((r) => placeOf(r) === null) && !known.has(null) ? [...groups, { id: null, name: '' }] : groups
  const perGroup = places.length > 1
  // Each group's players, once a look (not once a place).
  const options = new Map(places.map((g) => [g.id, picker.options(perGroup ? (teamId) => groupOfTeam(teamId) === g.id : undefined)]))
  return (
    <div className="card">
      <div className="card-head">
        <h3>{award.name}</h3>
        {readOnly ? null : <Select compact ariaLabel={t.app.cellLabel(award.name, t.awards.period)} value={period} options={pickable} onChange={setPeriod} />}
      </div>
      {readOnly && periods.length === 0 ? <p className="muted">{t.awards.noneThen}</p> : null}
      {periods.map((p) => (
        <div key={p} className={`award-period${!readOnly && p === period ? ' picked' : ''}`}>
          {perGroup ? <div className="award-period-head">{periodLabel(p)}</div> : null}
          {places.map((g) => (
            <AwardSlot
              key={g.id ?? ''}
              title={awardLabel({ award: award.name, period: p, group: g.name || (perGroup ? t.awards.otherSchools : '') })}
              label={perGroup ? g.name || t.awards.otherSchools : periodLabel(p)}
              options={options.get(g.id)!}
              winner={picker.winner}
              limit={award.winners}
              winners={rows.filter((r) => r.period === p && placeOf(r) === g.id)}
              readOnly={readOnly}
              onGive={(playerId) => onGive(p, playerId)}
              onRemove={onRemove}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
