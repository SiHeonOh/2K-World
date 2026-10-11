import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import type { LeagueSnapshot, PlayerRow } from '@shared/league'
import { formatHeight } from '@shared/height'
import { GradeBadge, OvrBadge } from '../../components/ui'
import { t } from '../../i18n'
import { gradeLabels } from './util'

type SortKey = { kind: 'slot' } | { kind: 'name' } | { kind: 'team' } | { kind: 'height' } | { kind: 'rating'; id: string }

/** Players with every rating column. Click a header to sort. */
export function RosterTable({
  league,
  players,
  showTeam,
}: {
  league: LeagueSnapshot
  players: PlayerRow[]
  showTeam?: boolean
}) {
  const { config } = league
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: { kind: 'slot' }, desc: false })
  const scale = useMemo(() => gradeLabels(config), [config])
  const slotIndex = useMemo(() => new Map(config.roster.slots.map((s, i) => [s.id, i])), [config])
  const slotName = useMemo(() => new Map(config.roster.slots.map((s) => [s.id, s.name])), [config])
  const teams = useMemo(() => new Map(league.teams.map((tm) => [tm.id, tm])), [league])
  const teamIndex = useMemo(() => new Map(league.teams.map((tm, i) => [tm.id, i])), [league])

  // Colour number ratings by where they sit within this league, not the column's full range.
  const ranges = useMemo(() => {
    const out = new Map<string, { min: number; max: number }>()
    for (const c of config.ratings.columns) {
      if (c.kind !== 'number') continue
      let min = Infinity
      let max = -Infinity
      for (const p of league.players) {
        const v = p.ratings[c.id]
        if (typeof v === 'number') {
          min = Math.min(min, v)
          max = Math.max(max, v)
        }
      }
      out.set(c.id, min <= max ? { min, max } : { min: c.min, max: c.max })
    }
    return out
  }, [league, config])

  const sorted = useMemo(() => {
    const value = (p: PlayerRow): number | string => {
      const k = sort.key
      const slot = slotIndex.get(p.slotId ?? '') ?? 999
      const team = teamIndex.get(p.teamId) ?? 999
      switch (k.kind) {
        case 'slot':
          return slot * 1000 + team
        case 'team':
          return team * 1000 + slot
        case 'name':
          return p.name
        case 'height':
          return p.heightCm ?? 0
        case 'rating': {
          const v = p.ratings[k.id]
          if (typeof v === 'number') return v
          if (typeof v === 'string') {
            // Best grade is highest; a grade not in the scale sorts below the worst one.
            const i = scale.indexOf(v)
            return i < 0 ? 0 : scale.length - i
          }
          return -1
        }
      }
    }
    const list = [...players]
    list.sort((a, b) => {
      const va = value(a)
      const vb = value(b)
      const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'ko')
      return sort.desc ? -c : c
    })
    return list
  }, [players, sort, slotIndex, teamIndex, scale])

  const header = (key: SortKey, label: string, className = '') => {
    const id = JSON.stringify(key)
    const same = JSON.stringify(sort.key) === id
    // A button inside the header, so sorting works from the keyboard too.
    return (
      <th key={id} className={`sortable ${className}`} aria-sort={same ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
        <button
          type="button"
          className="sort"
          onClick={() => setSort({ key, desc: same ? !sort.desc : key.kind === 'rating' || key.kind === 'height' })}
        >
          {label}
          {same ? (sort.desc ? ' ▼' : ' ▲') : ''}
        </button>
      </th>
    )
  }

  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            {showTeam ? header({ kind: 'team' }, t.office.teams) : null}
            {header({ kind: 'slot' }, t.office.slot)}
            {header({ kind: 'name' }, t.office.name)}
            {header({ kind: 'height' }, t.office.height)}
            {config.ratings.columns.map((c) => header({ kind: 'rating', id: c.id }, c.name, 'center'))}
            <th>{t.office.nicknames}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => {
            const team = teams.get(p.teamId)
            return (
              <tr key={p.id}>
                {showTeam ? (
                  <td>
                    <Link to={`../team/${encodeURIComponent(p.teamId)}`} relative="path">
                      {team?.shortName}
                    </Link>
                  </td>
                ) : null}
                <td>{slotName.get(p.slotId ?? '') ?? '–'}</td>
                <td>
                  <Link className="roster-player" to={`/l/${encodeURIComponent(league.slug)}/player/${encodeURIComponent(p.id)}`} title={t.mood.openPlayer}>
                    <b>{p.name}</b>
                  </Link>
                </td>
                <td>{p.heightCm ? formatHeight(p.heightCm, config.playerFields.heightUnit) : p.height}</td>
                {config.ratings.columns.map((c) => {
                  const v = p.ratings[c.id] ?? null
                  const r = ranges.get(c.id)
                  return (
                    <td key={c.id} className="center">
                      {c.kind === 'number' ? (
                        <OvrBadge value={typeof v === 'number' ? v : null} min={r?.min ?? 0} max={r?.max ?? 99} />
                      ) : (
                        <GradeBadge grade={typeof v === 'string' ? v : null} scale={scale} />
                      )}
                    </td>
                  )
                })}
                <td className="wrap">{p.nicknames.join(', ')}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
