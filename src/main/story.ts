import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { BoardPage, CommunityStatus, PollView, PostSummary, PostView, RefreshResult, WriteCommentInput, WritePostInput } from '@shared/community'
import {
  boardPage,
  bufferSize,
  lastEventId,
  latestPosts,
  openPost,
  personaCount,
  refreshFeed,
  setMyNick,
  setStoryValue,
  storyValue,
  vote,
  writeUserComment,
  writeUserPost,
} from '@data/community'
import { jsonField, transaction, type Db } from '@data/db'
import { closeDuePolls, closeRoundPolls, votePoll } from '@data/polls'
import { appendEvent, currentSeason, listEventsAfter, listPlayers, listTeams, loadConfig, updateConfig } from '@data/league'
import { cancelQueuedForGame } from '@data/jobs'
import type { CommunityConfig, LeagueConfig } from '@shared/config/schema'
import { seedWiki, syncSchoolCategories, upgradeWiki } from '@story/wiki'
import { refuse } from '@data/rules'
import {
  chatterInput,
  describeEvent,
  LIVE_DRAFT_START,
  liveCommentsInput,
  ensureCast,
  eventThreadInput,
  gameThreadInput,
  mentions,
  readLeague,
  replyInput,
  roundUpInput,
  type League,
} from '@story/context'
import { roundTop, roundWikiInput, WIKI_EDITS, WIKI_PRIORITY, wikiEditInput, type ContestedEdit, type WikiEditInput } from '@story/wikiEdits'
import { batches, planPlayerPages, playerPagesInput, WIKI_PLAYER, WIKI_PLAYER_PRIORITY } from '@story/wikiPlayer'
import type { PlayerPagesPlan, PlayerPagesStatus } from '@shared/wiki'
import {
  anyTakenBack,
  keepTakenBack,
  OCCASION_KINDS,
  occasionInput,
  occasionOf,
  onlyLost,
  planOccasion,
  takenBack,
  writtenItem,
  type OccasionKind,
  type WikiOccasion,
} from '@story/wikiOccasions'
import { pushbackInput, pushbackTarget, TALK_PRIORITY, talkInput, talkRetry, WAR_PRIORITY, warInput, WIKI_PUSHBACK, WIKI_TALK, WIKI_WAR, type WarCall, type WikiTalkInput } from '@story/wikiTalk'
import { tickDisputes } from '@data/talk'
import { lockerRoom, snapshotMoods } from '@story/mood'
import { leagueFeelings } from '@story/feelings'
import type { LockerRoomView, PlayerStateView } from '@shared/mood'
import { playerState } from '@story/playerState'
import { getGame } from '@data/season'
import { roundComplete } from '@data/schedule'
import { announceStandingsMoments } from '@data/moments'
import type { EventPayloads, LeagueEvent } from '@shared/events'
import { STORY_KINDS, STORY_PRIORITY, type StoryInput, type StoryKind } from '@story/jobs'
import { planReactions } from '@story/triggers'
import {
  mergeReactionPicks,
  PLAYER_REACTION,
  REACTION_PRIORITY,
  REACTION_TRIGGERS,
  reactionEvents,
  reactionInput,
  reactionPicks,
  type PlayerReactionInput,
  type ReactionPick,
} from '@story/reactions'
import { LORE_REVEAL } from '@story/reveals'
import { planPolls } from '@story/polls'
import type { AiService } from './ai'
import { AppError } from './errors'

const CURSOR = 'events-handled'
/** A rebuilt input for a waiting job that was the number check's retry keeps that mark (its note, and the job it redoes). */
const keepRetry = <T extends object>(input: T, old: { numberRetry?: string[]; retryOf?: number }): T =>
  old.numberRetry ? { ...input, numberRetry: old.numberRetry, ...(old.retryOf ? { retryOf: old.retryOf } : {}) } : input
/** Events that go to the draft's live thread. */
const DRAFT_EVENTS: string[] = ['draft_protect', 'draft_swap', 'draft_pass']
/** Events that change a player's school. */
const MOVES: string[] = ['trade_applied', 'draft_swap', 'move_vetoed']
/** Notes each persona keeps (past takes, grudges, predictions). */
const MEMORY_PER_PERSONA = 8

/**
 * The community for one open league at a time: reacts to new league events
 * with threads, refills chatter on refresh, and answers your posts. Facts
 * never change here; this only writes posts and comments.
 */
export interface StoryHooks {
  /** A regular-season round was completed: the lore sweep looks it over. Returns whether a job was queued. */
  onRound?: (slug: string, db: Db, folder: string, seasonId: number, round: number) => boolean
  /** After every look at new events (whether or not the community is on): the AI draft keeps moving. */
  afterEvents?: (slug: string, db: Db, folder: string) => void
}

export class StoryService {
  constructor(
    private readonly ai: AiService,
    private readonly hooks: StoryHooks = {},
  ) {}

  private league(db: Db, folder: string): League {
    const league = readLeague(db, folder)
    ensureCast(league)
    return league
  }

  /** Makes the cast if the community has none yet (reads lore only then). */
  private ensure(db: Db, folder: string): void {
    if (personaCount(db) === 0) this.league(db, folder)
  }

  /** A game's thread is being written right now. */
  private threadWriting(db: Db, gameId: number): boolean {
    return Boolean(
      db.prepare(`SELECT 1 FROM jobs WHERE kind = 'post_game_thread' AND status = 'running' AND ${jsonField('input', '$.gameId')} = ? LIMIT 1`).get(gameId),
    )
  }

  /**
   * Queues a story job, or skips it once a check has found Claude Code
   * unusable: a backlog must not pile up. (Jobs that wait too long anyway are
   * cancelled before they run; see stillWanted in story/jobs.ts.)
   */
  private enqueue(slug: string, db: Db, folder: string, kind: StoryKind, input: StoryInput): number | null {
    if (!this.ai.fake && this.ai.unavailable()) return null
    // Demo mode plays the trickle of comments 30 times faster.
    const job = this.ai.fake ? { ...input, spreadMs: Math.round(input.spreadMs / 30) } : input
    return this.ai.queueFor(slug, db, folder).enqueue(kind, job, STORY_PRIORITY[kind])
  }

  /** Queues reactions to events since the last look (the mark starts where migration 4 left it). */
  afterChange(slug: string, db: Db, folder: string): number {
    try {
      return this.react(slug, db, folder)
    } finally {
      try {
        this.hooks.afterEvents?.(slug, db, folder)
      } catch (e) {
        console.warn('[story] the after-events hook failed', e)
      }
    }
  }

  private react(slug: string, db: Db, folder: string): number {
    const { config } = loadConfig(db)
    const last = lastEventId(db)
    const mark = storyValue(db, CURSOR)
    // Before anything reads the wiki: moved players' pages are refiled under their new schools, AI or not.
    if (mark !== null && Number(mark) < last) this.refile(db, config, listEventsAfter(db, Number(mark)))
    if (mark === null || !config.community.enabled) {
      // With the community off, finished rounds still get the lore sweep, and standings moments are still
      // recorded (unposted), so turning it back on doesn't post a backlog of stale clinches.
      let queued = 0
      if (mark !== null && Number(mark) < last) this.announceMoments(db, listEventsAfter(db, Number(mark)))
      if (mark !== null && Number(mark) < last) {
        for (const { seasonId, round } of this.completedRounds(db, listEventsAfter(db, Number(mark)), true)) {
          this.roundPassed(db, seasonId, round)
          try {
            if (this.hooks.onRound?.(slug, db, folder, seasonId, round)) queued++
          } catch (e) {
            console.warn('[story] could not queue the lore sweep', e)
          }
        }
        // Wiki jobs queued before still run: an award removed, a swap vetoed or a series result changed must leave them.
        this.takeBack(slug, db, folder, listEventsAfter(db, Number(mark)))
      }
      // Past the moments just recorded too: nobody is to post them later.
      setStoryValue(db, CURSOR, String(Math.max(last, lastEventId(db))))
      return queued
    }
    const since = Number(mark)
    if (last <= since) return 0
    // Results change the table: places clinched, eliminations, a new #1 and long streaks become events to react to.
    this.announceMoments(db, listEventsAfter(db, since))
    // Moods move after games and moves; a player crossing a band adds a mood_changed event to react to.
    this.snapshotMoods(db, folder, listEventsAfter(db, since))
    const events = listEventsAfter(db, since)
    const reactions = planReactions(events)
    const rounds = this.completedRounds(db, events, false)
    // The mark moves to the newest event processed here (mood changes included). Events that
    // reactions append meanwhile (a trade window closing, say) are the next look's news.
    const handled = String(Math.max(last, events.at(-1)?.id ?? last))
    // Players' words can come from a look with nothing else to write about (the draft closing).
    const voices = reactionEvents(db, events)
    // Awards, draft swaps and series results go to the wiki; an award removed, a swap vetoed or a result changed changes a job waiting for them.
    const occasions = events.filter((e) => occasionOf(e) !== null)
    const writable = this.ai.fake || !this.ai.unavailable()
    // Words putting right what was written wait for a look that may queue them (the community was off, Claude Code unusable).
    const held = writable && anyTakenBack(db, currentSeason(db).id)
    // Players whose ratings you changed: a 플레이 스타일 written from the old ones is written again.
    const rerated = [
      ...new Set(
        events.flatMap((e) => {
          if (e.type !== 'player_edited') return []
          const p = e.payload as EventPayloads['player_edited']
          return p.fields.some((f) => f.startsWith('ratings.')) ? [p.playerId] : []
        }),
      ),
    ]
    if (reactions.length === 0 && rounds.length === 0 && occasions.length === 0 && !held && rerated.length === 0 && !voices.some((e) => REACTION_TRIGGERS.has(e.type))) {
      setStoryValue(db, CURSOR, handled)
      return 0
    }
    // If reading the league fails here, the mark stays put and the next change tries again.
    const league = this.league(db, folder)
    let queued = 0
    const queue = (kind: StoryKind, input: StoryInput | null) => {
      if (input && this.enqueue(slug, db, folder, kind, input) !== null) queued++
    }
    for (const r of reactions) {
      // One reaction failing to build must not stop the others (or repeat them forever).
      try {
        if (r.kind === 'post_game_thread') {
          queue('post_game_thread', gameThreadInput(league, r.gameId, r.eventId))
        } else if (r.kind === 'correction') {
          // A thread still waiting is rebuilt with the new score (or box score); one already up gets a
          // correction notice, but only when the score itself changed: fixed box lines aren't news.
          // One being written now drops its answer (its game changed after its facts: gameAsTold), so it's rebuilt too.
          const p = r.event.payload as { before: { homeScore: number; awayScore: number }; after: { homeScore: number; awayScore: number } }
          const scoreChanged = p.before.homeScore !== p.after.homeScore || p.before.awayScore !== p.after.awayScore
          const writing = this.threadWriting(db, r.gameId)
          if (cancelQueuedForGame(db, 'post_game_thread', r.gameId, 'score corrected') > 0 || writing) {
            queue('post_game_thread', gameThreadInput(league, r.gameId, r.event.id))
          } else if (scoreChanged && db.prepare("SELECT 1 FROM posts WHERE game_id = ? AND kind = 'thread'").get(r.gameId)) {
            queue('event_thread', eventThreadInput(league, [r.event]))
          }
        } else if (r.kind === 'unrecorded') {
          // 기록 취소: a thread still waiting goes (nobody saw it), and one being written drops its answer (gameAsTold);
          // one already up gets a notice that the result was taken back.
          if (cancelQueuedForGame(db, 'post_game_thread', r.gameId, 'game unrecorded') === 0 && db.prepare("SELECT 1 FROM posts WHERE game_id = ? AND kind = 'thread'").get(r.gameId)) {
            queue('event_thread', eventThreadInput(league, [r.event]))
          }
        } else if (r.events.every((e) => DRAFT_EVENTS.includes(e.type))) {
          this.queueDraft(db, league, r.events, queue)
        } else {
          queue('event_thread', eventThreadInput(league, r.events))
        }
      } catch (e) {
        console.warn('[story] could not queue a reaction', e)
      }
    }
    // The players whose pages a round's editors touch.
    const touched: string[] = []
    for (const { seasonId, round } of this.completedRounds(db, events, true)) {
      this.roundPassed(db, seasonId, round)
      try {
        queue('event_thread', roundUpInput(league, seasonId, round))
        if (this.queueWiki(slug, db, folder, roundWikiInput(league, seasonId, round))) queued++
        touched.push(...roundTop(league, seasonId, round).top.map((l) => l.playerId))
      } catch (e) {
        console.warn('[story] could not queue a round-up', e)
      }
      try {
        if (this.hooks.onRound?.(slug, db, folder, seasonId, round)) queued++
      } catch (e) {
        console.warn('[story] could not queue the lore sweep', e)
      }
    }
    // Their pages still showing the app's 플레이 스타일 get one written; after a round, any page written from ratings
    // or lore play sentences that changed since is written again (after your rating edits, those players').
    if (rounds.length > 0 || rerated.length > 0) {
      try {
        queued += this.queuePlayerPages(slug, db, folder, league, { fresh: touched, stale: rounds.length > 0 ? 'all' : rerated }, 'round').jobs
      } catch (e) {
        console.warn('[story] could not queue player pages', e)
      }
    }
    // The players worth hearing from (mood crossings, moves, season awards) say something, a few at a time.
    try {
      if (this.queueReactions(slug, db, folder, league, reactionPicks(league, voices))) queued++
    } catch (e) {
      console.warn('[story] could not queue player reactions', e)
    }
    // Wiki editors note trades on the players' and schools' pages.
    for (const e of events.filter((x) => x.type === 'trade_applied')) {
      try {
        const p = e.payload as { teams: string[]; players: string[] }
        const fact = describeEvent(league, e)?.text
        if (fact && this.queueWiki(slug, db, folder, wikiEditInput(league, { players: p.players, teams: p.teams }, [fact], `trade:${e.id}`))) queued++
      } catch (err) {
        console.warn('[story] could not queue wiki edits', err)
      }
    }
    try {
      // Taken-back news always leaves the jobs waiting for it; new jobs only while Claude Code works.
      queued += this.queueOccasions(slug, db, folder, league, occasions, writable)
    } catch (err) {
      console.warn('[story] could not queue wiki edits', err)
    }
    setStoryValue(db, CURSOR, handled)
    return queued
  }

  /**
   * The community is off: nothing new is written, but wiki jobs queued before must not write what was since
   * taken back, and words putting right what was written wait for a look that may queue them.
   */
  private takeBack(slug: string, db: Db, folder: string, events: LeagueEvent[]): void {
    const occasions = events.filter((e) => occasionOf(e) !== null)
    if (occasions.length === 0) return
    try {
      this.queueOccasions(slug, db, folder, readLeague(db, folder), occasions, false)
    } catch (err) {
      console.warn('[story] could not take back wiki edits', err)
    }
  }

  /**
   * Wiki edits after awards, draft swaps and playoff series: each kind's news
   * joins that kind's job still waiting (while it has room), so a burst costs
   * one job. Something taken back while its job waits leaves it, and a job
   * left with nothing is cancelled; taken back after it was written, it gets
   * words (see planOccasion). That part always runs; without `create` (the
   * community off, Claude Code unusable) nothing new is added, and words
   * putting right what was written wait in story state for a look with
   * `create`, which queues them even with no news of their kind. Returns how
   * many jobs were added.
   */
  private queueOccasions(slug: string, db: Db, folder: string, league: League, events: LeagueEvent[], create: boolean): number {
    const seasonId = currentSeason(db).id
    const written = (key: string) => writtenItem(db, seasonId, key)
    const hasWords = (kind: OccasionKind) => {
      const words = takenBack(db, seasonId, kind)
      return words.notes.length + words.items.length > 0
    }
    let added = 0
    for (const kind of OCCASION_KINDS) {
      const mine = events.filter((e) => occasionOf(e) === kind)
      if (mine.length === 0 && !(create && hasWords(kind))) continue
      // A job that left the queue before it could be rewritten runs with what it had: what it held is written
      // now, so the news is planned again once. Plans are by key, so what landed the first time isn't doubled.
      for (let attempt = 1; ; attempt++) {
        const rows = db
          .prepare(
            `SELECT id, input, created_at FROM jobs WHERE kind = ? AND status = 'queued' AND ${jsonField('input', '$.occasion.kind')} = ? AND ${jsonField('input', '$.occasion.seasonId')} = ? ORDER BY id`,
          )
          .all(WIKI_EDITS, kind, seasonId) as { id: number; input: string; created_at: string }[]
        const waiting = rows.map((r) => {
          const old = JSON.parse(r.input) as WikiEditInput
          return { id: r.id, old, created: r.created_at, occasion: old.occasion! }
        })
        const before = waiting.map((w) => JSON.stringify(w.occasion))
        const pending = takenBack(db, seasonId, kind)
        const plan = planOccasion(league, kind, seasonId, waiting.map((w) => w.occasion), mine, pending, { create, written })
        const now = new Date().toISOString()
        const missed: WikiOccasion[] = []
        waiting.forEach((w, i) => {
          if (JSON.stringify(w.occasion) === before[i]) return
          const input = occasionInput(league, w.occasion)
          // Joining keeps the job fresh (a draft can run over more than a day); only losing something doesn't.
          const stamp = onlyLost(JSON.parse(before[i]!) as WikiOccasion, w.occasion) ? w.created : now
          const hit = input
            ? // A number check's retry stays the retry.
              db.prepare("UPDATE jobs SET input = ?, created_at = ? WHERE id = ? AND status = 'queued'").run(JSON.stringify(keepRetry(input, w.old)), stamp, w.id).changes > 0
            : db.prepare("UPDATE jobs SET status = 'cancelled', error = 'taken back', finished_at = ? WHERE id = ? AND status = 'queued'").run(now, w.id).changes > 0
          if (!hit) missed.push(w.occasion)
        })
        // Kept before any second plan, which reads them again. Waiting words this plan put in a job that has since
        // left the queue wait again (unless that job's news gets a job of its own below).
        const gone = attempt === 1 || !create ? missed : []
        const inGone = (key: string) => gone.some((m) => [...m.notes, ...m.items].some((x) => x.key === key))
        const still = <T extends { key: string }>(was: T[], left: T[]) => [...was.filter((x) => inGone(x.key) && !left.some((y) => y.key === x.key)), ...left]
        keepTakenBack(db, seasonId, kind, { notes: still(pending.notes, plan.pending.notes), items: still(pending.items, plan.pending.items) })
        if (missed.length > 0 && attempt === 1) continue
        // Missed again: what joined it gets a job of its own rather than being lost.
        if (create) for (const occasion of [...plan.added, ...missed]) if (this.queueWiki(slug, db, folder, occasionInput(league, occasion))) added++
        break
      }
    }
    return added
  }

  /**
   * Players' words: new picks join a reaction job still waiting (up to its
   * six players), so a run of looks (awards typed one by one, a trade
   * window's deals) costs one job, not one each. True when a job was added.
   */
  private queueReactions(slug: string, db: Db, folder: string, league: League, picks: ReactionPick[]): boolean {
    if (picks.length === 0 || !(this.ai.fake || !this.ai.unavailable())) return false
    const waiting = db.prepare("SELECT id, input FROM jobs WHERE kind = ? AND status = 'queued' ORDER BY id DESC LIMIT 1").get(PLAYER_REACTION) as
      | { id: number; input: string }
      | undefined
    const old = waiting ? (JSON.parse(waiting.input) as PlayerReactionInput) : null
    if (waiting && old && !old.retry && old.seasonId === currentSeason(db).id && Array.isArray(old.players)) {
      const input = reactionInput(league, mergeReactionPicks(league, old, picks))
      if (input && db.prepare("UPDATE jobs SET input = ?, created_at = ? WHERE id = ? AND status = 'queued'").run(JSON.stringify(input), new Date().toISOString(), waiting.id).changes > 0) {
        return false
      }
    }
    const input = reactionInput(league, picks)
    if (!input) return false
    this.ai.queueFor(slug, db, folder).enqueue(PLAYER_REACTION, input, REACTION_PRIORITY)
    return true
  }

  /**
   * Draft moves share one live thread per season: the first batch opens it,
   * later batches add comments to it. If the thread's job never ran (it
   * failed, or was cancelled), the next batch opens one again.
   */
  private queueDraft(db: Db, league: League, events: LeagueEvent[], queue: (kind: StoryKind, input: StoryInput | null) => void): void {
    const key = `draft-live:${currentSeason(db).id}`
    const live = storyValue(db, key)
    const writing = Boolean(
      db.prepare(`SELECT 1 FROM jobs WHERE kind = 'event_thread' AND status IN ('queued', 'running') AND ${jsonField('input', '$.liveKey')} = ? LIMIT 1`).get(key),
    )
    if (live !== null && /^\d+$/.test(live) && db.prepare('SELECT 1 FROM posts WHERE id = ?').get(Number(live))) {
      queue('live_comments', liveCommentsInput(league, events, Number(live), key))
    } else if (writing) {
      queue('live_comments', liveCommentsInput(league, events, null, key))
    } else {
      const input = eventThreadInput(league, events)
      if (input) {
        setStoryValue(db, key, 'pending')
        queue('event_thread', { ...input, instructions: LIVE_DRAFT_START, liveKey: key })
      }
    }
  }

  /** After regular-season results (new or corrected), the standings moments not told yet become events. */
  private announceMoments(db: Db, events: LeagueEvent[]): void {
    const results = events.some((e) => {
      if (e.type === 'game_recorded' || e.type === 'game_unrecorded') return (e.payload as { stage: string }).stage === 'regular'
      if (e.type !== 'game_corrected') return false
      return getGame(db, (e.payload as { gameId: number }).gameId)?.stage === 'regular'
    })
    if (!results) return
    try {
      announceStandingsMoments(db)
    } catch (e) {
      console.warn('[story] could not work out standings moments', e)
    }
  }

  /**
   * A completed round: wiki disputes nobody settled count down, and close as
   * they stand when their time is up. Polls waiting for this round close
   * (held while the community is off), their fans' votes planned first if
   * nobody has looked since they went up.
   */
  private roundPassed(db: Db, seasonId: number, round: number): void {
    try {
      tickDisputes(db, new Date().toISOString())
    } catch (e) {
      console.warn('[story] could not close stale wiki disputes', e)
    }
    try {
      planPolls(db, { fast: this.ai.fake })
      closeRoundPolls(db, seasonId, round, Date.now(), loadConfig(db).config.community.enabled)
    } catch (e) {
      console.warn('[story] could not close polls', e)
    }
  }

  /**
   * New polls get their fans' votes planned, and polls whose time is up
   * close with a results post. While the community is off they wait (no
   * results post could go up) and close at the first look once it's on.
   * Runs before the boards are read, so what they show is up to date.
   */
  private polls(db: Db): void {
    try {
      planPolls(db, { fast: this.ai.fake })
      closeDuePolls(db, Date.now(), loadConfig(db).config.community.enabled)
    } catch (e) {
      console.warn('[story] could not update polls', e)
    }
  }

  /** After a trade, a draft swap or an undone move, players' wiki pages carry their new school's category. */
  private refile(db: Db, config: LeagueConfig, events: LeagueEvent[]): void {
    if (!events.some((e) => MOVES.includes(e.type))) return
    try {
      syncSchoolCategories(db, config, Date.now())
    } catch (e) {
      console.warn('[story] could not refile moved players in the wiki', e)
    }
  }

  /** The teams these events touched get a mood snapshot. */
  private snapshotMoods(db: Db, folder: string, events: LeagueEvent[]): void {
    const teams = new Set<string>()
    for (const e of events) {
      const x = e.payload as { home?: string; away?: string; teams?: string[]; teamId?: string; targetTeamId?: string; gameId?: number }
      if (e.type === 'game_recorded' || e.type === 'game_unrecorded') [x.home, x.away].forEach((t) => t && teams.add(t))
      if (e.type === 'game_corrected' && x.gameId) {
        const g = getGame(db, x.gameId)
        if (g) [g.home, g.away].forEach((t) => teams.add(t))
      }
      if (e.type === 'trade_applied') x.teams?.forEach((t) => teams.add(t))
      if (e.type === 'draft_swap') [x.teamId, x.targetTeamId].forEach((t) => t && teams.add(t))
      // A lineup change moves moods only when someone went between the starters and the bench (his role).
      if (e.type === 'slots_changed') {
        const s = e.payload as EventPayloads['slots_changed']
        if (s.rotation) teams.add(s.teamId)
      }
    }
    if (teams.size === 0) return
    try {
      const league = readLeague(db, folder)
      // One replay of everyone's feelings for the whole look (snapshots taken meanwhile don't change it).
      const feelings = leagueFeelings(league)
      for (const t of teams) snapshotMoods(league, t, Date.now(), feelings)
    } catch (e) {
      console.warn('[story] could not update moods', e)
    }
  }

  /** The locker room of one team: moods, reasons and usage clashes. */
  lockerRoom(db: Db, folder: string, teamId: string): LockerRoomView {
    if (!listTeams(db).some((t) => t.id === teamId)) refuse('unknown-team', { team: teamId })
    return lockerRoom(readLeague(db, folder), teamId)
  }

  /** One player's state over a season (선수 상태). */
  playerState(db: Db, folder: string, playerId: string, seasonId?: number): PlayerStateView {
    return playerState(readLeague(db, folder), playerId, seasonId)
  }

  private queueWiki(slug: string, db: Db, folder: string, input: WikiEditInput | null): boolean {
    if (!input || (!this.ai.fake && this.ai.unavailable())) return false
    this.ai.queueFor(slug, db, folder).enqueue(WIKI_EDITS, input, WIKI_PRIORITY)
    return true
  }

  /**
   * Player-page jobs (story/wikiPlayer.ts) for the pages that want writing:
   * of `fresh`, those still showing the app's 플레이 스타일; of `stale`,
   * those written from ratings or lore play sentences that changed since.
   * About six of one school a job, below chatter in the queue. Nothing while
   * Claude Code isn't usable, or in a queue that doesn't run them (a test's).
   * Returns the jobs and the players in them.
   */
  private queuePlayerPages(slug: string, db: Db, folder: string, league: League, who: Parameters<typeof planPlayerPages>[1], why: string): PlayerPagesPlan {
    const none = { jobs: 0, players: 0 }
    if (!this.ai.fake && this.ai.unavailable()) return none
    const queue = this.ai.queueFor(slug, db, folder)
    if (!queue.knows?.(WIKI_PLAYER)) return none
    upgradeWiki(db, Date.now())
    seedWiki(db, league.config, league.lore, Date.now())
    const out = { ...none }
    for (const batch of batches(planPlayerPages(league, who))) {
      const input = playerPagesInput(league, batch, `${why}:${lastEventId(db)}:${batch[0]!.player.id}`)
      if (!input) continue
      queue.enqueue(WIKI_PLAYER, input, WIKI_PLAYER_PRIORITY)
      out.jobs++
      out.players += input.targets.length
    }
    return out
  }

  /** 선수 문서 다듬기, counted before you're asked: the pages that want writing (not yet in a job) and the jobs they'd take. */
  playerPagesPlan(db: Db, folder: string): PlayerPagesPlan {
    const league = readLeague(db, folder)
    upgradeWiki(db, Date.now())
    seedWiki(db, league.config, league.lore, Date.now())
    const needs = planPlayerPages(league, { fresh: 'all', stale: 'all' })
    return { jobs: batches(needs).length, players: needs.length }
  }

  /**
   * 선수 문서 다듬기 (편집실 → 위키): every page still showing the app's
   * 플레이 스타일, or written from ratings or lore that changed since, in jobs
   * of about six a school, below chatter; 취소 in 최근 작업 takes them back.
   * Refused while Claude Code isn't usable.
   */
  polishPlayerPages(slug: string, db: Db, folder: string): PlayerPagesPlan {
    if (!this.ai.fake && this.ai.unavailable()) throw new AppError('ai-unavailable', 'Claude Code is not ready')
    return this.queuePlayerPages(slug, db, folder, this.league(db, folder), { fresh: 'all', stale: 'all' }, 'polish')
  }

  /** Player-page jobs still in the queue, for 편집실 → 위키. */
  playerPagesStatus(db: Db): PlayerPagesStatus {
    const count = (status: string) => (db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE kind = ? AND status = ?').get(WIKI_PLAYER, status) as { n: number }).n
    return { waiting: count('queued'), running: count('running') }
  }

  /** Whether the wiki's editors can write now: the community is on and Claude Code works. */
  private editorsAround(db: Db): boolean {
    return loadConfig(db).config.community.enabled && (this.ai.fake || !this.ai.unavailable())
  }

  /**
   * You wrote in a 토론 thread: the editors answer. An answer still waiting
   * is rebuilt to take in your newest words, so a few quick comments cost
   * one job. True when a job was added.
   */
  wikiTalk(slug: string, db: Db, folder: string, threadId: number): boolean {
    if (!this.editorsAround(db)) return false
    const input = talkInput(this.league(db, folder), threadId)
    if (!input) return false
    if (this.rebuildTalk(db, threadId, input)) return false
    this.ai.queueFor(slug, db, folder).enqueue(WIKI_TALK, input, TALK_PRIORITY)
    return true
  }

  /**
   * Editors just answered in a thread: answers still waiting there (a 토론
   * answer, a pushback carrying on in it) are rebuilt, so they see these and
   * number their own after them.
   */
  wikiAnswered(db: Db, folder: string, threadId: number): void {
    const talk = this.waitingTalk(db, threadId)
    const pushes = db.prepare(`SELECT id, input FROM jobs WHERE kind = ? AND status = 'queued' AND ${jsonField('input', '$.threadId')} = ?`).all(WIKI_PUSHBACK, threadId) as {
      id: number
      input: string
    }[]
    if (talk === null && pushes.length === 0) return
    const league = this.league(db, folder)
    if (talk !== null) {
      const input = talkInput(league, threadId)
      if (input) this.rebuildTalk(db, threadId, input)
    }
    for (const p of pushes) {
      const old = JSON.parse(p.input) as { pageId: number; rev: number; numberRetry?: string[]; retryOf?: number }
      const input = pushbackInput(league, old.pageId, old.rev, { rebuilding: true })
      // A retry stays the retry (one per job), whatever it now answers.
      if (input) db.prepare("UPDATE jobs SET input = ? WHERE id = ? AND status = 'queued'").run(JSON.stringify(keepRetry(input, old)), p.id)
    }
  }

  private waitingTalk(db: Db, threadId: number): { id: number; old: Pick<WikiTalkInput, 'numberRetry' | 'retryOf' | 'answers'> } | null {
    const row = db
      .prepare(`SELECT id, input FROM jobs WHERE kind = ? AND status = 'queued' AND ${jsonField('input', '$.threadId')} = ? ORDER BY id DESC LIMIT 1`)
      .get(WIKI_TALK, threadId) as { id: number; input: string } | undefined
    return row ? { id: row.id, old: JSON.parse(row.input) as WikiTalkInput } : null
  }

  /**
   * Puts a fresh input on the answer waiting in this thread. False when none
   * is waiting. A retry stays one, but its note names the numbers only while
   * it answers the same comment of yours (see talkRetry).
   */
  private rebuildTalk(db: Db, threadId: number, input: WikiTalkInput): boolean {
    const waiting = this.waitingTalk(db, threadId)
    if (waiting === null) return false
    const numberRetry = talkRetry(waiting.old, input)
    const next = numberRetry ? { ...input, numberRetry, ...(waiting.old.retryOf ? { retryOf: waiting.old.retryOf } : {}) } : input
    return db.prepare("UPDATE jobs SET input = ?, created_at = ? WHERE id = ? AND status = 'queued'").run(JSON.stringify(next), new Date().toISOString(), waiting.id).changes > 0
  }

  /** You saved a page: if you changed an editor's text, they answer (and may undo it once). True when a job was added. */
  wikiSaved(slug: string, db: Db, folder: string, pageId: number, rev: number): boolean {
    if (!this.editorsAround(db)) return false
    // Cheap first: most saves change no editor's text, and reading the league (lore and all) isn't free.
    if (!pushbackTarget(db, loadConfig(db).config, pageId, rev)) return false
    const input = pushbackInput(this.league(db, folder), pageId, rev)
    if (!input) return false
    this.ai.queueFor(slug, db, folder).enqueue(WIKI_PUSHBACK, input, TALK_PRIORITY)
    return true
  }

  /** Editors far enough apart (by the edit-war setting) fight over a section. True when a war was queued. */
  wikiWar(slug: string, db: Db, folder: string, call: WarCall): boolean {
    if (!this.editorsAround(db)) return false
    const input = warInput(this.league(db, folder), call)
    if (!input) return false
    this.ai.queueFor(slug, db, folder).enqueue(WIKI_WAR, input, WAR_PRIORITY)
    return true
  }

  /** A round's edits that other editors contest: the hottest one that qualifies becomes a war (one per round of edits). */
  wikiContested(slug: string, db: Db, folder: string, edits: ContestedEdit[]): void {
    for (const e of [...edits].sort((a, b) => b.heat - a.heat)) if (this.wikiWar(slug, db, folder, e)) return
  }

  front(db: Db, folder: string): PostSummary[] {
    this.ensure(db, folder)
    this.polls(db)
    return latestPosts(db, Date.now(), 12)
  }

  board(db: Db, folder: string, boardId: string, page: number): BoardPage {
    const { config } = loadConfig(db)
    this.ensure(db, folder)
    this.polls(db)
    return boardPage(db, config.community, boardId, page, Date.now())
  }

  /** `again`: the page showing this post reads it again (comments or votes arriving), which isn't another view. */
  post(db: Db, postId: number, again = false): PostView {
    this.polls(db)
    return openPost(db, loadConfig(db).config.community, postId, Date.now(), { view: !again })
  }

  /** Your vote on a poll: one per poll, changeable while it's open. A poll whose time is up closes first, and refuses it. */
  pollVote(db: Db, pollId: number, option: number): PollView {
    this.polls(db)
    return votePoll(db, pollId, option, Date.now())
  }

  /** Reveals the next buffered items, moves views and votes, and refills chatter when it runs low. */
  refresh(slug: string, db: Db, folder: string, random: () => number = Math.random): RefreshResult {
    const { config } = loadConfig(db)
    const c = config.community
    this.ensure(db, folder)
    this.prune(db, folder, Date.now())
    const { revealed, waiting } = refreshFeed(db, c, random, Date.now())
    // Polls among the posts just revealed get their fans' votes.
    this.polls(db)
    const today = this.chatterToday(db)
    const budgetSpent = today >= c.dailyChatterJobs
    let refilling = this.chatterPending(db)
    if (c.enabled && !budgetSpent && !refilling && waiting < c.refillBelow) {
      refilling = this.enqueue(slug, db, folder, 'chatter_batch', chatterInput(this.league(db, folder))) !== null
    }
    return { revealed, waiting, refilling, budgetSpent }
  }

  writePost(slug: string, db: Db, folder: string, input: WritePostInput): number {
    const { config } = loadConfig(db)
    this.ensure(db, folder)
    const id = writeUserPost(db, config.community, input, Date.now())
    if (input.poll) this.polls(db)
    if (config.community.enabled) this.enqueue(slug, db, folder, 'reply_to_user', replyInput(this.league(db, folder), id, null))
    return id
  }

  writeComment(slug: string, db: Db, folder: string, input: WriteCommentInput): number {
    const { config } = loadConfig(db)
    const id = writeUserComment(db, input, Date.now())
    if (config.community.enabled) this.enqueue(slug, db, folder, 'reply_to_user', replyInput(this.league(db, folder), input.postId, id))
    return id
  }

  vote(db: Db, target: 'post' | 'comment', id: number, value: -1 | 0 | 1) {
    return vote(db, target, id, value)
  }

  /** The 뉴스 box: a news event (no facts change), which reporters and fans then pick up. */
  news(slug: string, db: Db, folder: string, text: string): number {
    const trimmed = text.trim()
    if (!trimmed) refuse('empty-post', {})
    const league = readLeague(db, folder)
    const m = mentions(league, trimmed)
    const id = transaction(db, () => appendEvent(db, 'news_posted', { text: trimmed.slice(0, 1000), ...m }, currentSeason(db).id))
    this.afterChange(slug, db, folder)
    return id
  }

  /** Saves the community settings; your nickname changes on every post you wrote too. */
  saveSettings(db: Db, community: CommunityConfig): number {
    const { config } = loadConfig(db)
    const ids = (c: CommunityConfig) => c.boards.map((b) => `${b.id}:${b.role}`).join(',')
    // Boards can be renamed, not added or removed: posts refer to them.
    if (ids(community) !== ids(config.community)) refuse('boards-fixed', {})
    return transaction(db, () => {
      setMyNick(db, community.myNick)
      return updateConfig(db, { ...config, community })
    })
  }

  status(slug: string, db: Db): CommunityStatus {
    const { config } = loadConfig(db)
    const kinds = ['post_game_thread', 'event_thread', 'reply_to_user', 'chatter_batch', 'live_comments']
    const writing = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running') AND kind IN (${kinds.map(() => '?').join(',')})`)
        .get(...kinds) as { n: number }
    ).n
    void slug
    return {
      personas: personaCount(db),
      waiting: bufferSize(db),
      writing,
      chatterToday: this.chatterToday(db),
      chatterBudget: config.community.dailyChatterJobs,
      aiReady: this.ai.fake || this.ai.ready(),
    }
  }

  /**
   * Regular-season rounds these events completed, each only once (`claim` marks them done): a round's
   * last game recorded, or (2K 일정대로) a session closed with 오늘 경기 끝.
   */
  private completedRounds(db: Db, events: LeagueEvent[], claim: boolean): { seasonId: number; round: number }[] {
    const out: { seasonId: number; round: number }[] = []
    for (const e of events) {
      let at: { seasonId: number; round: number } | null = null
      if (e.type === 'round_closed' && e.seasonId !== null) {
        at = { seasonId: e.seasonId, round: (e.payload as { round: number }).round }
      } else if (e.type === 'game_recorded') {
        const game = getGame(db, (e.payload as { gameId: number }).gameId)
        if (game && game.stage === 'regular') at = { seasonId: game.seasonId, round: game.round }
      }
      if (!at) continue
      const { seasonId, round } = at
      const key = `round-up:${seasonId}:${round}`
      if (storyValue(db, key) !== null) continue
      // Complete means full (rounds built by hand may still be missing games) and all played; a session, closed.
      if (!roundComplete(db, seasonId, round) || out.some((r) => r.seasonId === seasonId && r.round === round)) continue
      if (claim) setStoryValue(db, key, String(e.id))
      out.push({ seasonId, round })
    }
    return out
  }

  /**
   * Keeps the league file small, at most once an hour: finished story jobs
   * drop their stored context after a few days, their scratch folders go, and
   * each persona keeps only its latest notes.
   */
  prune(db: Db, folder: string, nowMs: number): void {
    const last = storyValue(db, 'last-prune')
    if (last !== null && nowMs - Date.parse(last) < 3600_000) return
    setStoryValue(db, 'last-prune', new Date(nowMs).toISOString())
    // Players' reaction jobs and the secret check too: their inputs (and the check's answers) hold secrets.
    const pruned = [...STORY_KINDS, PLAYER_REACTION, LORE_REVEAL]
    const kinds = pruned.map(() => '?').join(',')
    const old = new Date(nowMs - 3 * 86_400_000).toISOString()
    db.prepare(
      `UPDATE jobs SET input = '{}', output = NULL
       WHERE kind IN (${kinds}) AND status IN ('done', 'failed', 'cancelled') AND COALESCE(finished_at, created_at) < ? AND input <> '{}'`,
    ).run(...pruned, old)
    db.prepare(
      `DELETE FROM persona_memory WHERE id IN (
         SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY persona_id ORDER BY id DESC) AS n FROM persona_memory) WHERE n > ?)`,
    ).run(MEMORY_PER_PERSONA)
    // Scratch folders (jobs/<id>) of jobs finished more than a day ago.
    const scratch = join(folder, 'jobs')
    if (!existsSync(scratch)) return
    const day = new Date(nowMs - 86_400_000).toISOString()
    const done = db.prepare("SELECT 1 FROM jobs WHERE id = ? AND status NOT IN ('queued', 'running') AND COALESCE(finished_at, created_at) < ?")
    for (const name of readdirSync(scratch)) {
      if (!/^\d+$/.test(name) || !done.get(Number(name), day)) continue
      try {
        rmSync(join(scratch, name), { recursive: true, force: true })
      } catch {
        // In use or locked: next time.
      }
    }
  }

  private chatterToday(db: Db): number {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    return (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'chatter_batch' AND created_at >= ?").get(start.toISOString()) as { n: number }).n
  }

  private chatterPending(db: Db): boolean {
    return Boolean(db.prepare("SELECT 1 FROM jobs WHERE kind = 'chatter_batch' AND status IN ('queued', 'running') LIMIT 1").get())
  }
}
