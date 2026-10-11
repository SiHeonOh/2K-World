import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { PLAYER_TRAITS } from '@shared/lore'
import type { FeelingReasonView, MoodBand, MoodPartName, PlayerFeelingsView, PlayerStateView, PlayerTimelineItem } from '@shared/mood'
import { call } from '../../api'
import { Badge, ErrorBox, Loading, Marked, Select } from '../../components/ui'
import { useLoad } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'

const tm = t.mood
const tp = t.mood.player
const tf = t.mood.player.feelings

const PARTS: MoodPartName[] = ['role', 'usage', 'production', 'winning', 'recognition', 'relationships', 'rivalry', 'stability', 'belonging']
/** The bands' lower edges on the −100..+100 scale (the mood engine's thresholds). */
const ZONES: { band: MoodBand; from: number; to: number }[] = [
  { band: 'happy', from: 45, to: 100 },
  { band: 'content', from: 15, to: 45 },
  { band: 'neutral', from: -20, to: 15 },
  { band: 'unhappy', from: -50, to: -20 },
  { band: 'boiling', from: -100, to: -50 },
]

const when = (iso: string) => {
  const d = new Date(iso)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getMonth() + 1)}.${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/** One player over a season: his mood after each game or move, what happened to him, and what he said. */
export function PlayerPage() {
  const { playerId = '' } = useParams()
  // Another player (a relationship link) starts again on the current season.
  return <PlayerView key={playerId} playerId={playerId} />
}

function PlayerView({ playerId }: { playerId: string }) {
  const { league } = useLeague()
  const [season, setSeason] = useState<number | undefined>(undefined)
  const view = useLoad(() => call('mood.player', league.slug, playerId, season), [playerId, season])
  if (view.state === 'loading') return <Loading />
  if (view.state === 'error') return <ErrorBox error={view.error} onRetry={view.reload} />
  const v: PlayerStateView = view.value
  const team = league.teams.find((x) => x.id === v.teamId)
  const short = (id: string) => league.teams.find((x) => x.id === id)?.shortName ?? id
  const slug = encodeURIComponent(league.slug)
  const parts = v.now?.parts ?? v.history.at(-1)?.parts ?? null

  return (
    <div className="page wide pstate">
      <div className="page-head pstate-head">
        <div>
          <p className="muted">
            <Link to={`/l/${slug}/team/${encodeURIComponent(v.teamId)}`}>{team?.shortName}</Link>
            {' / '}
            {tp.title}
          </p>
          <h1 className="row">
            {v.name}
            {v.now ? <span className={`mood-band band-${v.now.band}`}>{tm.bands[v.now.band]}</span> : null}
          </h1>
          <p className="sub">
            {[team?.name, v.slot, v.ovr !== null ? `OVR ${v.ovr}` : null].filter(Boolean).join(' · ')}
            {v.now ? ` · ${tp.overall(v.now.overall)}` : ''}
          </p>
        </div>
        <div className="row">
          {v.request ? (
            <span title={tp.requestHelp}>
              <Badge tone={v.request.active ? 'err' : undefined}>{tp.request(tm.actions[v.request.action] ?? v.request.action, v.request.active)}</Badge>
            </span>
          ) : null}
          {v.seasons.length > 1 ? (
            <Select
              compact
              ariaLabel={tp.season}
              value={String(v.seasonId)}
              options={v.seasons.map((s) => ({ value: String(s.id), label: s.label }))}
              onChange={(x) => setSeason(Number(x))}
            />
          ) : null}
          <Link className="btn small" to={`/l/${slug}/lore?player=${encodeURIComponent(v.playerId)}`}>
            {tp.editLore}
          </Link>
          <Link className="btn small" to={`/l/${slug}/team/${encodeURIComponent(v.teamId)}`}>
            {tp.teamPage}
          </Link>
        </div>
      </div>
      {!v.current ? <p className="muted">{tp.pastSeason}</p> : null}

      <div className="card pstate-chart">
        <div className="card-head">
          <h3>{tp.chart}</h3>
          <span className="muted">{tp.chartHelp}</span>
        </div>
        {v.history.length === 0 ? <p className="muted">{tp.noHistory}</p> : <MoodChart v={v} short={short} />}
      </div>
      {v.history.filter((h) => h.feelings).length > 1 ? (
        <div className="card pstate-chart">
          <div className="card-head">
            <h3>{tp.feelingsChart}</h3>
            <span className="muted">{tp.feelingsChartHelp}</span>
          </div>
          <FeelingsChart v={v} />
        </div>
      ) : null}

      <div className="pstate-grid">
        <div className="card">
          <h3>{tp.timeline}</h3>
          {v.timeline.length === 0 ? (
            <p className="muted">{tp.noTimeline}</p>
          ) : (
            <ul className="pstate-timeline">
              {v.timeline.map((item, i) => (
                <TimelineRow key={i} item={item} short={short} />
              ))}
            </ul>
          )}
        </div>
        <div>
          {v.now ? <FeelingsCard f={v.now.feelings} /> : null}
          {parts ? (
            <div className="card">
              <h3>{v.now ? tp.now : tp.parts}</h3>
              <div className="pstate-parts">
                {PARTS.map((part) => {
                  const n = Math.round(parts[part] ?? 0)
                  return [
                    <span key={`${part}-l`}>{tm.parts[part]}</span>,
                    <div key={`${part}-b`} className="pstate-bar" title={String(n)}>
                      <i className={n < 0 ? 'neg' : 'pos'} style={{ left: n < 0 ? `${50 + n / 2}%` : '50%', width: `${Math.abs(n) / 2}%` }} />
                    </div>,
                    <span key={`${part}-n`} className="num">
                      {n > 0 ? `+${n}` : n}
                    </span>,
                  ]
                })}
              </div>
              {v.now ? <p className="muted small">{tm.share(v.now.share, v.now.expectedShare)}</p> : null}
            </div>
          ) : null}
          <div className="card">
            <h3>{tp.traits}</h3>
            {!v.fromLore ? <p className="muted small">{tp.defaults}</p> : null}
            <div className="pstate-traits">
              {PLAYER_TRAITS.map((trait) => {
                const n = v.traits[trait] ?? 3
                return (
                  <span key={trait} title={t.lore.playerTraits[trait]?.help}>
                    {t.lore.playerTraits[trait]?.name ?? trait} <span className="dots">{'●'.repeat(n)}{'○'.repeat(Math.max(0, 5 - n))}</span>
                  </span>
                )
              })}
              {v.media ? <span>{tp.media(t.lore.mediaStyles[v.media] ?? v.media)}</span> : null}
            </div>
          </div>
          <div className="card">
            <h3>{tp.relationships}</h3>
            {v.relationships.length === 0 ? (
              <p className="muted">{tp.noRelationships}</p>
            ) : (
              <ul className="pstate-rels">
                {v.relationships.map((r, i) => (
                  <li key={i}>
                    {r.playerId ? <Link to={`/l/${slug}/player/${encodeURIComponent(r.playerId)}`}>{r.name}</Link> : r.name}{' '}
                    <span className="muted">
                      {t.lore.relationTypes[r.type] ?? r.type} {r.strength}
                    </span>{' '}
                    {r.visibility !== 'public' ? <Badge tone={r.visibility === 'secret' ? 'warn' : 'info'}>{t.lore.visibilities[r.visibility] ?? r.visibility}</Badge> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** One feeling as a bar (trust runs −100..+100 from the middle; the others 0..100), with what built it. */
function FeelingRow({ label, help, value, signedScale, why, names }: { label: string; help: string; value: number; signedScale?: boolean; why?: FeelingReasonView[]; names?: Record<string, string> }) {
  const n = Math.round(value)
  const style = signedScale ? { left: n < 0 ? `${50 + n / 2}%` : '50%', width: `${Math.abs(n) / 2}%` } : { left: 0, width: `${Math.max(0, Math.min(100, n))}%` }
  return (
    <div className="pstate-feeling">
      <div className="pstate-feeling-head" title={help}>
        <b>{label}</b>
        <span className="num">{signedScale && n > 0 ? `+${n}` : n}</span>
      </div>
      <div className={`pstate-bar${signedScale ? '' : ' plain'}`}>
        <i className={n < 0 ? 'neg' : 'pos'} style={style} />
      </div>
      {why?.length ? (
        <div className="pstate-feeling-why muted">
          {why.map((r, i) => (
            <span key={i}>
              {names?.[r.key] ?? r.key}
              {r.name ? ` ${r.name}` : ''}
              {r.secret ? ` (${tp.secretTie})` : ''} {r.value > 0 ? `+${r.value}` : r.value}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function FeelingsCard({ f }: { f: PlayerFeelingsView }) {
  return (
    <div className="card">
      <div className="card-head">
        <h3 title={tf.help}>{tf.title}</h3>
        <span className="muted small">{tf.belonging(f.belonging)}</span>
      </div>
      <FeelingRow label={tf.trust} help={tf.trustHelp} value={f.trust} signedScale why={f.why.trust} names={tf.trustWhy} />
      <FeelingRow label={tf.attachment} help={tf.attachmentHelp} value={f.attachment} why={f.why.attachment} names={tf.attachmentWhy} />
      <FeelingRow label={tf.wantingOut} help={tf.wantingOutHelp} value={f.wantingOut} />
      <div className="pstate-feeling">
        <div className="pstate-feeling-head">
          <b>{tf.grudges}</b>
        </div>
        {f.grudges.length === 0 ? (
          <p className="muted small">{tf.noGrudges}</p>
        ) : (
          <ul className="pstate-rels">
            {f.grudges.map((g, i) => (
              <li key={i}>
                {tf.grudge(g.name, tf.grudgeWhy[g.why] ?? g.why, g.games)} <span className="num neg-text">{g.value}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function TimelineRow({ item, short }: { item: PlayerTimelineItem; short: (id: string) => string }) {
  let body
  if (item.kind === 'said') {
    const w = item.words
    body = (
      <div className="what">
        <span className="muted">{tm.channels[w.channel] ?? w.channel}</span>
        {w.quote ? (
          <q>
            <Marked text={w.quote} numbers={w.flags} />
          </q>
        ) : null}
        {tm.actions[w.action] ? (
          <span className={`mood-action ${w.action}`}>
            {tm.actions[w.action]}
            {w.targetName ? ` ${tp.target(w.targetName)}` : ''}
          </span>
        ) : null}
        {w.note ? (
          <span className="mood-said-note">
            {tm.note}: {w.note}
          </span>
        ) : null}
        {w.cause ? <span className="muted small">{tp.after(w.cause)}</span> : null}
      </div>
    )
  } else if (item.kind === 'trade' || item.kind === 'draft') {
    body = (
      <div className={`what${item.vetoed ? ' vetoed' : ''}`}>
        <span>{(item.kind === 'trade' ? tp.trade : tp.draft)(short(item.from), short(item.to))}</span>
        {item.vetoed ? <Badge>{tp.vetoed}</Badge> : null}
      </div>
    )
  } else if (item.kind === 'award') {
    body = (
      <div className={`what${item.removed ? ' vetoed' : ''}`}>
        <span>{tp.award(item.award, item.period, item.teamRank)}</span>
        {item.removed ? <Badge>{tp.awardRemoved}</Badge> : null}
      </div>
    )
  } else if (item.kind === 'wanting') {
    body = (
      <div className="what">
        <span className="mood-tag wants-out">{tp.wanting(item.value)}</span>
      </div>
    )
  } else {
    body = (
      <div className="what">
        <span>{tp.mood(tm.bands[item.from] ?? item.from, tm.bands[item.to] ?? item.to)}</span>
        {item.reasons.length ? <span className="muted">({item.reasons.map((r) => tm.parts[r] ?? r).join(', ')})</span> : null}
      </div>
    )
  }
  return (
    <li>
      <span className="when">{when(item.at)}</span>
      {body}
    </li>
  )
}

/** The lasting feelings over the season on their own scale (no mood bands behind them), where snapshots kept them. */
function FeelingsChart({ v }: { v: PlayerStateView }) {
  const W = 720
  const H = 150
  const left = 52
  const right = 14
  const top = 10
  const bottom = 10
  const n = v.history.length
  const x = (i: number) => (n === 1 ? left + (W - left - right) / 2 : left + (i * (W - left - right)) / (n - 1))
  const y = (val: number) => top + ((100 - Math.max(-100, Math.min(100, val))) * (H - top - bottom)) / 200
  const line = (pick: (f: NonNullable<PlayerStateView['history'][number]['feelings']>) => number) => {
    let d = ''
    let open = false
    v.history.forEach((h, i) => {
      if (!h.feelings) {
        open = false
        return
      }
      d += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(pick(h.feelings)).toFixed(1)} `
      open = true
    })
    return d.trim()
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={tp.feelingsChart}>
      {[100, 50, 0, -50, -100].map((g) => (
        <g key={g}>
          <line className="axis" x1={left} x2={W - right} y1={y(g)} y2={y(g)} strokeDasharray={g === 0 ? undefined : '2 4'} opacity={g === 0 ? 1 : 0.5} />
          <text className="zone-label" x={left - 6} y={y(g) + 3} textAnchor="end">
            {g}
          </text>
        </g>
      ))}
      <path className="feeling-line trust" d={line((f) => f.trust)} />
      <path className="feeling-line attachment" d={line((f) => f.attachment)} />
      <path className="feeling-line wanting" d={line((f) => f.wantingOut)} />
    </svg>
  )
}

/** The overall mood after each snapshot, over the band zones, with moves, awards and words marked above. */
function MoodChart({ v, short }: { v: PlayerStateView; short: (id: string) => string }) {
  const W = 720
  const H = 220
  const left = 52
  const right = 14
  const top = 42
  const bottom = 10
  const n = v.history.length
  const x = (i: number) => (n === 1 ? left + (W - left - right) / 2 : left + (i * (W - left - right)) / (n - 1))
  const y = (val: number) => top + ((100 - Math.max(-100, Math.min(100, val))) * (H - top - bottom)) / 200
  // A move or an award sits over the first snapshot taken at or after it (the last one if none came
  // yet). Words come after the snapshot they answered, so they sit over the last one before them.
  const slot = (at: string, said: boolean) => {
    if (said) {
      const before = v.history.findLastIndex((h) => h.at <= at)
      return before === -1 ? 0 : before
    }
    const i = v.history.findIndex((h) => h.at >= at)
    return i === -1 ? n - 1 : i
  }
  const marks = v.timeline
    .filter((item) => item.kind !== 'mood' && item.kind !== 'wanting')
    .map((item) => {
      const glyph = item.kind === 'said' ? '“' : item.kind === 'award' ? '★' : '⇄'
      const label =
        item.kind === 'said'
          ? [tm.channels[item.words.channel], item.words.quote, tm.actions[item.words.action]].filter(Boolean).join(' · ')
          : item.kind === 'award'
            ? `${tp.award(item.award, item.period, item.teamRank)}${item.removed ? ` (${tp.awardRemoved})` : ''}`
            : item.kind === 'trade' || item.kind === 'draft'
              ? `${(item.kind === 'trade' ? tp.trade : tp.draft)(short(item.from), short(item.to))}${item.vetoed ? ` (${tp.vetoed})` : ''}`
              : ''
      const vetoed = ((item.kind === 'trade' || item.kind === 'draft') && item.vetoed) || (item.kind === 'award' && item.removed)
      return { i: slot(item.at, item.kind === 'said'), glyph, label: `${when(item.at)} · ${label}`, kind: item.kind, vetoed }
    })
  // Marks on the same snapshot stack upward, three at most: the third holds the rest in its tooltip.
  const bySlot = new Map<number, typeof marks>()
  for (const m of marks) bySlot.set(m.i, [...(bySlot.get(m.i) ?? []), m])
  const shown = [...bySlot.values()].flatMap((group) =>
    group.length <= 3
      ? group.map((m, level) => ({ ...m, level }))
      : [...group.slice(0, 2).map((m, level) => ({ ...m, level })), { ...group[2]!, glyph: '…', level: 2, label: group.slice(2).map((m) => m.label).join('\n') }],
  )
  const path = v.history.map((h, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(h.overall).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={tp.chart}>
      {ZONES.map((z) => (
        <g key={z.band}>
          <rect x={left} y={y(z.to)} width={W - left - right} height={y(z.from) - y(z.to)} fill={`var(--band-${z.band})`} opacity={0.1} />
          <text className="zone-label" x={left - 6} y={(y(z.to) + y(z.from)) / 2 + 3} textAnchor="end">
            {tm.bands[z.band]}
          </text>
        </g>
      ))}
      <line className="axis" x1={left} x2={W - right} y1={y(0)} y2={y(0)} strokeDasharray="3 3" />
      {n > 1 ? <path className="line" d={path} /> : null}
      {v.history.map((h, i) => {
        const top3 = PARTS.map((p) => [p, h.parts[p] ?? 0] as const)
          .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
          .slice(0, 3)
          .filter(([, val]) => Math.abs(val) >= 5)
          .map(([p, val]) => `${tm.parts[p]} ${val > 0 ? '+' : ''}${Math.round(val)}`)
          .join(', ')
        return (
          <circle key={i} cx={x(i)} cy={y(h.overall)} r={4} fill={`var(--band-${h.band})`}>
            <title>{tp.point(when(h.at), tm.bands[h.band] ?? h.band, h.overall, top3)}</title>
          </circle>
        )
      })}
      {shown.map((m, k) => (
        <text key={k} className={`marker ${m.kind}${m.vetoed ? ' vetoed' : ''}`} x={x(m.i)} y={top - 8 - m.level * 12} textAnchor="middle">
          {m.glyph}
          <title>{m.label}</title>
        </text>
      ))}
    </svg>
  )
}
