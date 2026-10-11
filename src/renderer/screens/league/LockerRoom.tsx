import { useState } from 'react'
import { Link } from 'react-router'
import { FRANCHISE_LINE, WANTING_OUT_LINE, type LockerRoomView, type PlayerMoodView } from '@shared/mood'
import { call } from '../../api'
import { ErrorBox, Loading, Marked } from '../../components/ui'
import { useLoad } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'

const tm = t.mood

function Player({ p, slug, compact }: { p: PlayerMoodView; slug: string; compact?: boolean }) {
  return (
    <div className={`mood-row band-${p.band}`}>
      <div className="mood-name">
        {/* His page: mood over the season, what happened to him, what he said; his lore is one click on from there. */}
        <Link className="mood-lore" to={`/l/${encodeURIComponent(slug)}/player/${encodeURIComponent(p.playerId)}`} title={tm.openPlayer}>
          <b>{p.name}</b>
        </Link>
        {p.slot ? <span className="muted"> {p.slot}</span> : null}
        {!p.fromLore ? <span className="mood-default" title={tm.defaults}>*</span> : null}
        {p.feelings.attachment >= FRANCHISE_LINE ? (
          <span className="mood-tag franchise" title={tm.franchiseHelp}>
            {tm.franchise}
          </span>
        ) : null}
        {p.feelings.wantingOut >= WANTING_OUT_LINE ? (
          <span className="mood-tag wants-out" title={tm.wantsOutHelp}>
            {tm.wantsOut}
          </span>
        ) : null}
      </div>
      <span className={`mood-band band-${p.band}`}>{tm.bands[p.band]}</span>
      <div className="mood-bar" title={String(p.overall)}>
        <div className="mood-fill" style={{ left: p.overall < 0 ? `${50 + p.overall / 2}%` : '50%', width: `${Math.abs(p.overall) / 2}%` }} />
      </div>
      <div className="mood-reasons">
        {p.reasons.slice(0, 3).map((r) => (
          <span key={r.part} className={r.value < 0 ? 'neg' : 'pos'}>
            {tm.parts[r.part]} {r.value > 0 ? '▲' : '▼'}
          </span>
        ))}
      </div>
      <div className="mood-share muted">{tm.share(p.share, p.expectedShare)}</div>
      {p.said ? (
        <div className="mood-said">
          <span className="muted">{tm.channels[p.said.channel]}</span>
          {p.said.quote ? (
            <q>
              <Marked text={p.said.quote} numbers={p.said.flags} />
            </q>
          ) : null}
          {tm.actions[p.said.action] ? <span className={`mood-action ${p.said.action}`}>{tm.actions[p.said.action]}</span> : null}
          {p.said.note && !compact ? (
            <span className="mood-said-note" title={tm.note}>
              {tm.note}: {p.said.note}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** One team's locker room: who's unhappy and why, and ball-hungry teammates who clash. */
export function LockerRoom({ teamId, title, compact }: { teamId: string; title?: string; compact?: boolean }) {
  const { league } = useLeague()
  const room = useLoad(() => call('mood.team', league.slug, teamId), [teamId])
  const [all, setAll] = useState(!compact)
  if (room.state === 'loading') return <Loading />
  if (room.state === 'error') return <ErrorBox error={room.error} onRetry={room.reload} />
  const v: LockerRoomView = room.value
  const unhappy = v.players.filter((p) => p.band === 'unhappy' || p.band === 'boiling')
  const shown = all ? v.players : unhappy
  return (
    <div className="card mood">
      <div className="card-head">
        <h3>{title ?? tm.title}</h3>
        <span className="muted">
          {tm.strength(v.strength)} · {tm.games(v.games)}
        </span>
      </div>
      {v.clashes.length ? (
        <div className="mood-clashes">
          <b>{tm.clashes}</b>
          {v.clashes.map(([a, b]) => (
            <div key={`${a}-${b}`}>{tm.clash(a, b)}</div>
          ))}
        </div>
      ) : null}
      {shown.length === 0 ? <p className="muted">{tm.allCalm}</p> : shown.map((p) => <Player key={p.playerId} p={p} slug={league.slug} compact={compact} />)}
      {compact ? (
        <button className="btn small ghost" onClick={() => setAll((x) => !x)}>
          {all ? tm.hide : tm.show}
        </button>
      ) : null}
    </div>
  )
}
