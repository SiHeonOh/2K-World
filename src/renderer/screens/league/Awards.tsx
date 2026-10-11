import { useMemo, useState } from 'react'
import type { AwardRow } from '@shared/season'
import { call } from '../../api'
import { Loading, Select, TextInput } from '../../components/ui'
import { useLoad } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { RuleErrors } from './RuleErrors'
import { PastSeasonNotice, SeasonPicker, useSeasonPick } from './SeasonPicker'

/** Player labels ("name (team)") by id, and the picker's options, built once per snapshot. */
interface Picker {
  names: Map<string, string>
  options: { value: string; label: string }[]
  /** A winner's label, with the team he won it for (kept with the award). */
  winner: (row: AwardRow) => string
}

export function Awards() {
  const { league } = useLeague()
  const [tick, setTick] = useState(0)
  // A past season's awards can be looked at, not given or taken back.
  const season = useSeasonPick()
  const readOnly = season.past
  // Kept while refetching, so the slots (and the period fields) stay mounted after give/remove.
  const list = useLoad(() => call('awards.list', league.slug, season.arg), [`${league.slug}:${season.seasonId}`, tick], { keepPrevious: true })
  const [error, setError] = useState<unknown>(null)
  const { awards } = league.config
  const picker = useMemo((): Picker => {
    const teams = new Map(league.teams.map((tm) => [tm.id, tm.shortName]))
    const players = new Map(league.players.map((p) => [p.id, p.name]))
    const names = new Map(league.players.map((p) => [p.id, `${p.name} (${teams.get(p.teamId) ?? ''})`]))
    return {
      names,
      options: [{ value: '', label: t.awards.pickPlayer }, ...[...names].map(([value, label]) => ({ value, label }))],
      winner: (row) => `${players.get(row.playerId) ?? row.playerId} (${teams.get(row.teamId) ?? row.teamId})`,
    }
  }, [league.teams, league.players])

  const give = async (awardId: string, period: string, teamRank: number, playerId: string) => {
    setError(null)
    try {
      await call('awards.give', league.slug, { awardId, period, teamRank, playerId })
      setTick((x) => x + 1)
    } catch (e) {
      setError(e)
    }
  }
  const remove = async (id: number) => {
    // Taking an award back is news (the wiki gets a 수상 취소 line), so it asks first.
    const row = list.state === 'ready' ? list.value.find((r) => r.id === id) : undefined
    const award = [...awards.season, ...awards.periodic].find((a) => a.id === row?.awardId)?.name ?? ''
    if (!window.confirm(t.awards.confirmRemove(row?.period ? `${award} (${row.period})` : award, row ? picker.winner(row) : ''))) return
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
              picker={picker}
              label={a.kind === 'selection' ? t.awards.teamN(rank) : ''}
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
          picker={picker}
          name={a.name}
          limit={a.winners}
          rows={rows.filter((r) => r.awardId === a.id)}
          readOnly={readOnly}
          onGive={(period, playerId) => void give(a.id, period, 1, playerId)}
          onRemove={(id) => void remove(id)}
        />
      ))}
    </div>
  )
}

function AwardSlot({
  picker,
  label,
  limit,
  winners,
  readOnly,
  onGive,
  onRemove,
}: {
  picker: Picker
  label: string
  limit: number
  winners: AwardRow[]
  readOnly: boolean
  onGive: (playerId: string) => void
  onRemove: (id: number) => void
}) {
  const [pick, setPick] = useState('')
  return (
    <div className="row award-slot">
      {label ? <b style={{ width: 48 }}>{label}</b> : null}
      {winners.map((w) => (
        <span key={w.id} className="badge accent">
          {picker.winner(w)}
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
          <Select
            compact
            ariaLabel={t.awards.pickPlayer}
            value={pick}
            options={picker.options}
            onChange={setPick}
          />
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

function PeriodicAward({
  picker,
  name,
  limit,
  rows,
  readOnly,
  onGive,
  onRemove,
}: {
  picker: Picker
  name: string
  limit: number
  rows: AwardRow[]
  readOnly: boolean
  onGive: (period: string, playerId: string) => void
  onRemove: (id: number) => void
}) {
  const [period, setPeriod] = useState('w1')
  // Looking back, only the periods that were given.
  const periods = [...new Set([...rows.map((r) => r.period), ...(readOnly ? [] : [period])])].filter((p) => /^[wm]\d{1,3}$/.test(p)).sort()
  return (
    <div className="card">
      <div className="card-head">
        <h3>{name}</h3>
        {readOnly ? null : (
          <TextInput value={period} onChange={(v) => setPeriod(v.trim().toLowerCase())} ariaLabel={t.awards.period} placeholder={t.awards.periodHelp} width={120} />
        )}
      </div>
      {readOnly && periods.length === 0 ? <p className="muted">{t.awards.noneThen}</p> : null}
      {periods.map((p) => (
        <AwardSlot
          key={p}
          picker={picker}
          label={p}
          limit={limit}
          winners={rows.filter((r) => r.period === p)}
          readOnly={readOnly}
          onGive={(playerId) => onGive(p, playerId)}
          onRemove={onRemove}
        />
      ))}
    </div>
  )
}
