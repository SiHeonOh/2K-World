import type { DraftNoteView, GmStatusView, GmView, NegotiationView, WindowView } from '@shared/gm'
import { GM_TRAITS } from '@shared/lore'
import { lastEventId, setStoryValue, storyValue } from '@data/community'
import { jsonField, transaction, type Db } from '@data/db'
import {
  agreedNegotiations,
  getNegotiation,
  insertWindow,
  listNegotiations,
  listSteps,
  listWindows,
  memoryOf,
  openWindowRow,
  updateNegotiation,
  windowAfterRound,
} from '@data/gm'
import { appendEvent, currentSeason, listTeams, loadConfig } from '@data/league'
import { lastClosedSession, playedSeason } from '@data/played'
import { readLeague } from '@story/context'
import { GM_INTENT, GM_PRIORITY, GM_RESPOND, GMS_PER_CALL, intentInput, maybeClose, motivatedGms, readMarket, settleDeal, type GmHooks } from '@sim/gm'
import { autoPlay, DRAFT_PRIORITY, GM_PROTECT, GM_SWAP, protectInputs, readDraft, swapInput, swapOptions, type DraftData } from '@sim/draft'
import { draftView } from '@data/moves'
import { playerTradesOpen } from '@core/trades'
import { CANCELLED_BY_YOU } from '@ai/queue'
import type { AiService } from './ai'
import { AppError } from './errors'

/**
 * The AI GMs for one open league at a time: opens trade windows (after
 * every N rounds, or when you ask), shows the negotiation log and each GM's
 * plan, and lets you approve or turn down deals waiting for you.
 */
export class GmService {
  constructor(
    private readonly ai: AiService,
    /** What GM results need from the rest of the app (set when the context is built). */
    private readonly hooksFor: (slug: string, db: Db, folder: string) => GmHooks,
  ) {}

  private tradesOpen(db: Db): boolean {
    // Never in the playoffs: every player is locked then.
    return playerTradesOpen(loadConfig(db).config, currentSeason(db).phase)
  }

  private jobsFor(db: Db, windowId: number): number {
    return (
      db
        .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind IN (?, ?) AND status IN ('queued', 'running') AND ${jsonField('input', '$.windowId')} = ?`)
        .get(GM_INTENT, GM_RESPOND, windowId) as { n: number }
    ).n
  }

  /**
   * The app catching up after GM work changed facts. Deferred, so it never
   * runs inside the story engine's own reaction (a window can open or close
   * from there) or inside a transaction.
   */
  private changed(slug: string, db: Db, folder: string): void {
    const hooks = this.hooksFor(slug, db, folder)
    setImmediate(() => {
      try {
        hooks.changed()
      } catch (e) {
        console.warn('[gm] catching up failed', e)
      }
    })
  }

  /**
   * Housekeeping: a window left open with nothing more coming (its jobs
   * failed or were cancelled) is closed, and deals waiting for approval from
   * an earlier season expire.
   */
  sweep(slug: string, db: Db, folder: string): void {
    const season = currentSeason(db)
    db.prepare(
      `UPDATE negotiations SET status = 'failed', reason = 'expired', closed_at = ?
       WHERE status = 'agreed' AND window_id IN (SELECT id FROM trade_windows WHERE season_id <> ? OR phase <> ?)`,
    ).run(new Date().toISOString(), season.id, season.phase)
    const w = openWindowRow(db)
    if (!w || this.jobsFor(db, w.id) > 0) return
    const hooks = this.hooksFor(slug, db, folder)
    if (transaction(db, () => maybeClose({ db, folder, hooks }, w.id, null, Date.now()))) this.changed(slug, db, folder)
  }

  status(slug: string, db: Db, folder: string): GmStatusView {
    this.sweep(slug, db, folder)
    const { config } = loadConfig(db)
    const w = openWindowRow(db)
    const season = currentSeason(db)
    const every = config.gm.tradeWindowEveryRounds
    // 2K 일정대로: the session being played isn't over until 오늘 경기 끝 closes it.
    const lastRound = playedSeason(db, season.id, { season, config })
      ? lastClosedSession(db, season.id)
      : ((db.prepare("SELECT MAX(round) AS r FROM games WHERE season_id = ? AND stage = 'regular' AND status = 'final'").get(season.id) as { r: number | null }).r ?? 0)
    const ai = listTeams(db).some((t) => t.control === 'ai')
    const blocked = w ? 'open' : !this.tradesOpen(db) ? 'phase' : !ai ? 'no-ai' : null
    return {
      open: w ? { id: w.id, round: w.round, jobs: this.jobsFor(db, w.id) } : null,
      nextRound: this.tradesOpen(db) ? (Math.floor(lastRound / every) + 1) * every : null,
      canOpen: blocked === null && (this.ai.fake || this.ai.ready()),
      blocked,
      aiReady: this.ai.fake || this.ai.ready(),
      agreed: agreedNegotiations(db).length,
      version:
        (db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM negotiation_steps').get() as { n: number }).n +
        (db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM draft_notes').get() as { n: number }).n,
      draft: this.draftStatus(db),
    }
  }

  private draftJobs(db: Db): number {
    return (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind IN (?, ?) AND status IN ('queued', 'running')").get(GM_PROTECT, GM_SWAP) as { n: number }).n
  }

  private draftStatus(db: Db): GmStatusView['draft'] {
    const { config } = loadConfig(db)
    const season = currentSeason(db)
    if (season.phase !== 'draft' || config.draft.kind !== 'card-swap') return null
    const view = draftView(db)
    const owner = view.next && !view.protectionOpen ? listTeams(db).find((t) => t.id === view.next!.ownerTeamId) : undefined
    const working = this.draftJobs(db)
    const ready = this.ai.fake || this.ai.ready()
    const p = view.protectionOpen ? this.protectState(db, season.id) : null
    return {
      working,
      waitingFor: owner && owner.control !== 'ai' ? owner.id : null,
      protectDone: p !== null && p.missing.size === 0 && p.tries > 0,
      // Nothing running, yet the AI has something to do: the nudge would help.
      stuck: working === 0 && (p ? ready && p.tries < 2 && p.missing.size > 0 : owner?.control === 'ai'),
    }
  }

  /** How the AI's protections stand: attempts made, and AI teams holding cards that haven't decided yet. */
  private protectState(db: Db, seasonId: number): { tries: number; missing: Set<string> } {
    const tries = Number(storyValue(db, `draft-protect:${seasonId}`)) || 0
    const decided = new Set(
      (db.prepare("SELECT DISTINCT team_id FROM draft_notes WHERE season_id = ? AND kind = 'protect'").all(seasonId) as { team_id: string }[]).map((r) => r.team_id),
    )
    return { tries, missing: new Set(this.protectingTeamsOf(db).filter((t) => !decided.has(t))) }
  }

  private protectingTeamsOf(db: Db): string[] {
    const view = draftView(db)
    const ai = new Set(listTeams(db).filter((t) => t.control === 'ai').map((t) => t.id))
    return view.order.filter((t) => ai.has(t) && view.cards.some((c) => c.ownerTeamId === t && c.status === 'held'))
  }

  /** After a GM draft job ends (done, failed or cancelled), the draft keeps moving. */
  onJobChange(slug: string, db: Db, folder: string, jobId: number): void {
    const job = db.prepare('SELECT kind, status FROM jobs WHERE id = ?').get(jobId) as { kind: string; status: string } | undefined
    if (!job || ![GM_PROTECT, GM_SWAP].includes(job.kind) || !['done', 'failed', 'cancelled'].includes(job.status)) return
    setImmediate(() => {
      try {
        this.reconcileDraft(slug, db, folder)
      } catch (e) {
        console.warn('[gm] keeping the draft moving failed', e)
      }
    })
  }

  /** Draft jobs that can no longer do anything (their turn passed, or protection closed) are cancelled before they call Claude. */
  private cancelStaleDraftJobs(db: Db): void {
    const view = draftView(db)
    const now = new Date().toISOString()
    if (!view.protectionOpen) {
      db.prepare("UPDATE jobs SET status = 'cancelled', error = 'protection closed', finished_at = ? WHERE kind = ? AND status = 'queued'").run(now, GM_PROTECT)
    }
    db.prepare(
      `UPDATE jobs SET status = 'cancelled', error = 'turn passed', finished_at = ?
       WHERE kind = ? AND status = 'queued' AND (${jsonField('input', '$.cards[0].cardId')} IS NOT ? OR ${jsonField('input', '$.cards[0].teamId')} IS NOT ?)`,
    ).run(now, GM_SWAP, view.next?.id ?? -1, view.next?.ownerTeamId ?? '')
  }

  /**
   * Keeps the AI GMs moving in the card-swap draft. Run after every change
   * (it's idempotent): when protection opens, the AI teams protect (once per
   * season); once you've closed it, the next AI turns get their picks, until
   * a team you run is up or the cards run out.
   */
  reconcileDraft(slug: string, db: Db, folder: string, nudge = false): void {
    const { config } = loadConfig(db)
    const season = currentSeason(db)
    if (season.phase !== 'draft' || config.draft.kind !== 'card-swap') return
    const usable = this.ai.fake || !this.ai.unavailable()
    // Without Claude, the AI's turns wait, unless you nudge: then code plays them.
    if (!usable && !nudge) return
    if (usable) this.cancelStaleDraftJobs(db)
    if (this.draftJobs(db) > 0) return
    if (draftView(db).protectionOpen) {
      if (!usable) return
      // Teams that haven't decided yet (all at first; after a failed job, those it covered). Twice at most.
      const { tries, missing } = this.protectState(db, season.id)
      if (tries >= 2 || missing.size === 0) return
      const inputs = protectInputs(db, folder, missing)
      setStoryValue(db, `draft-protect:${season.id}`, String(tries + 1))
      const queue = this.ai.queueFor(slug, db, folder)
      for (const input of inputs) queue.enqueue(GM_PROTECT, input, DRAFT_PRIORITY)
      return
    }
    // Recent gm_swap failures: the turns a failed batch covered are played by code, and after three
    // failures in a row code plays the rest, so a broken Claude can neither stall the draft nor keep spending.
    // A batch you cancelled counts as one that failed: its turns aren't asked of Claude again.
    const recent = db
      .prepare(
        `SELECT status, input FROM jobs WHERE kind = ? AND (status IN ('done', 'failed') OR (status = 'cancelled' AND error = ?))
         AND ${jsonField('input', '$.seasonId')} = ? ORDER BY id DESC LIMIT 3`,
      )
      .all(GM_SWAP, CANCELLED_BY_YOU, season.id) as { status: string; input: string }[]
    let streak = 0
    for (const r of recent) {
      if (r.status === 'done') break
      streak++
    }
    const covered = new Set<number>(streak > 0 ? (JSON.parse(recent[0]!.input) as { cards: { cardId: number }[] }).cards.map((c) => c.cardId) : [])
    const coveredWhy = recent[0]?.status === 'cancelled' ? '작업이 취소돼 코드가 대신 골랐다.' : 'AI 응답이 없어 코드가 대신 골랐다.'
    const giveUp = !usable || streak >= 3
    let d: DraftData | null = null
    let played = false
    for (let i = 0; i < 200; i++) {
      const next = draftView(db).next
      if (!next) break
      const owner = listTeams(db).find((t) => t.id === next.ownerTeamId)
      if (owner?.control !== 'ai') break
      // The state is read once and again only after a move; deciding a turn is cheap.
      d ??= readDraft(db, folder)
      const why = giveUp ? (usable ? 'AI 응답이 계속 실패해 코드가 진행했다.' : 'Claude를 쓸 수 없어 코드가 진행했다.') : covered.has(next.id) ? coveredWhy : null
      if (why === null) {
        if (swapOptions(d, next.ownerTeamId, next.id, 1).length > 0) {
          const input = swapInput(db, folder)
          if (input) this.ai.queueFor(slug, db, folder).enqueue(GM_SWAP, input, DRAFT_PRIORITY)
          break
        }
      }
      if (!autoPlay(db, folder, next.id, next.ownerTeamId, why ?? '쓸 만한 지명이 없어 패스.')) break
      played = true
      d = null
    }
    if (played) this.changed(slug, db, folder)
  }

  /** This season's AI draft decisions, in order, with the moves they made. */
  draftNotes(db: Db): DraftNoteView[] {
    const rows = db
      .prepare(
        `SELECT n.id, n.team_id, n.kind, n.note, n.quote, n.created_at, a.player_id, a.target_player_id, a.target_team_id, a.vetoed_at
         FROM draft_notes n LEFT JOIN draft_actions a ON a.id = n.action_id WHERE n.season_id = ? ORDER BY n.id`,
      )
      .all(currentSeason(db).id) as {
      id: number
      team_id: string
      kind: DraftNoteView['kind']
      note: string
      quote: string | null
      created_at: string
      player_id: string | null
      target_player_id: string | null
      target_team_id: string | null
      vetoed_at: string | null
    }[]
    return rows.map((r) => ({
      id: r.id,
      teamId: r.team_id,
      kind: r.kind,
      playerId: r.player_id,
      targetPlayerId: r.target_player_id,
      targetTeamId: r.target_team_id,
      note: r.note,
      quote: r.quote,
      vetoed: r.vetoed_at !== null,
      createdAt: r.created_at,
    }))
  }

  /**
   * Opens a trade window: the most motivated GMs get a turn, a few per call.
   * When nobody has anything worth offering, no window opens at all.
   */
  openWindow(slug: string, db: Db, folder: string, reason: 'manual' | 'scheduled', round: number | null): { windowId: number | null; gms: number } {
    if (!this.ai.fake && this.ai.unavailable()) throw new AppError('ai-unavailable', 'Claude Code is not ready')
    this.sweep(slug, db, folder)
    if (openWindowRow(db)) throw new AppError('rule', 'a trade window is already open', { rules: [{ code: 'window-open', params: {} }] })
    if (!this.tradesOpen(db)) throw new AppError('rule', 'trades are closed now', { rules: [{ code: 'wrong-phase', params: { phase: currentSeason(db).phase } }] })
    const league = readLeague(db, folder)
    const { config } = loadConfig(db)
    const season = currentSeason(db)
    const data = readMarket(league)
    const picks = motivatedGms(data, config.gm.gmsPerWindow, `${season.seed}:${round ?? 'manual'}:${lastEventId(db)}`, new Set())
    if (picks.length === 0) return { windowId: null, gms: 0 }
    // Everything is built before the window exists, so a failure leaves nothing half-open.
    const { windowId, inputs } = transaction(db, () => {
      const id = insertWindow(db, season.id, season.phase, round, reason, Date.now())
      appendEvent(db, 'trade_window_opened', { windowId: id, round }, season.id)
      const list = []
      for (let i = 0; i < picks.length; i += GMS_PER_CALL) list.push(intentInput(league, data, id, round, picks.slice(i, i + GMS_PER_CALL)))
      return { windowId: id, inputs: list }
    })
    const queue = this.ai.queueFor(slug, db, folder)
    for (const input of inputs) queue.enqueue(GM_INTENT, input, GM_PRIORITY)
    return { windowId, gms: picks.length }
  }

  /** After a completed regular-season round: a scheduled window every N rounds. Returns whether one opened. */
  onRound(slug: string, db: Db, folder: string, seasonId: number, round: number): boolean {
    const { config } = loadConfig(db)
    if (round % config.gm.tradeWindowEveryRounds !== 0 || windowAfterRound(db, seasonId, round)) return false
    // A window stuck open (its jobs failed) mustn't swallow this round's.
    this.sweep(slug, db, folder)
    if (openWindowRow(db) || !this.tradesOpen(db) || (!this.ai.fake && this.ai.unavailable())) return false
    if (!listTeams(db).some((t) => t.control === 'ai')) return false
    return this.openWindow(slug, db, folder, 'scheduled', round).gms > 0
  }

  /** You approve a deal both GMs agreed to: it's made now (if the rules still allow it). */
  approve(slug: string, db: Db, folder: string, negotiationId: number): { status: 'accepted' | 'failed' } {
    this.sweep(slug, db, folder)
    const n = getNegotiation(db, negotiationId)
    if (!n || n.status !== 'agreed') throw new AppError('not-found', `no deal waiting: ${negotiationId}`)
    const result = transaction(db, () => settleDeal(db, folder, n, Date.now(), true))
    if (result === 'accepted') this.changed(slug, db, folder)
    return { status: result === 'accepted' ? 'accepted' : 'failed' }
  }

  decline(db: Db, negotiationId: number): void {
    const n = getNegotiation(db, negotiationId)
    if (!n || n.status !== 'agreed') throw new AppError('not-found', `no deal waiting: ${negotiationId}`)
    updateNegotiation(db, n.id, { status: 'declined', closedAt: new Date().toISOString() })
  }

  /** This season's windows, newest first, with every negotiation and step. An open window is hidden when the log is set to wait. */
  windows(db: Db): WindowView[] {
    const { config } = loadConfig(db)
    const season = currentSeason(db)
    const tradeState = db.prepare('SELECT status FROM trades WHERE id = ?')
    const pending = db.prepare("SELECT applied_at FROM checklist WHERE kind = 'trade' AND ref_id = ? AND cancelled_at IS NULL")
    return listWindows(db, season.id).map((w): WindowView => {
      const hidden = w.status === 'open' && config.gm.negotiationLog === 'after-window'
      return {
        id: w.id,
        seasonId: w.seasonId,
        round: w.round,
        status: w.status,
        reason: w.reason,
        openedAt: w.openedAt,
        closedAt: w.closedAt,
        hidden,
        negotiations: hidden
          ? []
          : listNegotiations(db, w.id).map((n): NegotiationView => {
              const trade = n.tradeId ? (tradeState.get(n.tradeId) as { status: string } | undefined) : undefined
              const check = n.tradeId ? (pending.get(n.tradeId) as { applied_at: string | null } | undefined) : undefined
              return {
                id: n.id,
                windowId: n.windowId,
                fromTeam: n.fromTeam,
                toTeam: n.toTeam,
                status: n.status,
                deal: n.deal,
                tradeId: n.tradeId,
                valueGap: n.valueGap,
                lopsided: n.lopsided,
                vetoable: trade?.status === 'applied' && check !== undefined && check.applied_at === null,
                vetoed: trade?.status === 'vetoed',
                reason: n.reason,
                steps: listSteps(db, n.id).map((s) => ({
                  id: s.id,
                  round: s.round,
                  teamId: s.teamId,
                  action: s.action,
                  deal: s.deal,
                  message: s.message,
                  note: s.note,
                  report: s.report,
                  trust: s.trust,
                  createdAt: s.createdAt,
                })),
                createdAt: n.createdAt,
                closedAt: n.closedAt,
              }
            }),
      }
    })
  }

  /** Every team's GM: persona from its lore file, its plan and its trust in the others. */
  gms(db: Db, folder: string): GmView[] {
    const league = readLeague(db, folder)
    return listTeams(db).map((t): GmView => {
      const e = league.lore.gm.get(t.id)
      const lore = e?.kind === 'gm' ? e.settings : null
      const mem = memoryOf(db, t.id)
      return {
        teamId: t.id,
        name: lore?.name ?? null,
        philosophy: lore?.philosophy ?? 'balanced',
        negotiation: lore?.negotiation ?? 'fair',
        traits: Object.fromEntries(GM_TRAITS.map((k) => [k, lore?.traits[k] ?? 3])),
        plan: mem.plan ? { stance: mem.plan.stance, targets: mem.plan.targets, available: mem.plan.available, untouchables: mem.plan.untouchables, note: mem.plan.note, quote: mem.plan.quote } : null,
        trust: Object.entries(mem.trust)
          .filter(([, v]) => v !== 0)
          .map(([teamId, value]) => ({ teamId, value }))
          .sort((a, b) => Math.abs(b.value) - Math.abs(a.value)),
        active: t.control === 'ai',
      }
    })
  }
}
