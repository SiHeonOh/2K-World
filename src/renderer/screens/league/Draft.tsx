import { useEffect, useMemo, useRef, useState } from 'react'
import type { CardRow, DraftView } from '@shared/season'
import { call } from '../../api'
import { Badge, Loading, Notice, Select } from '../../components/ui'
import { useLoad } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { RuleErrors } from './RuleErrors'
import { PastSeasonNotice, SeasonPicker, useSeasonPick } from './SeasonPicker'
import { cardName as nameCard, rosterOf, seasonLabel } from './util'

type Run = (fn: () => Promise<unknown>, confirmText?: string) => Promise<void>

function useNames() {
  const { league } = useLeague()
  const teamName = (id: string | null) => (id ? (league.teams.find((tm) => tm.id === id)?.shortName ?? id) : '')
  const playerName = (id: string | null) => (id ? (league.players.find((p) => p.id === id)?.name ?? id) : '')
  /** As the season on screen names it (the current one unless given). */
  const cardName = (c: CardRow, seasonId = league.season.id) => nameCard(league, c, seasonId)
  return { teamName, playerName, cardName }
}

export function Draft() {
  const { league, reload, refreshing } = useLeague()
  const slug = league.slug
  // A past season shows its cards and its draft log, read only.
  const season = useSeasonPick()
  const past = season.past
  const inDraft = !past && league.season.phase === 'draft'
  const cardSwap = league.config.draft.kind === 'card-swap'
  const key = `${slug}:${season.seasonId}`
  const [tick, setTick] = useState(0)
  const cards = useLoad(() => call('cards.list', slug, season.arg), [key, tick], { keepPrevious: true })
  const view = useLoad(
    () => (inDraft || (past && cardSwap) ? call('draft.view', slug, season.arg) : Promise.resolve(null)),
    [key, tick, inDraft],
    { keepPrevious: true },
  )
  const [error, setError] = useState<unknown>(null)
  const [running, setRunning] = useState(false)
  const { teamName, cardName } = useNames()
  const d = t.draft
  // Moves wait for the refetch too, so a turn can't be played twice on stale data.
  const busy = running || refreshing || view.refreshing
  // A league without the card-swap draft has no cards, unless an earlier season had them.
  const showCards = cardSwap || cards.state === 'error' || (cards.state === 'ready' && cards.value.length > 0)

  const run: Run = async (fn, confirmText) => {
    if (busy || (confirmText && !window.confirm(confirmText))) return
    setRunning(true)
    setError(null)
    try {
      await fn()
      setTick((x) => x + 1)
      reload()
    } catch (e) {
      setError(e)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="page wide">
      <div className="page-head">
        <h1>{d.title}</h1>
        <SeasonPicker season={season} />
      </div>
      <PastSeasonNotice season={season} />
      {error ? <RuleErrors error={error} /> : null}
      {!cardSwap ? <Notice tone="info">{d.noCardDraft}</Notice> : null}
      {cardSwap && !inDraft && !past ? <Notice tone="info">{d.notYet}</Notice> : null}
      {past && cardSwap && view.state === 'loading' ? <Loading /> : null}
      {/* An unknown season fails both reads: one notice is enough. */}
      {past && view.state === 'error' && cards.state !== 'error' ? <RuleErrors error={view.error} onRetry={view.reload} /> : null}
      {past && view.state === 'ready' && view.value ? (
        view.value.actions.length > 0 ? (
          <DraftLog view={view.value} busy={busy} run={run} readOnly />
        ) : (
          <div className="card">
            <p className="help">{d.noLog}</p>
          </div>
        )
      ) : null}
      {inDraft && view.state === 'loading' ? <Loading /> : null}
      {inDraft && view.state === 'error' ? <RuleErrors error={view.error} onRetry={view.reload} /> : null}
      {inDraft && view.state === 'ready' && view.value ? <AiDraftStatus view={view.value} onMoved={() => (setTick((x) => x + 1), reload())} /> : null}
      {inDraft && view.state === 'ready' && view.value ? <DraftRoom view={view.value} busy={busy} run={run} /> : null}
      {inDraft && view.state === 'ready' && view.value ? <DraftLog view={view.value} busy={busy} run={run} readOnly={false} /> : null}

      {showCards ? (
        <div className="card flush">
          <div className="card-head" style={{ padding: '12px 16px' }}>
            <h2>{d.cardsTitle}</h2>
          </div>
          {cards.state === 'loading' ? <Loading /> : null}
          {cards.state === 'error' ? <RuleErrors error={cards.error} onRetry={cards.reload} /> : null}
          {cards.state === 'ready' ? (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{d.original}</th>
                    <th>{d.owner}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {cards.value.map((c) => (
                    <tr key={c.id}>
                      <td>{cardName(c, season.seasonId)}</td>
                      <td>
                        {teamName(c.ownerTeamId)} {c.ownerTeamId !== c.originalTeamId ? <Badge tone="info">↔</Badge> : null}
                      </td>
                      <td>
                        {/* A past season's card that went on to the next draft unplayed. */}
                        {c.carriedTo !== null ? (
                          <Badge tone="info">{d.carried(seasonLabel(league, c.carriedTo))}</Badge>
                        ) : (
                          <Badge tone={c.status === 'held' ? 'ok' : undefined}>{d.status[c.status]}</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** What the AI GMs are doing in the draft; while they work, the room refreshes as their moves land. */
function AiDraftStatus({ view, onMoved }: { view: DraftView; onMoved: () => void }) {
  const { league } = useLeague()
  const { teamName } = useNames()
  const tg = t.gm
  const [tick, setTick] = useState(0)
  const status = useLoad(() => call('gm.status', league.slug), [league.slug, tick, view.actions.length, view.protectionOpen], { keepPrevious: true })
  const draft = status.state === 'ready' ? status.value.draft : null
  const working = (draft?.working ?? 0) > 0
  useEffect(() => {
    if (!working) return
    const id = setInterval(() => setTick((x) => x + 1), 3000)
    return () => clearInterval(id)
  }, [working])
  // The AI GMs made moves (their notes moved the version): read the room again.
  const seen = useRef<number | null>(null)
  const version = status.state === 'ready' ? status.value.version : null
  useEffect(() => {
    if (version === null) return
    if (seen.current !== null && seen.current !== version) onMoved()
    seen.current = version
  }, [version])
  if (!draft) return null
  const aiTeams = league.teams.some((tm) => tm.control === 'ai')
  if (!aiTeams) return null
  // The server says when a nudge would do something (it shouldn't be needed while Claude works).
  const aiReady = status.state === 'ready' && status.value.aiReady
  const nudge = () =>
    void call('gm.reconcileDraft', league.slug)
      .catch(() => undefined)
      .finally(() => setTick((x) => x + 1))
  return (
    <Notice tone="info">
      {working ? (
        <span className="row">
          <span className="spin" /> {tg.draftWorking}
        </span>
      ) : draft.waitingFor ? (
        tg.draftWaiting(teamName(draft.waitingFor))
      ) : view.protectionOpen && draft.protectDone ? (
        tg.draftProtectDone
      ) : null}{' '}
      <span className="muted">{tg.draftWhy}</span>
      {draft.stuck ? (
        <button type="button" className="btn small" style={{ marginLeft: 8 }} onClick={nudge}>
          {aiReady ? tg.draftNudge : tg.draftCodeTurns}
        </button>
      ) : null}
    </Notice>
  )
}

function DraftLog({ view, busy, run, readOnly }: { view: DraftView; busy: boolean; run: Run; readOnly: boolean }) {
  const { league } = useLeague()
  const { teamName, playerName } = useNames()
  if (view.actions.length === 0) return null
  // Only the latest swap can be undone (later turns depend on it); the server checks it isn't in 2K yet.
  const lastMove = view.actions.filter((a) => a.kind !== 'protect').at(-1)
  return (
    <div className="card">
      <h2>{t.draft.log}</h2>
      <ol className="plain">
        {view.actions.map((a) => (
          <li key={a.id}>
            <b>{teamName(a.teamId)}</b> · {t.draft.kinds[a.kind]}
            {a.kind === 'protect' ? ` · ${playerName(a.playerId)}` : ''}
            {a.kind === 'swap' ? ` · ${playerName(a.playerId)} ↔ ${playerName(a.targetPlayerId)} (${teamName(a.targetTeamId)})` : ''}
            {a.kind === 'swap' && a.id === lastMove?.id && !readOnly ? (
              <button
                className="btn ghost small danger"
                disabled={busy}
                onClick={() => void run(() => call('draft.vetoSwap', league.slug, a.id), t.draft.confirmVeto)}
              >
                {t.draft.veto}
              </button>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  )
}

function DraftRoom({ view, busy, run }: { view: DraftView; busy: boolean; run: Run }) {
  const { league } = useLeague()
  const { teamName, playerName, cardName } = useNames()
  const d = t.draft
  const [protectTeam, setProtectTeam] = useState(view.order[0] ?? '')
  const [protectPlayer, setProtectPlayer] = useState('')
  const [own, setOwn] = useState('')
  const [target, setTarget] = useState('')
  const next = view.next
  const onClock = next?.ownerTeamId ?? null
  // Moved players (swapped either way, or traded during the draft) are protected too: never sent on, never taken.
  const protectedSet = useMemo(() => new Set([...view.protectedPlayers, ...view.movedPlayers]), [view.protectedPlayers, view.movedPlayers])
  const moved = useMemo(() => new Set(view.movedPlayers), [view.movedPlayers])
  const frozen = new Set(league.teams.filter((tm) => tm.control === 'frozen').map((tm) => tm.id))
  const sameSlot = league.config.draft.kind === 'card-swap' && league.config.draft.slotRule === 'same-slot'
  const ownPlayer = league.players.find((p) => p.id === own)
  const targets = league.players.filter(
    (p) =>
      onClock !== null &&
      p.teamId !== onClock &&
      !frozen.has(p.teamId) &&
      !protectedSet.has(p.id) &&
      (!sameSlot || !ownPlayer || ownPlayer.slotId === p.slotId),
  )

  return (
    <>
      <div className="card">
        <h2>{d.order}</h2>
        <div className="row" style={{ gap: 6 }}>
          {view.order.map((id, i) => (
            <Badge key={id} tone={id === onClock && !view.protectionOpen ? 'accent' : undefined}>
              {i + 1}. {teamName(id)}
            </Badge>
          ))}
        </div>
      </div>

      {view.protectionOpen ? (
        <div className="card">
          <h2>{d.protection}</h2>
          <p className="help">{d.protectionHelp}</p>
          <div className="row">
            <Select
              ariaLabel={d.team}
              value={protectTeam}
              options={view.order.map((id) => ({ value: id, label: teamName(id) }))}
              onChange={(x) => {
                setProtectTeam(x)
                setProtectPlayer('')
              }}
            />
            <Select
              ariaLabel={d.player}
              value={protectPlayer}
              options={[
                { value: '', label: d.player },
                ...rosterOf(league, protectTeam)
                  .filter((p) => !protectedSet.has(p.id))
                  .map((p) => ({ value: p.id, label: p.name })),
              ]}
              onChange={setProtectPlayer}
            />
            <button
              className="btn primary"
              disabled={busy || protectPlayer === ''}
              onClick={() =>
                void run(async () => {
                  await call('draft.move', league.slug, { kind: 'protect', teamId: protectTeam, playerId: protectPlayer })
                  setProtectPlayer('')
                })
              }
            >
              {d.protect}
            </button>
          </div>
          <div className="row" style={{ gap: 6 }}>
            {league.players
              .filter((p) => protectedSet.has(p.id))
              .map((p) => (
                <Badge key={p.id} tone="info">
                  {teamName(p.teamId)} · {p.name}
                </Badge>
              ))}
          </div>
          <div>
            <button className="btn" disabled={busy} onClick={() => void run(() => call('draft.closeProtection', league.slug), d.confirmClose)}>
              {d.closeProtection}
            </button>
          </div>
        </div>
      ) : next ? (
        <div className="card">
          <h2>{d.onClock(teamName(next.ownerTeamId), cardName(next))}</h2>
          <div className="row">
            <Select
              ariaLabel={d.own}
              value={own}
              options={[
                { value: '', label: d.own },
                ...rosterOf(league, next.ownerTeamId)
                  .filter((p) => !moved.has(p.id))
                  .map((p) => ({ value: p.id, label: p.name })),
              ]}
              onChange={(x) => {
                setOwn(x)
                setTarget('')
              }}
            />
            <span>↔</span>
            <Select
              ariaLabel={d.target}
              value={target}
              options={[{ value: '', label: d.target }, ...targets.map((p) => ({ value: p.id, label: `${teamName(p.teamId)} · ${p.name}` }))]}
              onChange={setTarget}
            />
            <button
              className="btn primary"
              disabled={busy || own === '' || target === ''}
              onClick={() =>
                void run(async () => {
                  await call('draft.move', league.slug, {
                    kind: 'swap',
                    teamId: next.ownerTeamId,
                    cardId: next.id,
                    playerId: own,
                    targetPlayerId: target,
                  })
                  setOwn('')
                  setTarget('')
                }, d.confirmSwap(playerName(own), playerName(target)))
              }
            >
              {d.swap}
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(
                  () => call('draft.move', league.slug, { kind: 'pass', teamId: next.ownerTeamId, cardId: next.id }),
                  d.confirmPass(cardName(next)),
                )
              }
            >
              {d.pass}
            </button>
          </div>
          {targets.length === 0 ? <p className="help">{d.noTargets}</p> : null}
        </div>
      ) : (
        <Notice tone="ok">{d.finished}</Notice>
      )}
      {!view.protectionOpen ? (
        <div>
          <button className="btn" disabled={busy} onClick={() => void run(() => call('draft.finish', league.slug), d.confirmFinish)}>
            {d.finish}
          </button>
        </div>
      ) : null}
    </>
  )
}
