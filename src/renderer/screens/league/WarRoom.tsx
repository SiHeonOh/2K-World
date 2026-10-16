import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import type { DealView, DraftNoteView, GmView, NegotiationView, StepView, WindowView } from '@shared/gm'
import type { CardRow } from '@shared/season'
import { call } from '../../api'
import { Badge, Check, ErrorBox, Loading, Notice, Segmented } from '../../components/ui'
import { useLoad } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { useRoundName } from './Played'
import { RuleErrors } from './RuleErrors'
import { cardName, formatDate } from './util'

const tg = t.gm
type Tab = 'log' | 'draft' | 'gms'

interface Names {
  team: (id: string) => string
  player: (id: string) => string
  card: (id: number) => string
  gm: (teamId: string) => string
}

/** 단장실: the trade window, deals waiting for you, the negotiation log and each GM's plan. */
export function WarRoom() {
  const { league, reload: reloadLeague } = useLeague()
  // Windows open after rounds, or (2K 일정대로) sessions: "R5", "5일차".
  const roundName = useRoundName('short')
  const [tick, setTick] = useState(0)
  const [poll, setPoll] = useState(0)
  const reload = () => setTick((x) => x + 1)
  const status = useLoad(() => call('gm.status', league.slug), [league.slug, tick, poll], { keepPrevious: true })
  // Only the status is polled; the log and the GMs are read again when it moves.
  const moved = status.state === 'ready' ? `${status.value.open?.id ?? '-'}:${status.value.version}:${status.value.agreed}` : ''
  const windows = useLoad(() => call('gm.windows', league.slug), [league.slug, tick, moved], { keepPrevious: true })
  const gms = useLoad(() => call('gm.list', league.slug), [league.slug, tick, moved], { keepPrevious: true })
  const cards = useLoad(() => call('cards.list', league.slug), [league.slug, tick, moved], { keepPrevious: true })
  const draftNotes = useLoad(() => call('gm.draftNotes', league.slug), [league.slug, tick, moved], { keepPrevious: true })
  const [tab, setTab] = useState<Tab>('log')
  const [notes, setNotes] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const working = status.state === 'ready' && (status.value.open !== null || (status.value.draft?.working ?? 0) > 0)

  // While GMs are working, look again every few seconds; when the window closes, rosters may have changed.
  const wasWorking = useRef(false)
  useEffect(() => {
    if (wasWorking.current && !working) reloadLeague()
    wasWorking.current = working
    if (!working) return
    const id = setInterval(() => setPoll((x) => x + 1), 4000)
    return () => clearInterval(id)
  }, [working])

  const names: Names = useMemo(() => {
    const cardList: CardRow[] = cards.state === 'ready' ? cards.value : []
    const gmList: GmView[] = gms.state === 'ready' ? gms.value : []
    const team = (id: string) => league.teams.find((tm) => tm.id === id)?.shortName ?? id
    return {
      team,
      player: (id) => league.players.find((p) => p.id === id)?.name ?? id,
      card: (id) => {
        const c = cardList.find((x) => x.id === id)
        return c ? cardName(league, c, league.season.id) : `#${id}`
      },
      gm: (teamId) => gmList.find((g) => g.teamId === teamId)?.name ?? tg.gmName(team(teamId)),
    }
  }, [league, cards, gms])

  const act = async (fn: () => Promise<string | null>, after?: () => void) => {
    if (busy) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      setMessage(await fn())
      after?.()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
      reload()
    }
  }
  const openWindow = () => {
    if (!window.confirm(tg.confirmOpen)) return
    void act(async () => tg.opened((await call('gm.openWindow', league.slug)).gms))
  }
  const approve = (id: number) =>
    void act(async () => ((await call('gm.approve', league.slug, id)).status === 'accepted' ? tg.approved : tg.approveFailed), reloadLeague)
  const decline = (id: number) => {
    if (!window.confirm(tg.confirmDecline)) return
    void act(async () => (await call('gm.decline', league.slug, id), null))
  }
  const veto = (tradeId: number) => {
    if (!window.confirm(tg.confirmVeto)) return
    void act(async () => (await call('trades.veto', league.slug, tradeId), null), reloadLeague)
  }

  const agreed = windows.state === 'ready' ? windows.value.flatMap((w) => w.negotiations).filter((n) => n.status === 'agreed') : []

  return (
    <div className="page warroom">
      <div className="page-head">
        <div>
          <h1>{tg.title}</h1>
          <p className="sub">{tg.intro}</p>
        </div>
      </div>
      {status.state === 'ready' ? (
        <div className="card gm-status">
          <div className="card-head">
            <div className="stack" style={{ gap: 2 }}>
              <b>{status.value.open ? tg.windowOpen(status.value.open.round, roundName) : tg.windowClosed}</b>
              {status.value.open ? (
                <span className="row muted">
                  <span className="spin" /> {tg.working(status.value.open.jobs)}
                </span>
              ) : status.value.nextRound !== null ? (
                <span className="muted">{tg.nextWindow(status.value.nextRound, roundName)}</span>
              ) : status.value.manual && status.value.blocked !== 'phase' ? (
                <span className="muted">{tg.manualOnly}</span>
              ) : (
                <span className="muted">{tg.blocked.phase}</span>
              )}
            </div>
            <button className="btn primary small" disabled={busy || !status.value.canOpen} onClick={openWindow}>
              {tg.openNow}
            </button>
          </div>
          {!status.value.aiReady ? <Notice tone="warn">{tg.aiOff}</Notice> : null}
          {status.value.blocked && status.value.blocked !== 'open' && status.value.blocked !== 'phase' ? <p className="help">{tg.blocked[status.value.blocked]}</p> : null}
        </div>
      ) : null}
      {message ? <Notice tone="ok">{message}</Notice> : null}
      {error ? <RuleErrors error={error} /> : null}

      {agreed.length > 0 ? (
        <section className="stack">
          <h3>{tg.approvals}</h3>
          <p className="help">{tg.approvalsHelp}</p>
          {agreed.map((n) => (
            <Negotiation key={n.id} n={n} names={names} notes={notes} busy={busy} onVeto={veto}>
              <div className="row">
                <button className="btn primary small" disabled={busy} onClick={() => approve(n.id)}>
                  {tg.approve}
                </button>
                <button className="btn ghost small" disabled={busy} onClick={() => decline(n.id)}>
                  {tg.decline}
                </button>
              </div>
            </Negotiation>
          ))}
        </section>
      ) : null}

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <Segmented<Tab> value={tab} ariaLabel={tg.title} options={(['log', 'draft', 'gms'] as const).map((v) => ({ value: v, label: tg.tabs[v]! }))} onChange={setTab} />
        {tab !== 'gms' ? (
          <Check checked={notes} onChange={setNotes}>
            {tg.showNotes}
          </Check>
        ) : null}
      </div>

      {tab === 'log' ? (
        windows.state === 'loading' ? (
          <Loading />
        ) : windows.state === 'error' ? (
          <ErrorBox error={windows.error} onRetry={windows.reload} />
        ) : windows.value.length === 0 ? (
          <div className="card">
            <p className="help">{tg.noWindows}</p>
          </div>
        ) : (
          windows.value.map((w) => <Window key={w.id} w={w} names={names} notes={notes} busy={busy} onVeto={veto} />)
        )
      ) : tab === 'draft' ? (
        draftNotes.state === 'loading' ? (
          <Loading />
        ) : draftNotes.state === 'error' ? (
          <ErrorBox error={draftNotes.error} onRetry={draftNotes.reload} />
        ) : draftNotes.value.length === 0 ? (
          <div className="card">
            <p className="help">{tg.draftEmpty}</p>
          </div>
        ) : (
          <div className="stack">
            {draftNotes.value.map((n) => (
              <DraftNote key={n.id} n={n} names={names} notes={notes} />
            ))}
          </div>
        )
      ) : gms.state === 'loading' ? (
        <Loading />
      ) : gms.state === 'error' ? (
        <ErrorBox error={gms.error} onRetry={gms.reload} />
      ) : (
        <div className="gm-grid">
          {gms.value.map((g) => (
            <GmCard key={g.teamId} g={g} names={names} />
          ))}
        </div>
      )}
    </div>
  )
}

function Window({ w, names, notes, busy, onVeto }: { w: WindowView; names: Names; notes: boolean; busy: boolean; onVeto: (tradeId: number) => void }) {
  const trades = w.negotiations.filter((n) => n.status === 'accepted').length
  const roundName = useRoundName('short')
  return (
    <section className="gm-window">
      <div className="gm-window-head">
        <h3>{tg.windowTitle(w.round, roundName)}</h3>
        <span className="muted">
          {formatDate(w.openedAt, true)} · {w.status === 'open' ? tg.windowOpen(w.round, roundName) : tg.windowCounts(trades, w.negotiations.length)}
        </span>
      </div>
      {w.hidden ? <p className="help">{tg.hidden}</p> : null}
      {!w.hidden && w.negotiations.length === 0 ? <p className="help">{tg.noTalks}</p> : null}
      {w.negotiations.map((n) => (
        <Negotiation key={n.id} n={n} names={names} notes={notes} busy={busy} onVeto={onVeto} />
      ))}
    </section>
  )
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'err' | 'info' | undefined> = { accepted: 'ok', agreed: 'info', open: 'info', rejected: undefined, failed: 'err', declined: 'warn' }

function Negotiation({
  n,
  names,
  notes,
  busy,
  onVeto,
  children,
}: {
  n: NegotiationView
  names: Names
  notes: boolean
  busy: boolean
  onVeto: (tradeId: number) => void
  children?: ReactNode
}) {
  const reason = n.reason ? (tg.reasons[n.reason] ?? tg.ruleFailed(n.reason)) : null
  return (
    <div className={`card gm-talk ${n.status}`}>
      <div className="gm-talk-head">
        <div className="row" style={{ gap: 8 }}>
          <b>
            {names.team(n.fromTeam)} → {names.team(n.toTeam)}
          </b>
          <Badge tone={STATUS_TONE[n.status]}>{tg.statuses[n.status]}</Badge>
          {n.vetoed ? <Badge tone="err">{tg.vetoed}</Badge> : null}
          {n.lopsided ? <Badge tone="warn">{tg.lopsided}</Badge> : null}
          {n.valueGap !== null ? <span className="muted">{tg.gap(n.valueGap)}</span> : null}
        </div>
        <div className="row" style={{ gap: 8 }}>
          {n.tradeId ? (
            <Link className="muted" to="../trades" relative="path">
              {tg.toTrades}
            </Link>
          ) : null}
          {n.vetoable && n.tradeId ? (
            <button className="btn ghost small" disabled={busy} onClick={() => onVeto(n.tradeId!)}>
              {tg.veto}
            </button>
          ) : null}
        </div>
      </div>
      {n.deal ? <Deal deal={n.deal} names={names} /> : null}
      <div className="gm-steps">
        {n.steps.map((s) => (
          <Step key={s.id} s={s} left={s.teamId === n.fromTeam} names={names} notes={notes} />
        ))}
      </div>
      {reason ? <p className="help">{reason}</p> : null}
      {children}
    </div>
  )
}

function Deal({ deal, names }: { deal: DealView; names: Names }) {
  // Players, then any cards on top: "김하람, 박나래 + 가람고 1번 카드, 누리고 2번 카드".
  const side = (team: string, players: string[], cards: number[]) => (
    <div className="gm-deal-side">
      <span className="muted">{tg.sends(names.team(team))}</span>
      <span>{[players.map(names.player).join(', '), cards.map(names.card).join(', ')].filter(Boolean).join(' + ') || '—'}</span>
    </div>
  )
  return (
    <div className="gm-deal">
      {side(deal.a, deal.aGives, deal.aCards)}
      <span className="gm-deal-arrow">⇄</span>
      {side(deal.b, deal.bGives, deal.bCards)}
    </div>
  )
}

function Step({ s, left, names, notes }: { s: StepView; left: boolean; names: Names; notes: boolean }) {
  return (
    <div className={`gm-step ${left ? 'left' : 'right'} ${s.action}`}>
      <div className="gm-step-head">
        <b>{names.gm(s.teamId)}</b>
        <span className="muted">{names.team(s.teamId)}</span>
        <Badge tone={s.action === 'accept' ? 'ok' : s.action === 'reject' ? 'err' : 'accent'}>{tg.actions[s.action]}</Badge>
        {s.trust !== null && s.trust !== 0 ? <span className="muted">{tg.trust(s.trust)}</span> : null}
      </div>
      {s.message ? <p className="gm-message">{s.message}</p> : null}
      {s.deal && s.action === 'counter' ? <Deal deal={s.deal} names={names} /> : null}
      {notes && s.note ? (
        <p className="gm-note">
          <b>{tg.note}</b> {s.note}
        </p>
      ) : null}
      {notes && s.report ? <p className="gm-report muted">{tg.report(s.report.strengthBefore, s.report.strengthAfter, s.report.gain, s.report.cardsIn, s.report.cardsOut)}</p> : null}
    </div>
  )
}

function DraftNote({ n, names, notes }: { n: DraftNoteView; names: Names; notes: boolean }) {
  const what =
    n.kind === 'swap' && n.playerId && n.targetPlayerId
      ? tg.draftSwap(names.player(n.playerId), names.player(n.targetPlayerId), names.team(n.targetTeamId ?? ''))
      : n.kind === 'protect'
        ? n.playerId
          ? tg.draftProtect(names.player(n.playerId))
          : tg.draftNoProtect
        : ''
  return (
    <div className={`card gm-draft-note ${n.kind}`}>
      <div className="row" style={{ gap: 8 }}>
        <b>{names.gm(n.teamId)}</b>
        <span className="muted">{names.team(n.teamId)}</span>
        <Badge tone={n.kind === 'swap' ? 'accent' : n.kind === 'protect' ? 'info' : undefined}>{tg.draftKinds[n.kind]}</Badge>
        {n.vetoed ? <Badge tone="err">{tg.vetoed}</Badge> : null}
        <span>{what}</span>
      </div>
      {n.quote ? <p className="gm-message">“{n.quote}”</p> : null}
      {notes && n.note ? (
        <p className="gm-note">
          <b>{tg.note}</b> {n.note}
        </p>
      ) : null}
    </div>
  )
}

function GmCard({ g, names }: { g: GmView; names: Names }) {
  const { league } = useLeague()
  return (
    <div className={`card gm-card${g.active ? '' : ' inactive'}`}>
      <div className="card-head">
        <div className="stack" style={{ gap: 0 }}>
          <b>{g.name ?? tg.gmName(names.team(g.teamId))}</b>
          <span className="muted">
            {names.team(g.teamId)} · {tg.philosophies[g.philosophy]} · {tg.negotiations[g.negotiation]}
          </span>
        </div>
        <Link className="muted" to={`/l/${encodeURIComponent(league.slug)}/lore?gm=${encodeURIComponent(g.teamId)}`}>
          {tg.editLore}
        </Link>
      </div>
      {!g.active ? <Badge>{tg.inactive}</Badge> : null}
      {g.name === null ? <p className="help">{tg.noLoreName}</p> : null}
      {g.plan ? (
        <div className="stack" style={{ gap: 4 }}>
          <span>
            {g.plan.stance ? <Badge tone="accent">{tg.stances[g.plan.stance]}</Badge> : null} {g.plan.note}
          </span>
          {g.plan.quote ? (
            <span className="help">
              {tg.quote}: “{g.plan.quote}”
            </span>
          ) : null}
          {g.plan.targets.length ? (
            <span className="help">
              {tg.targets}: {g.plan.targets.map(names.player).join(', ')}
            </span>
          ) : null}
          {g.plan.untouchables.length ? (
            <span className="help">
              {tg.untouchables}: {g.plan.untouchables.map(names.player).join(', ')}
            </span>
          ) : null}
        </div>
      ) : g.active ? (
        <p className="help">{tg.noPlan}</p>
      ) : null}
      {g.trust.length ? (
        <div className="gm-trust">
          <span className="muted">{tg.trustTitle}</span>
          {g.trust.slice(0, 6).map((x) => (
            <span key={x.teamId} className={x.value > 0 ? 'up' : 'down'}>
              {names.team(x.teamId)} {x.value > 0 ? '+' : ''}
              {x.value}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
