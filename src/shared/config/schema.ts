import { z } from 'zod'
import { SUGGESTION_KINDS } from '../suggestions'

/**
 * League config: one JSON document per league, validated by this schema.
 * It holds structure and rules only. Teams and players are league data
 * (see `../setup.ts`), so a template can ship with or without them.
 *
 * Bump CONFIG_VERSION and add a step to `migrations.ts` whenever a change
 * here would reject a config saved by an older version.
 */
export const CONFIG_VERSION = 4

// No trim: an id with stray spaces is rejected, never silently changed.
export const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[^\s/\\]+$/)

const nameSchema = z.string().trim().min(1).max(80)
const int = (min: number, max: number) => z.number().int().min(min).max(max)
/** Series lengths are odd, so someone always wins a majority (1, 3, 5, 7, 9). */
const bestOf = () => int(1, 9).refine((n) => n % 2 === 1)

// ── Structure ────────────────────────────────────────────────────────────

export const conferenceSchema = z.object({ id: idSchema, name: nameSchema })

export const divisionSchema = z.object({
  id: idSchema,
  name: nameSchema,
  conferenceId: idSchema.nullable(),
})

export const structureSchema = z.object({
  conferences: z.array(conferenceSchema),
  divisions: z.array(divisionSchema).min(1),
})

// ── Rosters and ratings ──────────────────────────────────────────────────

export const slotSchema = z.object({
  id: idSchema,
  name: nameSchema,
  /** Starters expect a starter's role; the rest are bench slots (role mood). */
  starter: z.boolean(),
})

export const rosterSchema = z.object({
  /** 'one-per-slot': every team fills each slot exactly once, so size = slots. */
  slotMode: z.enum(['one-per-slot', 'free']),
  minPlayers: int(1, 30),
  maxPlayers: int(1, 30),
  slots: z.array(slotSchema).min(1),
})

export const gradeStepSchema = z.object({
  label: z.string().trim().min(1).max(4),
  /** Numeric value used by the player value model. */
  value: z.number(),
})

const ratingBase = {
  id: idSchema,
  name: nameSchema,
  /**
   * The Korean name shown for it (위키, tables, AI writers); left out or
   * blank, a dictionary of 2K's names translates it (shared/labels.ts).
   * Display only, so it can change any time; added without a version bump.
   */
  label: z.string().trim().max(20).optional(),
  /** Weight of this column in the player value model; 0 = display only. */
  weight: z.number().min(0).max(100),
}

export const ratingColumnSchema = z.discriminatedUnion('kind', [
  z.object({
    ...ratingBase,
    kind: z.literal('number'),
    min: z.number(),
    max: z.number(),
  }),
  z.object({ ...ratingBase, kind: z.literal('grade') }),
])

export const ratingsSchema = z.object({
  columns: z.array(ratingColumnSchema),
  /** Best grade first. Shared by every grade column. */
  gradeScale: z.array(gradeStepSchema).min(2),
  /** The headline rating (e.g. OVR), shown first everywhere. */
  overallColumnId: idSchema.nullable(),
})

export const playerFieldsSchema = z.object({
  heightUnit: z.enum(['ft-in', 'cm']),
})

// ── Box score ────────────────────────────────────────────────────────────

/**
 * What a stat column means, so formulas (shooting %, usage, the points
 * check PTS = 2×FGM + 3PM + FTM) know which column to use.
 */
export const statMeaningSchema = z.enum([
  'points',
  'rebounds',
  'assists',
  'steals',
  'blocks',
  'turnovers',
  'fgm',
  'fga',
  'tpm',
  'tpa',
  'ftm',
  'fta',
  'other',
])

export const statColumnSchema = z.object({
  id: idSchema,
  /** Short label as the box score shows it, e.g. PTS. */
  name: z.string().trim().min(1).max(12),
  meaning: statMeaningSchema,
  /** Listed among league leaders (per-game average). */
  leader: z.boolean(),
})

export const statsSchema = z.object({
  columns: z.array(statColumnSchema),
})

// ── Season ───────────────────────────────────────────────────────────────

export const scheduleSchema = z.discriminatedUnion('kind', [
  /**
   * Every team plays every other team `cycles` times. `build`: the whole
   * schedule is drawn at season start ('auto'), or each round's games are
   * built by hand in 일정 ('manual'). Either way unplayed games can be changed.
   * 'played' (2K 일정대로) has no rounds: each game is picked as it's played
   * in 2K, into the open session (N일차), which 오늘 경기 끝 closes.
   */
  z.object({ kind: z.literal('round-robin'), cycles: int(1, 8), build: z.enum(['auto', 'manual', 'played']).default('auto') }),
  z.object({ kind: z.literal('custom'), gamesPerTeam: int(1, 200) }),
])

export const tiebreakerSchema = z.enum([
  'head-to-head',
  'point-diff',
  'points-for',
  'conference-record',
  'division-record',
  'random',
])

export const standingsSchema = z.object({
  /**
   * Applied in order after win %. Also used for the overall 1–N ranking.
   * 'random' is a seeded coin flip, so it is repeatable; the engine falls back
   * to it even when it isn't listed, so a rank is always defined.
   */
  tiebreakers: z.array(tiebreakerSchema),
})

export const playInSchema = z.object({
  enabled: z.boolean(),
  /** 'nba': 7v8 winner takes 7th; loser plays the 9v10 winner for 8th. */
  format: z.enum(['nba']),
  /** Best-of-N for each play-in game (1 = single game). */
  bestOf: bestOf(),
})

export const playoffsSchema = z.object({
  enabled: z.boolean(),
  /** Seed per conference, or across the whole league. */
  bracket: z.enum(['conference', 'league']),
  /** Seeds that go straight in. */
  directSeeds: int(1, 64),
  playIn: playInSchema,
  /** Best-of-N for every series before the finals. */
  seriesBestOf: bestOf(),
  finals: z.object({
    /** 'conference-champions': the conference winners meet in a final series. */
    kind: z.enum(['conference-champions', 'none']),
    bestOf: bestOf(),
  }),
})

export const calendarSchema = z.object({
  /** How many rounds make a "week" for weekly awards and round-ups. */
  roundsPerWeek: int(1, 50),
  weeksPerMonth: int(1, 10),
})

export const seasonSchema = z.object({
  label: nameSchema,
  schedule: scheduleSchema,
  standings: standingsSchema,
  playoffs: playoffsSchema,
  calendar: calendarSchema,
})

// ── Awards ───────────────────────────────────────────────────────────────

export const seasonAwardSchema = z.object({
  id: idSchema,
  name: nameSchema,
  /** 'player': one winner. 'selection': N teams of players (All-League 1st–3rd). */
  kind: z.enum(['player', 'selection']),
  /** Number of teams, for selections. */
  teams: int(1, 10),
  /** Players per team, for selections. */
  perTeam: int(1, 15),
  /** Regular-season awards are decided before the playoffs; finals awards after. */
  timing: z.enum(['regular-season', 'finals']),
})

export const periodicAwardSchema = z.object({
  id: idSchema,
  name: nameSchema,
  period: z.enum(['week', 'month']),
  winners: int(1, 10),
})

export const awardsSchema = z.object({
  season: z.array(seasonAwardSchema),
  periodic: z.array(periodicAwardSchema),
})

// ── Trades and draft ─────────────────────────────────────────────────────

export const phaseSchema = z.enum(['preseason', 'regular', 'playoffs', 'draft', 'offseason'])

export const tradesSchema = z.object({
  enabled: z.boolean(),
  /** Season phases in which player trades are allowed. */
  phases: z.array(phaseSchema),
  /** A player traded once can't be traded again until `until`. */
  oncePerSeason: z.object({
    enabled: z.boolean(),
    until: z.enum(['draft', 'season-end']),
  }),
  equalPlayerCount: z.boolean(),
  /** Cards may be added to a player trade. */
  cardsWithPlayers: z.boolean(),
  /** Optional limits, off (null) unless the league turns them on. */
  limits: z.object({
    perWindow: int(1, 50).nullable(),
    maxValueGap: z.number().min(0).nullable(),
  }),
})

export const cardTierSchema = z.object({
  fromRank: int(1, 500),
  toRank: int(1, 500),
  cards: int(0, 20),
})

export const cardSwapDraftSchema = z.object({
  kind: z.literal('card-swap'),
  /** Cards handed out by final overall rank. */
  allocation: z.array(cardTierSchema).min(1),
  /** Pick order: worst record picks first. */
  order: z.literal('reverse-rank'),
  /** Teams first spend cards to protect their own players. */
  protection: z.boolean(),
  /** 'one': one card per turn, cycling until cards run out. 'all': all of a team's cards on its turn. */
  turns: z.enum(['one', 'all']),
  /** Which slots can be swapped for each other. */
  slotRule: z.enum(['any', 'same-slot']),
  /** 'replaced': the incoming player takes the outgoing player's slot. */
  incomingSlot: z.enum(['replaced', 'own']),
  /** Both players in a swap are protected for the rest of the draft. */
  swappedProtected: z.boolean(),
  unusedCards: z.enum(['expire', 'carry-over']),
  cardTrades: z.object({
    enabled: z.boolean(),
    /** Card trades need not be 1-for-1. */
    unbalanced: z.boolean(),
    /** In-season cap per team (null = none), and what it counts. */
    inSeasonCap: int(0, 50).nullable(),
    capCounts: z.enum(['given', 'received', 'trades']),
  }),
  /** A traded card keeps its original owner's pick slot. */
  pickSlot: z.literal('original-owner'),
})

export const standardDraftSchema = z.object({
  kind: z.literal('standard'),
  rounds: int(1, 10),
  order: z.literal('reverse-rank'),
})

export const draftSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  standardDraftSchema,
  cardSwapDraftSchema,
])

// ── GMs ──────────────────────────────────────────────────────────────────

export const teamControlSchema = z.enum(['ai', 'user', 'frozen'])

/** The Claude models a job can run on (Claude Code's aliases for each family's latest model). */
export const modelSchema = z.enum(['haiku', 'sonnet', 'opus', 'fable'])
/** How hard the model thinks (Claude Code's --effort); 'default' leaves it to Claude Code. */
export const effortSchema = z.enum(['default', 'low', 'medium', 'high', 'xhigh', 'max'])

/** Every AI job the app runs, each with its own model and effort (편집실 → AI 모델). */
export const AI_JOBS = [
  'gameThread',
  'article',
  'reply',
  'live',
  'chatter',
  'wiki',
  'wikiTalk',
  'wikiWar',
  'wikiPlayer',
  'player',
  'loreDraft',
  'loreSweep',
  'gmIntent',
  'gmRespond',
  'gmDraft',
  'screenshot',
] as const
export type AiJob = (typeof AI_JOBS)[number]

/** Replies and live comments are quick (Haiku); everything else writes with Sonnet. Effort is Claude Code's own default. */
export const DEFAULT_AI_MODELS: Record<AiJob, z.infer<typeof modelSchema>> = {
  gameThread: 'sonnet',
  article: 'sonnet',
  reply: 'haiku',
  live: 'haiku',
  chatter: 'sonnet',
  wiki: 'sonnet',
  wikiTalk: 'sonnet',
  wikiWar: 'sonnet',
  wikiPlayer: 'sonnet',
  player: 'sonnet',
  loreDraft: 'sonnet',
  loreSweep: 'sonnet',
  gmIntent: 'sonnet',
  gmRespond: 'sonnet',
  gmDraft: 'sonnet',
  screenshot: 'sonnet',
}

const aiJobSchema = (job: AiJob) =>
  z
    .object({ model: modelSchema.default(DEFAULT_AI_MODELS[job]), effort: effortSchema.default('default') })
    .default(() => ({ model: DEFAULT_AI_MODELS[job], effort: 'default' as const }))

export const defaultAiJobs = () =>
  Object.fromEntries(AI_JOBS.map((j) => [j, { model: DEFAULT_AI_MODELS[j], effort: 'default' as const }])) as Record<
    AiJob,
    { model: z.infer<typeof modelSchema>; effort: z.infer<typeof effortSchema> }
  >

/** Jobs added after a league was made start from the job they grew out of (the wiki's 토론, wars and player pages from 위키 편집). */
const BORROWS: Partial<Record<AiJob, AiJob>> = { wikiTalk: 'wiki', wikiWar: 'wiki', wikiPlayer: 'wiki' }

export const aiConfigSchema = z.preprocess(
  (raw) => {
    const jobs = raw && typeof raw === 'object' ? (raw as { jobs?: unknown }).jobs : undefined
    if (!jobs || typeof jobs !== 'object') return raw
    const next = { ...(jobs as Record<string, unknown>) }
    for (const [job, from] of Object.entries(BORROWS)) if (next[job] === undefined && next[from] !== undefined) next[job] = next[from]
    return { ...(raw as object), jobs: next }
  },
  z.object({
    jobs: z.object(Object.fromEntries(AI_JOBS.map((j) => [j, aiJobSchema(j)])) as Record<AiJob, ReturnType<typeof aiJobSchema>>).default(() => defaultAiJobs()),
  }),
)

export const gmSchema = z.object({
  autonomy: z.enum(['propose', 'auto-within-limits', 'full']),
  /** In-season trade windows open every N rounds (sessions in 2K 일정대로); 0: only when you open one in 단장실. */
  tradeWindowEveryRounds: int(0, 100),
  rumorLeaks: z.boolean(),
  /** 'live': watch talks as they happen. 'after-window': locked until the window closes. */
  negotiationLog: z.enum(['live', 'after-window']),
  // Added after config v3 with defaults, so older configs read as these.
  /** GMs that get a turn in one window (the most motivated ones). */
  gmsPerWindow: int(1, 40).default(8),
  /** Negotiations one window may hold. */
  talksPerWindow: int(1, 20).default(6),
  /** Cards one side of an AI deal may carry; null: as many as it holds (the in-season cap still applies). */
  dealCards: int(0, 20).nullable().default(3),
})

// ── Community ────────────────────────────────────────────────────────────

/** What a board is for, so the app knows where each kind of post goes. Names are free. */
export const boardRoleSchema = z.enum(['main', 'games', 'trades', 'draft', 'humor', 'free', 'notice', 'poten'])

export const boardSchema = z.object({
  id: idSchema,
  name: nameSchema,
  role: boardRoleSchema,
})

/** What the forum's chatter is about (src/story/topics.ts), each weighted 0 (never) to 5 (a lot). */
export const TOPIC_KINDS = [
  'lore_story',
  'rumor',
  'world_topic',
  'rivalry',
  'league_roast',
  'rankings',
  'stats',
  'prediction',
  'meme',
  'off_topic',
  'newbie',
  'drama',
  'school_pride',
  'poll',
  'game_talk',
  'analysis',
] as const
export type TopicKind = (typeof TOPIC_KINDS)[number]
export const DEFAULT_TOPIC_MIX: Record<TopicKind, number> = {
  lore_story: 3,
  rumor: 2,
  world_topic: 2,
  rivalry: 3,
  league_roast: 2,
  rankings: 2,
  stats: 1,
  prediction: 2,
  meme: 3,
  off_topic: 2,
  newbie: 1,
  drama: 2,
  school_pride: 2,
  poll: 1,
  game_talk: 1,
  // Long posts cost more to write: kept modest.
  analysis: 2,
}

export const communitySchema = z
  .object({
    enabled: z.boolean(),
    /** Your own name on the boards. */
    myNick: z.string().trim().min(1).max(20),
    boards: z.array(boardSchema).min(1),
    /** Fan personas, spread over the schools. */
    fans: int(0, 1000),
    reporters: int(0, 20),
    /** The highest spice level a persona may have (1 = polite, 5 = savage but never hateful). */
    maxSpice: int(1, 5),
    /** Upvotes a post needs to reach 포텐, and a comment to be a BEST comment. */
    potenAt: int(1, 100000),
    bestAt: int(1, 100000),
    /** Items revealed per refresh. */
    revealPerRefresh: int(1, 20),
    /** A chatter job is queued when fewer items than this are waiting. */
    refillBelow: int(0, 200),
    /** Items one chatter job writes. */
    chatterBatch: int(5, 60),
    /** Chatter jobs per day; 0 turns chatter off. Event threads and replies don't count. */
    dailyChatterJobs: int(0, 500),
    /** How often each kind of chatter topic comes up (0–5); left out = the default. */
    topicMix: z.partialRecord(z.enum(TOPIC_KINDS), int(0, 5)).default({}),
  })
  .superRefine((c, ctx) => {
    const ids = new Set<string>()
    c.boards.forEach((b, i) => {
      if (ids.has(b.id)) ctx.addIssue({ code: 'custom', path: ['boards', i, 'id'], message: 'duplicate board id' })
      ids.add(b.id)
    })
    for (const role of ['main', 'poten'] as const) {
      if (!c.boards.some((b) => b.role === role)) ctx.addIssue({ code: 'custom', path: ['boards'], message: `needs a ${role} board` })
    }
  })

// ── Lore suggestions ─────────────────────────────────────────────────────

export const suggestionModeSchema = z.enum(['ask', 'auto', 'off'])

/**
 * The lore suggestion inbox (제안함). Added after config v3 with defaults, so
 * a config saved before it reads as these defaults.
 */
export const loreConfigSchema = z.object({
  /** A lore_suggest sweep after each completed regular-season round. */
  roundSweep: z.boolean().default(true),
  /** Per kind of round suggestion: ask (wait in 제안함), auto (apply at once) or off; left out = ask. */
  suggest: z.partialRecord(z.enum(SUGGESTION_KINDS), suggestionModeSchema).default({}),
})

// ── The wiki ─────────────────────────────────────────────────────────────

/**
 * The wiki's settings. Added after config v4 with defaults, so an older
 * config reads as these.
 */
export const wikiConfigSchema = z.object({
  /**
   * Edit wars: how much editors must disagree before they fight over a
   * section ('often' takes less). Off: they never war, and never undo your
   * edits; they still answer in 토론.
   */
  editWars: z.enum(['off', 'sometimes', 'often']).default('sometimes'),
})

// ── The whole config ─────────────────────────────────────────────────────

export const leagueConfigSchema = z.object({
  version: z.literal(CONFIG_VERSION),
  league: z.object({
    name: nameSchema,
    shortName: z.string().trim().max(20),
  }),
  structure: structureSchema,
  roster: rosterSchema,
  ratings: ratingsSchema,
  playerFields: playerFieldsSchema,
  stats: statsSchema,
  season: seasonSchema,
  awards: awardsSchema,
  trades: tradesSchema,
  draft: draftSchema,
  gm: gmSchema,
  community: communitySchema,
  lore: loreConfigSchema.default({ roundSweep: true, suggest: {} }),
  ai: aiConfigSchema.default(() => ({ jobs: defaultAiJobs() })),
  wiki: wikiConfigSchema.default(() => ({ editWars: 'sometimes' as const })),
})

export type LeagueConfig = z.infer<typeof leagueConfigSchema>
export type Conference = z.infer<typeof conferenceSchema>
export type Division = z.infer<typeof divisionSchema>
export type Slot = z.infer<typeof slotSchema>
export type RatingColumn = z.infer<typeof ratingColumnSchema>
export type GradeStep = z.infer<typeof gradeStepSchema>
export type Tiebreaker = z.infer<typeof tiebreakerSchema>
export type SeasonAward = z.infer<typeof seasonAwardSchema>
export type PeriodicAward = z.infer<typeof periodicAwardSchema>
export type CardTier = z.infer<typeof cardTierSchema>
export type Board = z.infer<typeof boardSchema>
export type BoardRole = z.infer<typeof boardRoleSchema>
export type CommunityConfig = z.infer<typeof communitySchema>
export type LoreConfig = z.infer<typeof loreConfigSchema>
export type WikiConfig = z.infer<typeof wikiConfigSchema>
export type ModelName = z.infer<typeof modelSchema>
export type EffortSetting = z.infer<typeof effortSchema>
/** What a job passes to Claude Code: 'default' means no --effort at all. */
export type EffortLevel = Exclude<EffortSetting, 'default'>
export type AiConfig = z.infer<typeof aiConfigSchema>

/** One job's model and effort, ready for a job's input (effort left out when it's Claude Code's default). */
export function aiFor(config: { ai: AiConfig }, job: AiJob): { model: ModelName; effort?: EffortLevel } {
  const j = config.ai.jobs[job]
  return j.effort === 'default' ? { model: j.model } : { model: j.model, effort: j.effort }
}
export type DraftConfig = z.infer<typeof draftSchema>
export type CardSwapDraft = z.infer<typeof cardSwapDraftSchema>
export type TeamControl = z.infer<typeof teamControlSchema>
export type Phase = z.infer<typeof phaseSchema>
export type StatColumn = z.infer<typeof statColumnSchema>
export type StatMeaning = z.infer<typeof statMeaningSchema>
