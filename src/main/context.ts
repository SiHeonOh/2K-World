import { mkdirSync } from 'node:fs'
import type { PushNote, PushTopic } from '@shared/api'
import { join } from 'node:path'
import { ImportService } from './importer'
import { LeagueService } from './leagues'
import { SettingsStore } from './settings'
import { TemplateService } from './templates'
import { AiService } from './ai'
import { GameDayService } from './gameday'
import { LoreService, syncLoreFolder } from './lore'
import { StoryService } from './story'
import { WikiService } from './wiki'
import { STORY_PRIORITY, storyDemo, storyKinds } from '@story/jobs'
import { WIKI_EDITS, WIKI_RETRY_PRIORITY, wikiEditDemo, wikiEditKind } from '@story/wikiEdits'
import { TALK_PRIORITY, WAR_PRIORITY, WIKI_TALK_KINDS, WIKI_WAR, wikiTalkDemo, wikiTalkKinds } from '@story/wikiTalk'
import { loreDemo, loreKinds } from '@story/loreJobs'
import { revealDemo, revealKind } from '@story/reveals'
import { SuggestionService } from './suggestions'
import { gmDemo, gmKinds, type GmHooks } from '@sim/gm'
import { draftDemo, draftKinds } from '@sim/draft'
import { PLAYER_REACTION, REACTION_PRIORITY, reactionDemo, reactionKind, releaseHeld } from '@story/reactions'
import { GmService } from './gm'
import type { Db } from '@data/db'
import { RETRY_NEVER } from '@ai/queue'
import { loadPrompt } from './prompts'

/** Everything the IPC handlers need, built for one data folder. */
export interface AppContext {
  dataDir: string
  settings: SettingsStore
  templates: TemplateService
  importer: ImportService
  leagues: LeagueService
  ai: AiService
  gameday: GameDayService
  story: StoryService
  wiki: WikiService
  lore: LoreService
  suggestions: SuggestionService
  gm: GmService
}

/** The screen a finished job's results show up on. */
export function pushTopic(kind: string): PushTopic {
  if (['post_game_thread', 'event_thread', 'reply_to_user', 'live_comments', 'chatter_batch', 'player_reaction'].includes(kind)) return 'community'
  if (kind === 'wiki_edits' || WIKI_TALK_KINDS.includes(kind)) return 'wiki'
  if (kind.startsWith('gm_')) return 'gm'
  if (kind.startsWith('lore_')) return 'inbox'
  if (kind === 'read_box_score') return 'gameday'
  return 'other'
}

/**
 * `push` sends a note to the open window when a job finishes, so its screen
 * can look again at once (left out in tests and scripts).
 */
export function createContext(dataDir: string, defaultsDir: string, appVersion: string, push?: (note: PushNote) => void): AppContext {
  mkdirSync(dataDir, { recursive: true })
  const settings = new SettingsStore(dataDir)
  const templates = new TemplateService(join(defaultsDir, 'templates'), join(dataDir, 'templates'))
  const importer = new ImportService(settings)
  const leagues = new LeagueService(dataDir, appVersion, settings, templates, importer)
  const ai = new AiService()
  // The writers' style guides are editable files (defaults/prompts, or the league's own prompts folder).
  // Writing that uses numbers its facts don't hold is redone once (the same job again, with a note).
  ai.addKinds(
    (db, folder, slug) =>
      storyKinds(db, () => loadPrompt('community', folder, defaultsDir), {
        requeue: (kind, input) => void ai.queueFor(slug, db, folder).enqueue(kind, input, STORY_PRIORITY[kind]),
      }),
    storyDemo,
  )
  // A round's contested edit can start an edit war; a 토론 that boils over can too.
  ai.addKinds(
    (db, folder, slug) => [
      wikiEditKind(db, () => loadPrompt('wiki', folder, defaultsDir), {
        contested: (edits) => story.wikiContested(slug, db, folder, edits),
        requeue: (input) => void ai.queueFor(slug, db, folder).enqueue(WIKI_EDITS, input, WIKI_RETRY_PRIORITY),
      }),
    ],
    wikiEditDemo,
  )
  ai.addKinds(
    (db, folder, slug) =>
      wikiTalkKinds(db, {
        style: () => loadPrompt('wiki', folder, defaultsDir),
        hooks: {
          war: (call) => void story.wikiWar(slug, db, folder, call),
          answered: (threadId) => story.wikiAnswered(db, folder, threadId),
          requeue: (kind, input) => void ai.queueFor(slug, db, folder).enqueue(kind, input, kind === WIKI_WAR ? WAR_PRIORITY : TALK_PRIORITY),
        },
      }),
    wikiTalkDemo,
  )
  const lore = new LoreService(defaultsDir)
  const suggestions = new SuggestionService(ai, lore)
  // Lore drafts and round suggestions only add cards to 제안함; kinds set to approve themselves are applied after.
  ai.addKinds(
    (db, folder) => loreKinds(db, folder, { style: () => loadPrompt('lore', folder, defaultsDir), afterStore: (d, f) => void suggestions.applyAuto(d, f) }),
    loreDemo,
  )
  // The sealed secret check: its reveal cards always wait for you (no afterStore).
  ai.addKinds((db, folder) => [revealKind(db, folder)], revealDemo)
  // GM results can call for more GM work, and a trade they make moves lore files and gets its threads.
  const gmHooks = (slug: string, db: Db, folder: string): GmHooks => ({
    queue: (kind, input, priority) => void ai.queueFor(slug, db, folder).enqueue(kind, input, priority),
    changed: () => {
      try {
        syncLoreFolder(db, folder)
      } catch (e) {
        console.warn('[lore] moving files after a GM trade failed', e)
      }
      try {
        story.afterChange(slug, db, folder)
      } catch (e) {
        console.warn('[story] reacting to GM moves failed', e)
      }
    },
    style: () => loadPrompt('gm', folder, defaultsDir),
  })
  ai.addKinds((db, folder, slug) => gmKinds(db, folder, gmHooks(slug, db, folder)), gmDemo)
  // A failed draft job's turns are played by code (GmService.reconcileDraft), so 다시 시도 has nothing left to do.
  ai.addKinds((db, folder, slug) => draftKinds(db, folder, gmHooks(slug, db, folder)).map((k) => ({ ...k, retryInput: RETRY_NEVER })), draftDemo)
  // Players' own words: a second try when a quote gave a secret away or used numbers its facts don't hold;
  // public words get the forum's reaction.
  ai.addKinds(
    (db, folder, slug) => [
      reactionKind(db, folder, {
        requeue: (input) => void ai.queueFor(slug, db, folder).enqueue(PLAYER_REACTION, input, REACTION_PRIORITY),
        changed: () => story.afterChange(slug, db, folder),
        style: () => loadPrompt('player', folder, defaultsDir),
      }),
    ],
    reactionDemo,
  )
  const gm = new GmService(ai, gmHooks)
  // A GM draft job ending (whatever the outcome) keeps the draft moving.
  ai.onJobChange((slug, db, folder, jobId) => gm.onJobChange(slug, db, folder, jobId))
  // A second try at players' words that ends without saving: the words its first try held back become news.
  ai.onJobChange((slug, db, folder, jobId) => {
    try {
      if (releaseHeld(db, jobId)) story.afterChange(slug, db, folder)
    } catch (e) {
      console.warn('[story] posting held players’ words failed', e)
    }
  })
  // A job that finished with something saved tells the open screens (new posts, comments, edits);
  // any finished job, failed ones too, tells the 최근 작업 list.
  ai.onJobChange((slug, db, _folder, jobId) => {
    if (!push) return
    const job = db.prepare('SELECT kind, status FROM jobs WHERE id = ?').get(jobId) as { kind: string; status: string } | undefined
    if (job?.status === 'done') push({ slug, topic: pushTopic(job.kind), kind: job.kind })
    if (job?.status === 'done' || job?.status === 'failed') push({ slug, topic: 'jobs', kind: job.kind })
  })
  // The queue pausing, resuming or getting blocked tells the banner every league screen shows.
  ai.onQueueState((slug) => push?.({ slug, topic: 'jobs', kind: 'queue' }))
  // A league's job queue runs while its database is open, and stops before it closes.
  leagues.onLifecycle({
    open: (slug, db, folder) => {
      void ai.queueFor(slug, db, folder)
      // Cards an "always approve" setting covers that couldn't be applied before the league last closed.
      try {
        suggestions.applyAuto(db, folder)
      } catch (e) {
        console.warn('[lore] applying suggestions on open failed', e)
      }
      // Lore files catch up with any roster change made while they couldn't move (a locked file, a restored backup).
      try {
        syncLoreFolder(db, folder)
      } catch (e) {
        console.warn('[lore] sync on open failed', e)
      }
      // A trade window left open with nothing more coming is closed, and a draft left mid-way carries on.
      try {
        gm.sweep(slug, db, folder)
        gm.reconcileDraft(slug, db, folder)
      } catch (e) {
        console.warn('[gm] catching up on open failed', e)
      }
    },
    close: (slug) => ai.closeQueue(slug),
  })
  // After each completed round: the lore sweep and the secret check, and a trade window every N rounds.
  const story = new StoryService(ai, {
    afterEvents: (slug, db, folder) => gm.reconcileDraft(slug, db, folder),
    onRound: (slug, db, folder, seasonId, round) => {
      const swept = suggestions.sweep(slug, db, folder, seasonId, round)
      let revealing = false
      try {
        revealing = suggestions.revealSweep(slug, db, folder, seasonId, round)
      } catch (e) {
        console.warn('[lore] the secret check failed', e)
      }
      try {
        suggestions.grudgeCards(db, folder, seasonId, round)
      } catch (e) {
        console.warn('[lore] grudge cards failed', e)
      }
      let traded = false
      try {
        traded = gm.onRound(slug, db, folder, seasonId, round)
      } catch (e) {
        console.warn('[gm] opening a trade window failed', e)
      }
      return swept || revealing || traded
    },
  })
  // Your 토론 comments get answers; your edits to an editor's text may get pushback.
  const wiki = new WikiService({
    talk: (slug, db, folder, threadId) => void story.wikiTalk(slug, db, folder, threadId),
    saved: (slug, db, folder, pageId, rev) => void story.wikiSaved(slug, db, folder, pageId, rev),
  })
  return { dataDir, settings, templates, importer, leagues, ai, gameday: new GameDayService(ai), story, wiki, lore, suggestions, gm }
}
