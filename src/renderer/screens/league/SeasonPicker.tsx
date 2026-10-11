import { useSearchParams } from 'react-router'
import { Notice, Select } from '../../components/ui'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { seasonLabel } from './util'

/** The season a League Office screen shows, picked in its header. */
export interface SeasonPick {
  /** The season on screen. */
  seasonId: number
  /** Over and read only: every action that changes data is hidden. */
  past: boolean
  label: string
  /** What to pass to a read: nothing for the current season (the server knows it), else the id. */
  arg: number | undefined
  pick: (seasonId: number) => void
}

/**
 * The season lives in the URL (`?season=<id>`), so back, forward and a
 * reload keep it; no parameter means the current season. Other parameters
 * stay as they are.
 */
export function useSeasonPick(): SeasonPick {
  const { league } = useLeague()
  const [params, setParams] = useSearchParams()
  const asked = Number(params.get('season'))
  const current = league.season.id
  const seasonId = Number.isInteger(asked) && asked > 0 ? asked : current
  const past = seasonId !== current
  // An id the league doesn't have still goes to the server, which says so (and the notice offers the way back).
  const label = seasonLabel(league, seasonId)
  const pick = (id: number) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (id === current) next.delete('season')
      else next.set('season', String(id))
      return next
    })
  return { seasonId, past, label, arg: past ? seasonId : undefined, pick }
}

/** A compact season picker for a screen's header; nothing while the league has only one season. */
export function SeasonPicker({ season }: { season: SeasonPick }) {
  const { league } = useLeague()
  if (league.seasons.length < 2) return null
  const options = [...league.seasons].reverse().map((s) => ({ value: String(s.id), label: s.current ? t.seasonPick.current(s.label) : s.label }))
  // An unknown id from the URL shows as itself until the user picks again.
  if (!options.some((o) => o.value === String(season.seasonId))) options.push({ value: String(season.seasonId), label: season.label })
  return <Select compact ariaLabel={t.seasonPick.label} value={String(season.seasonId)} options={options} onChange={(v) => season.pick(Number(v))} />
}

/** Says a past season is on screen (read only), with the way back to the current one. */
export function PastSeasonNotice({ season }: { season: SeasonPick }) {
  const { league } = useLeague()
  if (!season.past) return null
  return (
    <Notice tone="info">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>{t.seasonPick.viewing(season.label)}</span>
        <button className="btn small" onClick={() => season.pick(league.season.id)}>
          {t.seasonPick.back}
        </button>
      </div>
    </Notice>
  )
}
