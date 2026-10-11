import type { LoreEditable } from '@lore/edit'
import { applyPatch, currentOf, fitReveal, fitToFile, revealEdit, sanitizePatch, type DraftPart, type PatchKind } from '@lore/patch'
import type { LoreEditableView, LoreRelationship } from '@shared/lore'
import type { LoreConfig } from '@shared/config/schema'
import type { EventPayloads } from '@shared/events'
import {
  ALWAYS_ASK,
  type ApproveResult,
  type DraftRequest,
  type DraftResult,
  type LorePatch,
  type SuggestionKind,
  type SuggestionMode,
  type SuggestionStatusView,
  type SuggestionView,
} from '@shared/suggestions'
import { lastEventId, setStoryValue } from '@data/community'
import { transaction, type Db } from '@data/db'
import { appendEvent, currentSeason, listPlayers, loadConfig, updateConfig } from '@data/league'
import { updatePlayers } from '@data/roster'
import { refuse, RuleError } from '@data/rules'
import {
  addSuggestion,
  decideSuggestion,
  getSuggestion,
  listSuggestions,
  pendingCount,
  setSuggestionError,
  targetKey,
  type SuggestionRow,
} from '@data/suggestions'
import { readLeague, short, type League } from '@story/context'
import { leagueFeelings } from '@story/feelings'
import { relationTarget } from '@story/mood'
import { LORE_REVEAL, LORE_REVEAL_PRIORITY, REVEAL_MARK, revealInput } from '@story/reveals'
import {
  blankPicks,
  draftInput,
  LORE_DRAFT,
  LORE_DRAFT_PRIORITY,
  LORE_SUGGEST,
  LORE_SUGGEST_PRIORITY,
  loreEditableOf,
  loreEntryOf,
  refOf,
  suggestInput,
  SWEEP_MARK,
  type LoreDraftInput,
} from '@story/loreJobs'
import type { AiService } from './ai'
import { AppError } from './errors'
import type { LoreService } from './lore'

const jobsWaiting = (db: Db, kind: string) =>
  (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = ? AND status IN ('queued', 'running')").get(kind) as { n: number }).n

/**
 * What an approved reveal tells the community: who, where it went, and the
 * text now public, or the tie as the file has it now (never the secret's
 * other text, nor what you kept in 비밀).
 */
function revealedPayload(league: League, s: SuggestionRow, patch: LorePatch, tie: LoreRelationship | undefined): EventPayloads['secret_revealed'] {
  const playerId = s.target.kind === 'player' ? s.target.playerId : null
  return {
    suggestionId: s.id,
    target: s.target.kind,
    playerId,
    teamId: s.target.kind === 'player' ? (league.players.get(s.target.playerId)?.teamId ?? '') : s.target.teamId,
    to: patch.public !== undefined || tie?.visibility === 'public' ? 'public' : 'rumor',
    text: tie ? '' : (patch.public ?? patch.rumor ?? ''),
    relationship: tie ? { with: tie.with, type: tie.type, playerId: relationTarget(league, tie.with) } : null,
  }
}

/**
 * The suggestion inbox (제안함): queues the lore jobs, and turns an approved
 * card into a change to the lore file (through the editor's merge, with a
 * backup) or the roster. Nothing the AI drafts is lore until it's approved
 * here, so writers never see it before you do.
 */
/** A grudge against a player becomes a relationship card once it has lasted this many games and is still this sore. */
const GRUDGE_CARD_GAMES = 20
const GRUDGE_CARD_VALUE = -8

export class SuggestionService {
  constructor(
    private readonly ai: AiService,
    private readonly lore: LoreService,
  ) {}

  status(db: Db): SuggestionStatusView {
    return {
      pending: pendingCount(db),
      drafting: jobsWaiting(db, LORE_DRAFT),
      sweeping: jobsWaiting(db, LORE_SUGGEST) + jobsWaiting(db, LORE_REVEAL),
      aiReady: this.ai.fake || this.ai.ready(),
    }
  }

  list(db: Db, folder: string, which: 'pending' | 'decided'): SuggestionView[] {
    const league = readLeague(db, folder)
    const nicknames = new Map(listPlayers(db).map((p) => [p.id, p.nicknames]))
    return listSuggestions(db, which).map((s): SuggestionView => {
      const entry = loreEntryOf(league, s.target)
      const teamId = s.target.kind === 'player' ? (league.players.get(s.target.playerId)?.teamId ?? '') : s.target.teamId
      const name =
        s.target.kind === 'player'
          ? (league.players.get(s.target.playerId)?.name ?? s.target.playerId)
          : s.target.kind === 'team'
            ? short(league, s.target.teamId)
            : `${short(league, s.target.teamId)} 단장`
      return {
        id: s.id,
        kind: s.kind,
        status: s.status,
        target: s.target,
        name,
        teamId,
        file: entry?.file ?? s.file,
        patch: s.patch,
        // 비밀 only for a reveal still waiting (its preview of what stays), never for the decided ones.
        current: currentOf(s.target.kind, loreEditableOf(entry), s.patch, s.target.kind === 'player' ? (nicknames.get(s.target.playerId) ?? []) : [], s.status === 'pending'),
        reason: s.reason,
        times: s.times,
        seasonId: s.seasonId,
        round: s.round,
        source: s.source,
        auto: s.auto,
        error: s.error,
        createdAt: s.createdAt,
        decidedAt: s.decidedAt,
      }
    })
  }

  private usable(): void {
    if (!this.ai.fake && this.ai.unavailable()) throw new AppError('ai-unavailable', 'Claude Code is not ready')
  }

  /**
   * Queues drafts: every blank part of one school's files (or every school's),
   * one job per school, skipping files that already have a draft waiting or
   * don't read; or one file, with your own description of the player.
   */
  draft(slug: string, db: Db, folder: string, req: DraftRequest): DraftResult {
    this.usable()
    const league = readLeague(db, folder)
    const queue = this.ai.queueFor(slug, db, folder)
    if (req.scope === 'one') {
      const t = req.target
      const teamId = t.kind === 'player' ? league.players.get(t.playerId)?.teamId : league.teams.has(t.teamId) ? t.teamId : undefined
      if (!teamId) throw new AppError('not-found', 'no such player or school')
      const input = draftInput(league, teamId, [{ target: t, parts: null }], req.hint?.trim().slice(0, 2000) || null)
      if (!input) return { jobs: 0, targets: 0 }
      queue.enqueue(LORE_DRAFT, input, LORE_DRAFT_PRIORITY)
      return { jobs: 1, targets: 1 }
    }
    if (req.scope === 'team' && !league.teams.has(req.teamId)) throw new AppError('not-found', `no team ${req.teamId}`)
    // Skipped: drafts already waiting, anyone in a draft job not finished yet, and files that
    // don't read (they're fixed in the editor, not drafted over).
    const skip = new Set(listSuggestions(db, 'pending', -1).filter((s) => s.kind === 'draft').map((s) => targetKey(s.target)))
    for (const j of db.prepare("SELECT input FROM jobs WHERE kind = ? AND status IN ('queued', 'running')").all(LORE_DRAFT) as { input: string }[]) {
      for (const t of (JSON.parse(j.input) as LoreDraftInput).targets ?? []) skip.add(targetKey(t.target))
    }
    for (const row of this.lore.table(db, folder).rows) {
      if (row.broken) skip.add(row.kind === 'player' ? `player:${row.playerId}` : `${row.kind}:${row.teamId}`)
    }
    const teams = req.scope === 'team' ? [req.teamId] : [...league.teams.keys()]
    let jobs = 0
    let targets = 0
    for (const teamId of teams) {
      const picks = blankPicks(league, teamId, skip)
      const input = draftInput(league, teamId, picks, null)
      if (!input) continue
      queue.enqueue(LORE_DRAFT, input, LORE_DRAFT_PRIORITY)
      jobs++
      targets += picks.length
    }
    return { jobs, targets }
  }

  /** The sweep after a completed round (called by the story engine). False when it's off or Claude isn't usable. */
  sweep(slug: string, db: Db, folder: string, seasonId: number, round: number): boolean {
    if (!loadConfig(db).config.lore.roundSweep || (!this.ai.fake && this.ai.unavailable())) return false
    const input = suggestInput(readLeague(db, folder), seasonId, round)
    // The next sweep's news starts after this one's, whether or not this one had anything.
    setStoryValue(db, SWEEP_MARK, String(lastEventId(db)))
    if (!input) return false
    this.ai.queueFor(slug, db, folder).enqueue(LORE_SUGGEST, input, LORE_SUGGEST_PRIORITY)
    return true
  }

  /**
   * The secret check after a completed round (called with the sweep): one
   * sealed lore_reveal job, only when someone with a secret was in the
   * round's public happenings. Off with the round sweep, or when reveals are
   * set to off; then the mark still moves, so turning it back on doesn't
   * look over an old backlog. True when a job was queued.
   */
  revealSweep(slug: string, db: Db, folder: string, seasonId: number, round: number): boolean {
    const { lore } = loadConfig(db).config
    if (!lore.roundSweep || (lore.suggest.reveal ?? 'ask') === 'off') {
      setStoryValue(db, REVEAL_MARK, String(lastEventId(db)))
      return false
    }
    // Claude not usable yet: the mark stays, so the next check still looks at this round's happenings.
    if (!this.ai.fake && this.ai.unavailable()) return false
    const input = revealInput(readLeague(db, folder), seasonId, round)
    setStoryValue(db, REVEAL_MARK, String(lastEventId(db)))
    if (!input) return false
    this.ai.queueFor(slug, db, folder).enqueue(LORE_REVEAL, input, LORE_REVEAL_PRIORITY)
    return true
  }

  /**
   * Grudges that won't fade become relationship cards: a player still sore
   * at another player GRUDGE_CARD_GAMES of his school's games after a public
   * jab is asked to "dislike" him (as a rumor). Code only, no AI; the card
   * waits for you like any other (or applies itself, if relationships are
   * set to). A relationship already in his file, of any kind, is never
   * suggested over. Returns how many cards were added.
   */
  grudgeCards(db: Db, folder: string, seasonId: number, round: number): number {
    const mode = loadConfig(db).config.lore.suggest.relationship ?? 'ask'
    if (mode === 'off') return 0
    const league = readLeague(db, folder)
    let added = 0
    for (const [playerId, f] of leagueFeelings(league)) {
      for (const g of f.grudges) {
        if (g.target.kind !== 'player' || g.games < GRUDGE_CARD_GAMES || g.value > GRUDGE_CARD_VALUE) continue
        const who = refOf(league, g.target.id)
        const entry = league.lore.player.get(playerId)
        const have = entry?.kind === 'player' && entry.settings.relationships.some((r) => relationTarget(league, r.with) === g.target.id || r.with.normalize('NFC') === who.normalize('NFC'))
        if (have) continue
        const target = { kind: 'player' as const, playerId }
        const r = addSuggestion(
          db,
          {
            kind: 'relationship',
            target,
            patch: { relationships: [{ with: who, type: 'dislikes', strength: 3, visibility: 'rumor' }] },
            reason: `앙금: ${league.players.get(g.target.id)?.name ?? who}에게 공개 저격당한 뒤 ${g.games}경기가 지나도 풀리지 않았어요 (지금 ${g.value})`,
            dedupe: `relationship:${targetKey(target)}:${who.normalize('NFC')}:dislikes`,
            seasonId,
            round,
            jobId: null,
          },
          Date.now(),
        )
        if (r && !r.merged) added++
      }
    }
    if (added) this.applyAuto(db, folder)
    return added
  }

  /**
   * Applies a card (as it is, or as you edited it) and marks it approved. The
   * lore file is re-read first and changed through the editor's merge, so
   * your own edits stay; its old version is kept as a backup. A file that
   * doesn't exist yet is made from the template.
   */
  approve(db: Db, folder: string, id: number, edited?: unknown, auto = false, partial = false): ApproveResult {
    const s = getSuggestion(db, id)
    if (!s || s.status !== 'pending') return { status: 'error', code: 'gone', detail: '' }
    if (s.kind === 'reveal') {
      // A secret is only ever revealed by you, one card at a time: never by a setting or a batch.
      if (auto || partial) return { status: 'error', code: 'invalid', detail: 'reveals are approved one at a time' }
      return this.approveReveal(db, folder, s, edited)
    }
    const patch = edited === undefined ? s.patch : sanitizePatch(s.target.kind, edited)
    if (!patch) return this.fail(db, s, 'invalid', 'nothing to apply')
    const { nicknames, ...lorePart } = patch

    // The roster first: adding a nickname twice is harmless, so a retry after a later failure is safe.
    if (nicknames?.length) {
      if (s.target.kind !== 'player') return this.fail(db, s, 'invalid', 'nicknames are for players')
      const playerId = s.target.playerId
      const p = listPlayers(db).find((x) => x.id === playerId)
      if (!p) return this.fail(db, s, 'gone', 'no such player')
      const add = nicknames.filter((n) => !p.nicknames.some((x) => x.normalize('NFC') === n.normalize('NFC')))
      if (add.length) {
        try {
          transaction(db, () => updatePlayers(db, [{ playerId, nicknames: [...p.nicknames, ...add] }]))
        } catch (e) {
          if (e instanceof RuleError) return this.fail(db, s, 'roster', e.issues.map((i) => i.code).join(','))
          throw e
        }
      }
    }

    let file: string | null = null
    let applied: LorePatch = patch
    if (Object.keys(lorePart).length > 0) {
      const r = this.writeLore(db, folder, s, lorePart, edited === undefined, partial)
      if ('code' in r) return this.fail(db, s, r.code, r.detail, r.reason)
      file = r.file
      applied = { ...r.applied, ...(nicknames ? { nicknames } : {}) }
    }
    decideSuggestion(db, s.id, 'approved', Date.now(), { patch: applied, file, auto })
    return { status: 'approved', file }
  }

  /**
   * Writes the lore part of a card. `asIs`: the card wasn't edited, so it must
   * still fit the file as it is now (`fitToFile`); `partial` (a batch) leaves
   * out what doesn't, instead of refusing the card.
   */
  private writeLore(
    db: Db,
    folder: string,
    s: SuggestionRow,
    patch: LorePatch,
    asIs: boolean,
    partial: boolean,
  ): { file: string; applied: LorePatch } | { code: 'gone' | 'conflict' | 'lore-error' | 'no-file' | 'stale'; detail: string; reason?: string } {
    const kind: PatchKind = s.target.kind
    let file: string
    try {
      file = this.lore.create(db, folder, s.target).file
    } catch (e) {
      return { code: 'no-file', detail: e instanceof Error ? e.message : String(e) }
    }
    const opened = this.openForm(folder, file, kind)
    if ('code' in opened) return opened
    const base = opened.base
    let fitted: LorePatch = patch
    if (asIs) {
      const fit = fitToFile(kind, base as unknown as LoreEditable, patch, {
        ...(s.source.parts ? { parts: s.source.parts as DraftPart[] } : {}),
        ...(s.source.from !== undefined ? { from: s.source.from } : {}),
        partial,
      })
      if ('stale' in fit) return { code: 'stale', detail: fit.stale }
      fitted = fit.patch
    }
    // Text already in the section (a retry after a failure) isn't added twice.
    const fresh: LorePatch = { ...fitted }
    if (fresh.public && base.sections.public.includes(fresh.public)) delete fresh.public
    if (fresh.rumor && base.sections.rumor.includes(fresh.rumor)) delete fresh.rumor
    const saved = this.saveForm(folder, file, base, applyPatch(base as unknown as LoreEditable, fresh))
    return 'code' in saved ? saved : { file, applied: fitted }
  }

  /** A lore file's form data, read fresh. A locked or unreadable file is recorded on the card like any other failure (with why, when the screen has words for it). */
  private openForm(folder: string, file: string, kind: PatchKind): { base: LoreEditableView } | { code: 'lore-error'; detail: string; reason?: string } {
    let doc: ReturnType<LoreService['open']>
    try {
      doc = this.lore.open(folder, file)
    } catch (e) {
      return { code: 'lore-error', detail: e instanceof Error ? e.message : String(e) }
    }
    if (!doc.utf8) return { code: 'lore-error', detail: 'not-utf8', reason: 'not-utf8' }
    if (!doc.editable || doc.editable.kind !== kind) return { code: 'lore-error', detail: 'unreadable', reason: 'unreadable' }
    return { base: doc.editable }
  }

  /**
   * Writes form data through the lore editor's merge (your own edits stay; the
   * old version is kept as a backup). The editor's own refusal (a heading-like
   * line in the text, comments in the section…) is the failure's reason.
   */
  private saveForm(
    folder: string,
    file: string,
    base: LoreEditableView,
    next: LoreEditable,
  ): { ok: true } | { code: 'gone' | 'conflict' | 'lore-error'; detail: string; reason?: string } {
    let r: ReturnType<LoreService['save']>
    try {
      r = this.lore.save(folder, { mode: 'form', file, base, next: { kind: base.kind, ...next } as unknown as LoreEditableView })
    } catch (e) {
      return { code: 'lore-error', detail: e instanceof Error ? e.message : String(e) }
    }
    switch (r.status) {
      case 'saved':
      case 'unchanged':
        return { ok: true }
      case 'gone':
        return { code: 'gone', detail: file }
      case 'conflict':
        return { code: 'conflict', detail: r.fields.join(',') }
      case 'error':
        return { code: 'lore-error', detail: r.code, reason: r.code }
      default:
        return { code: 'lore-error', detail: r.status }
    }
  }

  /**
   * Approves a secret reveal (as it is, or with your wording, where it goes
   * and what you keep in 비밀): the text leaves 비밀 for the end of 공개 or
   * 소문, or a secret relationship becomes known, through the same merge and
   * backup as any card. Then, with the card marked approved, a
   * `secret_revealed` event carries what is now public (and only that) to
   * the community. A secret that's no longer in the file leaves the card
   * waiting as stale, with why (`stale:<why>`).
   */
  private approveReveal(db: Db, folder: string, s: SuggestionRow, edited: unknown): ApproveResult {
    const patch = edited === undefined ? s.patch : revealEdit(s.patch, edited)
    // Which box is too long has its own reason, so the card can say which to shorten.
    if (patch === 'too-long' || patch === 'keep-too-long') return this.fail(db, s, 'invalid', 'longer than the secret', patch)
    if (!patch) return this.fail(db, s, 'invalid', 'nothing to apply')
    const league = readLeague(db, folder)
    // The secret was in a file when the card was made: no file now means it's gone, never a fresh template.
    const file = loreEntryOf(league, s.target)?.file
    if (!file) return this.fail(db, s, 'stale', 'no lore file', 'no-file')
    const opened = this.openForm(folder, file, s.target.kind)
    if ('code' in opened) return this.fail(db, s, opened.code, opened.detail, opened.reason)
    const fit = fitReveal(opened.base as unknown as LoreEditable, patch)
    if ('stale' in fit) return this.fail(db, s, 'stale', fit.stale, fit.stale)
    const saved = this.saveForm(folder, file, opened.base, fit.next)
    if ('code' in saved) return this.fail(db, s, saved.code, saved.detail, saved.reason)
    // A tie is recorded as the file has it now.
    const applied: LorePatch = fit.tie ? { relationships: [fit.tie] } : patch
    transaction(db, () => {
      decideSuggestion(db, s.id, 'approved', Date.now(), { patch: applied, file, auto: false })
      appendEvent(db, 'secret_revealed', revealedPayload(league, s, applied, fit.tie), currentSeason(db).id)
    })
    return { status: 'approved', file }
  }

  /** Records why approving failed on the card (`code`, or `code:reason` when there's a reason the screen has its own words for). */
  private fail(db: Db, s: SuggestionRow, code: Exclude<ApproveResult, { status: 'approved' }>['code'], detail: string, reason?: string): ApproveResult {
    setSuggestionError(db, s.id, reason ? `${code}:${reason}` : code)
    return { status: 'error', code, detail }
  }

  reject(db: Db, id: number): void {
    if (!decideSuggestion(db, id, 'rejected', Date.now())) throw new AppError('not-found', `no waiting suggestion ${id}`)
  }

  /** Approves several cards as they are; returns how many went through. */
  approveMany(db: Db, folder: string, ids: number[]): { approved: number; failed: number } {
    let approved = 0
    let failed = 0
    for (const id of ids) {
      if (this.tryApprove(db, folder, id, false)) approved++
      else failed++
    }
    return { approved, failed }
  }

  /** "Always approve this kind" (or ask, or off); switching to auto approves the waiting ones of that kind too. Reveals always ask. */
  setMode(db: Db, folder: string, kind: SuggestionKind, mode: SuggestionMode): { applied: number } {
    if (mode === 'auto' && ALWAYS_ASK.includes(kind)) refuse('reveal-always-asks', { kind })
    const { config } = loadConfig(db)
    updateConfig(db, { ...config, lore: { ...config.lore, suggest: { ...config.lore.suggest, [kind]: mode } } })
    return { applied: mode === 'auto' ? this.applyAuto(db, folder) : 0 }
  }

  saveSettings(db: Db, folder: string, lore: LoreConfig): { version: number; applied: number } {
    const always = ALWAYS_ASK.find((k) => lore.suggest[k] === 'auto')
    if (always) refuse('reveal-always-asks', { kind: always })
    const { config } = loadConfig(db)
    const version = updateConfig(db, { ...config, lore })
    return { version, applied: this.applyAuto(db, folder) }
  }

  /** Approves every waiting card whose kind is set to approve itself (never one that always asks). */
  applyAuto(db: Db, folder: string): number {
    const modes = loadConfig(db).config.lore.suggest
    let applied = 0
    // Oldest first, so cards are applied in the order they were suggested.
    for (const s of listSuggestions(db, 'pending', -1).reverse()) {
      if (s.kind === 'draft' || ALWAYS_ASK.includes(s.kind) || modes[s.kind] !== 'auto' || s.error) continue
      if (this.tryApprove(db, folder, s.id, true)) applied++
    }
    return applied
  }

  /** One approval in a batch: anything unexpected is recorded on that card, and the batch goes on. */
  private tryApprove(db: Db, folder: string, id: number, auto: boolean): boolean {
    try {
      return this.approve(db, folder, id, undefined, auto, true).status === 'approved'
    } catch (e) {
      console.warn(`[lore] approving suggestion ${id} failed`, e)
      try {
        setSuggestionError(db, id, 'lore-error')
      } catch {
        // The database itself is gone (the league closed): nothing to record.
      }
      return false
    }
  }
}
