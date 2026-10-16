import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Api, AppInfo, ApiChannel, DialogLabels, DraftMoveInput, ScoreInput } from '@shared/api'
import { communitySchema, gmSchema, leagueConfigSchema, loreConfigSchema, suggestionModeSchema, aiConfigSchema, wikiConfigSchema } from '@shared/config/schema'
import { awardsSchema, calendarSchema, draftSchema, playoffsSchema, rosterSchema, scheduleSchema, standingsSchema, structureSchema, tradesSchema } from '@shared/config/schema'
import type { SchoolFolderMove } from '@shared/backups'
import type { LeagueSettingsInput } from '@shared/settings'
import { cardsExpiring, settingsState } from '@data/settings'
import { followSchoolNames, formerSchoolNames, saveLeagueSettings } from './leagueSettings'
import { SUGGESTION_KINDS, type DraftRequest } from '@shared/suggestions'
import { importMappingSchema } from '@shared/import'
import type { TradeItem } from '@shared/season'
import { SetupError, teamSchema } from '@shared/setup'
import { leaders, seasonTotals } from '@core/stats'
import type { Db } from '@data/db'
import { jobError, recentJobs, sqliteJobStore } from '@data/jobs'
import { MIGRATIONS } from '@data/migrations'
import { factsStamp, loadConfig, seasonFor, updateConfig } from '@data/league'
import {
  applyTrade,
  closeProtection,
  vetoDraftSwap,
  draftMove,
  draftView,
  finishDraft,
  giveAward,
  listAwards,
  listCards,
  listChecklist,
  listTrades,
  markApplied,
  previewTrade,
  removeAward,
  startNextSeason,
  vetoTrade,
} from '@data/moves'
import { RuleError } from '@data/rules'
import { boxLines, finishPlayoffs, listGames, playoffsView, recordScore, seasonBoxLines, standings, startPlayoffs, startSeason, unrecordGame } from '@data/season'
import { addScheduledGame, clearRound, fillRound, flipScheduledGame, removeScheduledGame, scheduleInfo, scheduleOptions } from '@data/schedule'
import { addPlayedGame, closeSession, playedPairs } from '@data/played'
import { forgetLore } from '@story/context'
import { tradeIsBlockbuster } from '@sim/gm'
import type { AppContext } from './context'
import { listBackups } from './backup'
import { AppError } from './errors'
import { exportLeague } from './exporter'
import { listLoreSnapshots, loreSnapshotPath, restoreLoreSnapshot } from './loreSnapshots'
import { DELETED_DIR, isValidSlug } from './leagues'
import { latestScreenshots } from './gameday'
import { syncLoreFolder } from './lore'
import { editRoster } from './roster'
import type { ConfirmInput } from '@shared/gameday'
import type { LoreCreateTarget, LoreSaveInput } from '@shared/lore'
import type { PlayerEdit } from '@shared/roster'

/** What the handlers need from Electron, injected so they can be tested without it. */
export interface HandlerDeps {
  context(): AppContext
  appInfo(): AppInfo
  pickFile(kind: 'spreadsheet' | 'template', labels: DialogLabels): Promise<string | null>
  pickFolder(labels: DialogLabels): Promise<string | null>
  openFolder(path: string): void
  /** Shows one file selected in Explorer. */
  showItem(path: string): void
  switchDataDir(dir: string): AppInfo
}

type Handler<K extends ApiChannel> = (...args: unknown[]) => ReturnType<Api[K]> | Promise<ReturnType<Api[K]>>
export type Handlers = { [K in ApiChannel]: Handler<K> }

/** Roster edits: the engine checks every value against the league's rules (ranges, grades, names, slots). */
const rosterEditsSchema = z
  .array(
    z.object({
      playerId: z.string().min(1).max(64),
      name: z.string().max(200).optional(),
      height: z.string().max(200).optional(),
      nicknames: z.array(z.string().max(200)).max(50).optional(),
      notes: z.string().max(10_000).optional(),
      ratings: z.record(z.string().max(64), z.union([z.number(), z.string().max(10), z.null()])).optional(),
      slotId: z.string().min(1).max(64).nullable().optional(),
    }),
  )
  .max(1000)
  .refine((list) => new Set(list.map((e) => e.playerId)).size === list.length, 'one edit per player')

/** A lore file path as the editor sends it; the service checks it stays inside the lore folder. */
const loreFileSchema = z.string().min(1).max(400)
const backupIdSchema = z.string().min(1).max(60)
/** A database backup's file name or a lore snapshot's folder name; the backup code checks it names one. */
const backupIdArg = z.string().min(1).max(120)
const loreSections = z.object({ public: z.string().max(200_000), rumor: z.string().max(200_000), secret: z.string().max(200_000) })
const loreEditable = z.object({ kind: z.enum(['player', 'team', 'gm', 'world']), settings: z.record(z.string(), z.unknown()), sections: loreSections })
const loreSaveSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('form'), file: loreFileSchema, base: loreEditable, next: loreEditable, overwrite: z.boolean().optional() }),
  z.object({ mode: z.literal('raw'), file: loreFileSchema, version: z.string().max(80), text: z.string().max(1_000_000), force: z.boolean().optional() }),
])
const loreTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('player'), playerId: z.string().min(1).max(40) }),
  z.object({ kind: z.literal('team'), teamId: z.string().min(1).max(40) }),
  z.object({ kind: z.literal('gm'), teamId: z.string().min(1).max(40) }),
  z.object({ kind: z.literal('world'), title: z.string().max(60) }),
])

const suggestionTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('player'), playerId: z.string().min(1).max(40) }),
  z.object({ kind: z.literal('team'), teamId: z.string().min(1).max(40) }),
  z.object({ kind: z.literal('gm'), teamId: z.string().min(1).max(40) }),
])
const draftRequestSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('league') }),
  z.object({ scope: z.literal('team'), teamId: z.string().min(1).max(40) }),
  z.object({ scope: z.literal('one'), target: suggestionTargetSchema, hint: z.string().max(2000).optional() }),
])
/** A card as you edited it: shape only here; the service checks and clamps every value for the file's kind. */
const lorePatchSchema = z.object({
  traits: z.record(z.string().max(30), z.number()).optional(),
  media: z.string().max(30).optional(),
  name: z.string().max(60).optional(),
  philosophy: z.string().max(30).optional(),
  negotiation: z.string().max(30).optional(),
  fans: z.record(z.string().max(20), z.number()).optional(),
  rivals: z.array(z.string().max(60)).max(10).optional(),
  relationships: z
    .array(z.object({ with: z.string().max(80), type: z.string().max(20), strength: z.number(), visibility: z.string().max(20) }))
    .max(20)
    .optional(),
  // Room for a long secret's reveal: the service refuses text longer than the secret itself.
  public: z.string().max(20000).optional(),
  rumor: z.string().max(20000).optional(),
  nicknames: z.array(z.string().max(60)).max(10).optional(),
  /** A reveal only: what you keep in 비밀 in place of the card's text. */
  keepSecret: z.string().max(20000).optional(),
})

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new AppError('invalid-input', `${what}: ${first?.path.join('.') ?? ''} ${first?.message ?? ''}`.trim())
  }
  return result.data
}

const labelsSchema = z.object({ title: z.string().max(200), filterName: z.string().max(100) })
const slugSchema = z.string().min(1).max(60)
const wikiTitleSchema = z.string().trim().min(1).max(100)
const threadIdSchema = z.number().int().min(1)
const pathSchema = z.string().min(1).max(1000)
const idSchema = z.number().int().min(1)
/** A season a read asks for; left out, the current one. */
const seasonIdSchema = idSchema.optional()
const roundSchema = z.number().int().min(1).max(1000)
/** The wizard's config before the league is named. */
const baseSchema = z.object({
  config: leagueConfigSchema.extend({ league: z.object({ name: z.string().max(80), shortName: z.string().max(20) }) }),
  teams: z.array(teamSchema).optional(),
})
const tradeItemsSchema = z
  .array(
    z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('player'),
        playerId: z.string().min(1),
        from: z.string().min(1),
        to: z.string().min(1),
        toSlotId: z.string().nullable().optional(),
      }),
      z.object({ kind: z.literal('card'), cardId: idSchema, from: z.string().min(1), to: z.string().min(1) }),
    ]),
  )
  .max(40)
const scoreSchema = z.object({
  gameId: idSchema,
  homeScore: z.number().int(),
  awayScore: z.number().int(),
  lines: z
    .array(z.object({ playerId: z.string().min(1), teamId: z.string().min(1), stats: z.record(z.string(), z.number()) }))
    .max(60)
    .nullable(),
})
const draftMoveSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('protect'), teamId: z.string(), playerId: z.string() }),
  z.object({ kind: z.literal('swap'), teamId: z.string(), cardId: idSchema, playerId: z.string(), targetPlayerId: z.string() }),
  z.object({ kind: z.literal('pass'), teamId: z.string(), cardId: idSchema }),
])
const awardSchema = z.object({
  awardId: z.string().min(1),
  period: z.string().max(8),
  teamRank: z.number().int(),
  playerId: z.string().min(1),
})
/** 리그 설정: the config parts it edits and every team; the engine checks timing and runs the wizard's setup check. */
const settingsInputSchema = z.object({
  structure: structureSchema,
  // The config check holds each label to its own limit.
  ratingLabels: z.record(z.string().max(64), z.string().max(100)),
  roster: rosterSchema,
  schedule: scheduleSchema,
  calendar: calendarSchema,
  standings: standingsSchema,
  playoffs: playoffsSchema,
  awards: awardsSchema,
  trades: tradesSchema,
  draft: draftSchema,
  teams: z.array(teamSchema).max(500),
})

/** League engine refusals become 'rule' errors the screens can explain. */
function engine<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (e instanceof RuleError) throw new AppError('rule', e.message, { rules: e.issues })
    throw e
  }
}

/** The preload-only channel: opens a file the user dropped on the window. */
export function openDroppedHandler(deps: Pick<HandlerDeps, 'context'>) {
  return (path: unknown) => {
    const p = parse(pathSchema, path, 'path')
    deps.context().importer.grant(p)
    return deps.context().importer.open(p)
  }
}

export function createHandlers(deps: HandlerDeps): Handlers {
  const ctx = () => deps.context()
  const db = (slug: unknown): Db => ctx().leagues.dbFor(parse(slugSchema, slug, 'slug'))
  /** Steps that are hard to undo get a backup first (`fresh`: always a new one, see backupLeague). */
  const guarded = <T>(slug: unknown, reason: string, fn: (d: Db) => T, options: { fresh?: boolean } = {}): T => {
    const s = parse(slugSchema, slug, 'slug')
    ctx().leagues.backup(s, reason, options)
    return engine(() => fn(ctx().leagues.dbFor(s)))
  }
  /** The season id a read is for: the one asked for (an unknown id is refused), else the current one. */
  const seasonOf = (d: Db, seasonId?: unknown) => engine(() => seasonFor(d, parse(seasonIdSchema, seasonId, 'season')).id)
  /** A season id to hand on to a data function that defaults to the current season, checked the same way. */
  const seasonArg = (d: Db, seasonId: unknown): number | undefined => (seasonId === undefined ? undefined : seasonOf(d, seasonId))

  return {
    'app.info': () => deps.appInfo(),
    'app.openDataFolder': (slug) => {
      if (slug === undefined) return deps.openFolder(ctx().dataDir)
      const s = parse(slugSchema, slug, 'slug')
      if (!isValidSlug(s)) throw new AppError('invalid-input', `bad league folder name: ${s}`)
      deps.openFolder(join(ctx().dataDir, s))
    },
    'app.chooseDataFolder': async (labels) => {
      const dir = await deps.pickFolder(parse(labelsSchema, labels, 'labels'))
      return dir === null ? null : deps.switchDataDir(dir)
    },

    'leagues.list': () => ctx().leagues.list(),
    'leagues.inspect': (slug) => ctx().leagues.inspect(parse(slugSchema, slug, 'slug')),
    'leagues.create': (input) =>
      ctx().leagues.create(
        parse(
          z.object({
            slug: slugSchema,
            // Shape only; LeagueService runs the full cross-check and reports issues.
            setup: z.object({ config: z.unknown(), teams: z.unknown(), players: z.unknown() }),
            saveTemplate: z.object({ name: z.string().trim().min(1).max(80), includePlayers: z.boolean() }).nullable(),
            importMapping: importMappingSchema.nullable(),
          }),
          input,
          'create',
        ) as Parameters<Api['leagues.create']>[0],
      ),
    'leagues.remove': (slug) => {
      const s = parse(slugSchema, slug, 'slug')
      const folder = ctx().leagues.folderOf(s)
      const result = ctx().leagues.remove(s)
      forgetLore(folder)
      return result
    },
    'leagues.openDeleted': () => {
      const dir = join(ctx().dataDir, DELETED_DIR)
      deps.openFolder(existsSync(dir) ? dir : ctx().dataDir)
    },
    'leagues.snapshot': (slug) => ctx().leagues.snapshot(parse(slugSchema, slug, 'slug')),
    'leagues.stamp': (slug) => ({ stamp: factsStamp(db(slug)) }),
    'leagues.exportTemplate': (slug, options) =>
      ctx().leagues.exportTemplate(
        parse(slugSchema, slug, 'slug'),
        parse(z.object({ name: z.string().trim().min(1).max(80), includePlayers: z.boolean() }), options, 'options'),
      ),
    'leagues.exportExcel': (slug, labels, scope) => {
      const s = parse(slugSchema, slug, 'slug')
      const l = parse(z.record(z.string(), z.string().max(80)), labels, 'labels')
      const sc = parse(z.enum(['current', 'all']).optional(), scope, 'scope') ?? 'current'
      return { path: exportLeague(ctx().leagues.dbFor(s), ctx().leagues.folderOf(s), s, l, sc) }
    },
    'leagues.backup': (slug) => ({ path: ctx().leagues.backup(parse(slugSchema, slug, 'slug'), 'manual') ?? '' }),
    'backups.list': (slug) => {
      const folder = ctx().leagues.folderOf(parse(slugSchema, slug, 'slug'))
      return { db: listBackups(folder), lore: listLoreSnapshots(folder), hasLore: existsSync(join(folder, 'lore')), schema: MIGRATIONS.length }
    },
    // One synchronous step: nothing else reaches the league while its database is swapped.
    'backups.restore': (slug, id) => {
      const s = parse(slugSchema, slug, 'slug')
      const result = engine(() => ctx().leagues.restore(s, parse(backupIdArg, id, 'backup')))
      // Player files in a school folder that just moved back follow the restored rosters too.
      if (result.schools.length > 0) {
        try {
          syncLoreFolder(ctx().leagues.dbFor(s), ctx().leagues.folderOf(s))
        } catch (e) {
          console.warn('[lore] moving files after a restore failed', e)
        }
      }
      return result
    },
    'backups.restoreLore': (slug, id) => {
      const s = parse(slugSchema, slug, 'slug')
      const d = ctx().leagues.dbFor(s)
      const folder = ctx().leagues.folderOf(s)
      const { safety, kept } = engine(() => restoreLoreSnapshot(folder, parse(backupIdArg, id, 'snapshot')))
      forgetLore(folder)
      // Folders of schools renamed since the snapshot take the names they have now; then player files follow
      // today's rosters, as on any open.
      let schools: SchoolFolderMove[] = []
      try {
        schools = followSchoolNames(d, folder, formerSchoolNames(d))
      } catch (e) {
        console.warn('[lore] moving school folders after a restore failed', e)
      }
      let moved = 0
      try {
        moved = syncLoreFolder(d, folder).moved.length
      } catch (e) {
        console.warn('[lore] moving files after a restore failed', e)
      }
      return { safety, moved, schools, kept }
    },
    'backups.openLore': (slug, id) => {
      const s = parse(slugSchema, slug, 'slug')
      deps.openFolder(engine(() => loreSnapshotPath(ctx().leagues.folderOf(s), parse(backupIdArg, id, 'snapshot'))))
    },
    'leagues.settingsState': (slug) => settingsState(db(slug)),
    'leagues.saveSettings': (slug, input) => {
      const s = parse(slugSchema, slug, 'slug')
      const i = parse(settingsInputSchema, input, 'settings') as LeagueSettingsInput
      // Cards that expire are gone for good: a copy from just before, even within a burst of saves.
      const fresh = cardsExpiring(db(s), i) > 0
      const result = guarded(
        s,
        'settings',
        (d) => {
          try {
            return saveLeagueSettings(d, ctx().leagues.folderOf(s), i)
          } catch (e) {
            // The wizard's setup check refused it: its issues are translated like the wizard's.
            if (e instanceof SetupError) throw new AppError('invalid-setup', e.message, { issues: e.issues })
            throw e
          }
        },
        { fresh },
      )
      // A team handed to the AI GMs (or taken back) mid-draft: they pick up its turns, or stop at it.
      try {
        ctx().gm.reconcileDraft(s, ctx().leagues.dbFor(s), ctx().leagues.folderOf(s))
      } catch (e) {
        console.warn('[gm] catching up after a settings change failed', e)
      }
      return result
    },

    'templates.list': () => ctx().templates.list(),
    'templates.load': (id) => ctx().templates.load(parse(z.string().min(1).max(300), id, 'id')),
    'templates.openFile': async (labels) => {
      const file = await deps.pickFile('template', parse(labelsSchema, labels, 'labels'))
      return file === null ? null : ctx().templates.loadFile(file)
    },

    'import.chooseFile': async (labels) => {
      const file = await deps.pickFile('spreadsheet', parse(labelsSchema, labels, 'labels'))
      if (file === null) return null
      ctx().importer.grant(file)
      return ctx().importer.open(file)
    },
    'import.analyze': (input) => {
      const i = parse(
        z.object({
          path: pathSchema,
          sheet: z.string(),
          headerRow: z.number().int().min(1).optional(),
          base: baseSchema,
          templateMapping: importMappingSchema.optional(),
        }),
        input,
        'analyze',
      )
      return ctx().importer.analyze(i.path, i.sheet, i.headerRow, i.base.config, i.templateMapping)
    },
    'import.run': (input) => {
      const i = parse(z.object({ path: pathSchema, mapping: importMappingSchema, base: baseSchema }), input, 'import')
      return ctx().importer.run(i.path, i.mapping, i.base)
    },

    'season.start': (slug) => guarded(slug, 'season-start', (d) => startSeason(d)),
    'season.games': (slug, seasonId) => {
      const d = db(slug)
      return listGames(d, seasonOf(d, seasonId))
    },
    'season.boxScore': (slug, gameId) => boxLines(db(slug), parse(idSchema, gameId, 'game')),
    'season.recordScore': (slug, input) => {
      const d = db(slug)
      return engine(() => recordScore(d, parse(scoreSchema, input, 'score') as ScoreInput))
    },
    // Box lines go with it: a backup first.
    'season.unrecord': (slug, gameId) => guarded(slug, 'unrecord', (d) => unrecordGame(d, parse(idSchema, gameId, 'game'))),
    'season.standings': (slug, seasonId) => {
      const d = db(slug)
      return standings(d, seasonArg(d, seasonId))
    },
    // A player's team in a past season is the one in his box lines (past rosters aren't stored).
    'season.leaders': (slug, minGames, seasonId) => {
      const d = db(slug)
      const min = parse(z.number().int().min(0).max(200), minGames, 'minGames')
      return leaders(loadConfig(d).config, seasonTotals(seasonBoxLines(d, seasonOf(d, seasonId))), min)
    },
    'season.startPlayoffs': (slug) => guarded(slug, 'playoffs-start', (d) => startPlayoffs(d)),
    'schedule.info': (slug, seasonId) => {
      const d = db(slug)
      return scheduleInfo(d, seasonArg(d, seasonId))
    },
    'schedule.options': (slug, round, teamId) => {
      const d = db(slug)
      return engine(() => scheduleOptions(d, parse(roundSchema, round, 'round'), parse(z.string().min(1).max(60), teamId, 'team')))
    },
    'schedule.add': (slug, input) => {
      const d = db(slug)
      return engine(() => addScheduledGame(d, parse(z.object({ round: roundSchema, home: z.string().min(1).max(60), away: z.string().min(1).max(60) }), input, 'game')))
    },
    'schedule.remove': (slug, gameId) => {
      const d = db(slug)
      return engine(() => removeScheduledGame(d, parse(idSchema, gameId, 'game')))
    },
    'schedule.flip': (slug, gameId) => {
      const d = db(slug)
      return engine(() => flipScheduledGame(d, parse(idSchema, gameId, 'game')))
    },
    'schedule.fill': (slug, round) => {
      const d = db(slug)
      return engine(() => fillRound(d, parse(roundSchema, round, 'round')))
    },
    // Clearing removes several games at once: a backup first.
    'schedule.clear': (slug, round) => guarded(slug, 'schedule-clear', (d) => clearRound(d, parse(roundSchema, round, 'round'))),
    // 2K 일정대로: the picker's pairs, a game just played, and 오늘 경기 끝 (round-ups and the rest follow it: a backup first).
    'schedule.pairs': (slug) => {
      const d = db(slug)
      return engine(() => playedPairs(d))
    },
    'schedule.addPlayed': (slug, input) => {
      const d = db(slug)
      return engine(() => addPlayedGame(d, parse(z.object({ home: z.string().min(1).max(60), away: z.string().min(1).max(60) }), input, 'game')))
    },
    'schedule.closeSession': (slug) => guarded(slug, 'session-close', (d) => closeSession(d)),
    'season.playoffs': (slug, seasonId) => {
      const d = db(slug)
      return playoffsView(d, seasonArg(d, seasonId))
    },
    'season.finishPlayoffs': (slug) => guarded(slug, 'playoffs-end', (d) => finishPlayoffs(d)),
    'season.next': (slug, label) =>
      guarded(slug, 'next-season', (d) => void startNextSeason(d, parse(z.string().trim().min(1).max(80), label, 'label'))),

    'trades.preview': (slug, items) => {
      const d = db(slug)
      return engine(() => previewTrade(d, parse(tradeItemsSchema, items, 'trade') as TradeItem[]))
    },
    'trades.apply': (slug, items, note) => {
      const s = parse(slugSchema, slug, 'slug')
      const d = ctx().leagues.dbFor(s)
      const parsed = parse(tradeItemsSchema, items, 'trade') as TradeItem[]
      const text = parse(z.string().max(500), note, 'note')
      // A trade that moves a star is tagged for the story engine, read before the rosters change.
      const blockbuster = tradeIsBlockbuster(d, ctx().leagues.folderOf(s), parsed)
      return { tradeId: engine(() => applyTrade(d, parsed, 'user', text, blockbuster ? { blockbuster } : undefined)) }
    },
    'trades.veto': (slug, tradeId) => guarded(slug, 'veto', (d) => vetoTrade(d, parse(idSchema, tradeId, 'trade'))),
    'trades.list': (slug, seasonId) => {
      const d = db(slug)
      return listTrades(d, seasonOf(d, seasonId))
    },
    'cards.list': (slug, seasonId) => {
      const d = db(slug)
      return listCards(d, seasonOf(d, seasonId))
    },
    'checklist.list': (slug) => listChecklist(db(slug)),
    'checklist.apply': (slug, id) => {
      const d = db(slug)
      engine(() => markApplied(d, parse(idSchema, id, 'checklist')))
    },

    'draft.view': (slug, seasonId) => {
      const d = db(slug)
      const season = seasonArg(d, seasonId)
      return engine(() => draftView(d, season))
    },
    'draft.move': (slug, move) => {
      const m = parse(draftMoveSchema, move, 'move') as DraftMoveInput
      // Swaps move players; keep a copy of the league from just before.
      if (m.kind === 'swap') return guarded(slug, 'draft-swap', (d) => ({ actionId: draftMove(d, m) }))
      const d = db(slug)
      return { actionId: engine(() => draftMove(d, m)) }
    },
    'draft.closeProtection': (slug) => guarded(slug, 'protection-end', (d) => closeProtection(d)),
    'draft.vetoSwap': (slug, actionId) => guarded(slug, 'draft-veto', (d) => vetoDraftSwap(d, parse(idSchema, actionId, 'action'))),
    'draft.finish': (slug) => guarded(slug, 'draft-end', (d) => finishDraft(d)),

    'awards.list': (slug, seasonId) => {
      const d = db(slug)
      return listAwards(d, seasonOf(d, seasonId))
    },
    'awards.give': (slug, input) => {
      const d = db(slug)
      const i = parse(awardSchema, input, 'award')
      return { id: engine(() => giveAward(d, i)) }
    },
    'awards.remove': (slug, id) => {
      const d = db(slug)
      engine(() => removeAward(d, parse(idSchema, id, 'award')))
    },

    'ai.status': (slug) => ctx().ai.settledView(slug === undefined ? undefined : parse(slugSchema, slug, 'slug')),
    'ai.recheck': () => ctx().ai.refresh(),
    'ai.recentJobs': (slug) => {
      const s = parse(slugSchema, slug, 'slug')
      return recentJobs(ctx().leagues.dbFor(s), 30, ctx().ai.retryable(s))
    },
    'ai.jobError': (slug, jobId) => {
      const found = jobError(db(slug), parse(idSchema, jobId, 'job'))
      if (!found) throw new AppError('not-found', 'job')
      return found
    },
    'ai.retryJob': (slug, jobId) => {
      const s = parse(slugSchema, slug, 'slug')
      const d = ctx().leagues.dbFor(s)
      const id = parse(idSchema, jobId, 'job')
      // A screenshot read goes through 경기일's own reread: the game still open, the screenshots still there.
      if (sqliteJobStore(d).get(id)?.kind === 'read_box_score') return engine(() => ctx().gameday.retry(s, d, ctx().leagues.folderOf(s), id))
      return engine(() => ctx().ai.retry(s, d, ctx().leagues.folderOf(s), id))
    },
    'ai.cancelJob': (slug, jobId) => {
      const s = parse(slugSchema, slug, 'slug')
      const d = ctx().leagues.dbFor(s)
      const id = parse(idSchema, jobId, 'job')
      engine(() => ctx().ai.cancel(s, d, ctx().leagues.folderOf(s), id))
    },
    'ai.cancelWaiting': (slug, kind) => {
      const s = parse(slugSchema, slug, 'slug')
      const k = parse(z.string().regex(/^[a-z_]{1,40}$/), kind, 'kind')
      return ctx().ai.cancelWaiting(s, ctx().leagues.dbFor(s), ctx().leagues.folderOf(s), k)
    },
    'ai.resume': (slug) => {
      const s = parse(slugSchema, slug, 'slug')
      return ctx().ai.resume(s, ctx().leagues.dbFor(s), ctx().leagues.folderOf(s))
    },
    'gameday.saveImage': (slug, bytes) => {
      const s = parse(slugSchema, slug, 'slug')
      return ctx().gameday.saveImage(ctx().leagues.folderOf(s), parse(z.instanceof(Uint8Array), bytes, 'image'))
    },
    'gameday.discardImage': (slug, token) => {
      const s = parse(slugSchema, slug, 'slug')
      ctx().gameday.discardImage(ctx().leagues.folderOf(s), parse(z.string().max(80), token, 'token'))
    },
    'gameday.read': (slug, gameId, tokens) => {
      const s = parse(slugSchema, slug, 'slug')
      const d = ctx().leagues.dbFor(s)
      const g = parse(idSchema, gameId, 'game')
      const tk = parse(z.array(z.string().max(80)).max(4), tokens, 'tokens')
      return engine(() => ctx().gameday.read(s, d, ctx().leagues.folderOf(s), g, tk))
    },
    'gameday.job': (slug, jobId) => ctx().gameday.job(db(slug), parse(idSchema, jobId, 'job')),
    'gameday.jobs': (slug, gameId) => {
      const s = parse(slugSchema, slug, 'slug')
      return ctx().gameday.jobs(s, ctx().leagues.dbFor(s), ctx().leagues.folderOf(s), parse(idSchema, gameId, 'game'))
    },
    'gameday.retry': (slug, jobId) => {
      const s = parse(slugSchema, slug, 'slug')
      const d = ctx().leagues.dbFor(s)
      const j = parse(idSchema, jobId, 'job')
      return engine(() => ctx().gameday.retry(s, d, ctx().leagues.folderOf(s), j))
    },
    'gameday.confirmView': (slug, jobId, flip) => {
      const d = db(slug)
      const f = parse(z.boolean().optional(), flip, 'flip') ?? false
      return engine(() => ctx().gameday.confirmView(d, parse(idSchema, jobId, 'job'), f))
    },
    'gameday.confirm': (slug, input) => {
      const d = db(slug)
      const i = parse(
        z.object({
          jobId: idSchema,
          gameId: idSchema,
          homeScore: z.number().int(),
          awayScore: z.number().int(),
          lines: z.array(z.object({ playerId: z.string(), teamId: z.string(), stats: z.record(z.string(), z.number()) })).max(60),
          names: z.array(z.object({ teamId: z.string(), source: z.string().max(80), playerId: z.string(), row: z.number().int().min(0) })).max(60),
        }),
        input,
        'confirm',
      ) as ConfirmInput
      return engine(() => ctx().gameday.confirm(d, i))
    },
    'gameday.shots': (slug, jobId) => ({ files: ctx().gameday.shots(db(slug), parse(idSchema, jobId, 'job')) }),

    'community.status': (slug) => {
      const s = parse(slugSchema, slug, 'slug')
      return ctx().story.status(s, ctx().leagues.dbFor(s))
    },
    'community.latest': (slug) => {
      const s = parse(slugSchema, slug, 'slug')
      return ctx().story.front(ctx().leagues.dbFor(s), ctx().leagues.folderOf(s))
    },
    'community.board': (slug, boardId, page) => {
      const s = parse(slugSchema, slug, 'slug')
      const b = parse(z.string().min(1).max(40), boardId, 'board')
      const p = parse(z.number().int().min(1).max(100000), page, 'page')
      return engine(() => ctx().story.board(ctx().leagues.dbFor(s), ctx().leagues.folderOf(s), b, p))
    },
    'community.post': (slug, postId, again) =>
      engine(() => ctx().story.post(db(slug), parse(idSchema, postId, 'post'), parse(z.boolean().optional(), again, 'again') ?? false)),
    'community.refresh': (slug) => {
      const s = parse(slugSchema, slug, 'slug')
      return engine(() => ctx().story.refresh(s, ctx().leagues.dbFor(s), ctx().leagues.folderOf(s)))
    },
    'community.write': (slug, input) => {
      const s = parse(slugSchema, slug, 'slug')
      const i = parse(
        z.object({
          boardId: z.string().min(1).max(40),
          title: z.string().max(200),
          body: z.string().max(20000),
          gameId: idSchema.optional(),
          // Shape only: the engine cleans the options and refuses a poll without 2–6 different ones.
          poll: z.object({ question: z.string().max(200), options: z.array(z.string().max(200)).max(20) }).optional(),
        }),
        input,
        'post',
      )
      return { postId: engine(() => ctx().story.writePost(s, ctx().leagues.dbFor(s), ctx().leagues.folderOf(s), i)) }
    },
    'community.comment': (slug, input) => {
      const s = parse(slugSchema, slug, 'slug')
      const i = parse(z.object({ postId: idSchema, parentId: idSchema.optional(), body: z.string().max(2000) }), input, 'comment')
      return { commentId: engine(() => ctx().story.writeComment(s, ctx().leagues.dbFor(s), ctx().leagues.folderOf(s), i)) }
    },
    'community.vote': (slug, target, id, value) =>
      engine(() =>
        ctx().story.vote(
          db(slug),
          parse(z.enum(['post', 'comment']), target, 'target'),
          parse(idSchema, id, 'id'),
          parse(z.union([z.literal(1), z.literal(-1)]), value, 'vote'),
        ),
      ),
    'community.pollVote': (slug, pollId, option) =>
      engine(() => ctx().story.pollVote(db(slug), parse(idSchema, pollId, 'poll'), parse(z.number().int().min(0).max(100), option, 'option'))),
    'community.news': (slug, input) => {
      const s = parse(slugSchema, slug, 'slug')
      const i = parse(z.object({ text: z.string().max(1000) }), input, 'news')
      return { eventId: engine(() => ctx().story.news(s, ctx().leagues.dbFor(s), ctx().leagues.folderOf(s), i.text)) }
    },
    'community.saveSettings': (slug, community) => {
      const s = parse(slugSchema, slug, 'slug')
      const c = parse(communitySchema, community, 'community')
      return guarded(s, 'config', (d) => ({ version: ctx().story.saveSettings(d, c) }))
    },
    'gameday.screenshotFolder': () => ({ folder: ctx().settings.read().screenshotFolder }),
    'gameday.chooseScreenshotFolder': async (labels) => {
      const dir = await deps.pickFolder(parse(labelsSchema, labels, 'labels'))
      if (dir !== null) ctx().settings.update((s) => void (s.screenshotFolder = dir))
      return { folder: ctx().settings.read().screenshotFolder }
    },
    'gameday.clearScreenshotFolder': () => void ctx().settings.update((s) => void (s.screenshotFolder = null)),
    'gameday.latestShots': (count) => {
      const folder = ctx().settings.read().screenshotFolder
      if (!folder) throw new AppError('not-found', 'no screenshot folder set')
      return { files: latestScreenshots(folder, parse(z.number().int().min(1).max(4), count, 'count')) }
    },
    'mood.team': (slug, teamId) => {
      const s = parse(slugSchema, slug, 'slug')
      return engine(() => ctx().story.lockerRoom(ctx().leagues.dbFor(s), ctx().leagues.folderOf(s), parse(z.string().min(1).max(40), teamId, 'team')))
    },
    'mood.player': (slug, playerId, seasonId) => {
      const s = parse(slugSchema, slug, 'slug')
      const p = parse(z.string().min(1).max(40), playerId, 'player')
      const season = parse(z.number().int().min(1).optional(), seasonId, 'season')
      return engine(() => ctx().story.playerState(ctx().leagues.dbFor(s), ctx().leagues.folderOf(s), p, season))
    },
    'wiki.home': (slug) => {
      const s = parse(slugSchema, slug, 'slug')
      return { title: engine(() => ctx().wiki.home(ctx().leagues.dbFor(s), ctx().leagues.folderOf(s))) }
    },
    'wiki.page': (slug, title, rev) => {
      const s = parse(slugSchema, slug, 'slug')
      const t = parse(wikiTitleSchema, title, 'title')
      const r = parse(z.number().int().min(1).optional(), rev, 'rev')
      return engine(() => ctx().wiki.page(ctx().leagues.dbFor(s), ctx().leagues.folderOf(s), t, r))
    },
    'wiki.save': (slug, input) => {
      const i = parse(
        z.object({ title: wikiTitleSchema, source: z.string().max(200_000), summary: z.string().max(200), baseRev: z.number().int().min(1).nullable() }),
        input,
        'wiki',
      )
      const s = parse(slugSchema, slug, 'slug')
      return engine(() => ctx().wiki.save(ctx().leagues.dbFor(s), i, { slug: s, folder: ctx().leagues.folderOf(s) }))
    },
    'wiki.history': (slug, title) => engine(() => ctx().wiki.history(db(slug), parse(wikiTitleSchema, title, 'title'))),
    'wiki.diff': (slug, title, from, to) => {
      const rev = z.number().int().min(1)
      return engine(() => ctx().wiki.diff(db(slug), parse(wikiTitleSchema, title, 'title'), parse(rev, from, 'from'), parse(rev, to, 'to')))
    },
    'wiki.recent': (slug) => ctx().wiki.recent(db(slug)),
    'wiki.backlinks': (slug, title) => ctx().wiki.backlinks(db(slug), parse(wikiTitleSchema, title, 'title')),
    'wiki.search': (slug, query) => ctx().wiki.search(db(slug), parse(z.string().max(100), query, 'query')),
    'wiki.random': (slug) => {
      const s = parse(slugSchema, slug, 'slug')
      return { title: engine(() => ctx().wiki.random(ctx().leagues.dbFor(s), ctx().leagues.folderOf(s))) }
    },
    'wiki.threads': (slug, title) => engine(() => ctx().wiki.threads(db(slug), parse(wikiTitleSchema, title, 'title'))),
    'wiki.thread': (slug, threadId) => engine(() => ctx().wiki.thread(db(slug), parse(threadIdSchema, threadId, 'thread'))),
    'wiki.recentThreads': (slug) => ctx().wiki.recentThreads(db(slug)),
    'wiki.openThread': (slug, input) => {
      const s = parse(slugSchema, slug, 'slug')
      const i = parse(z.object({ title: wikiTitleSchema, topic: z.string().max(200), body: z.string().max(5000) }), input, 'thread')
      return engine(() => ctx().wiki.openThread(ctx().leagues.dbFor(s), i, { slug: s, folder: ctx().leagues.folderOf(s) }))
    },
    'wiki.comment': (slug, threadId, body) => {
      const s = parse(slugSchema, slug, 'slug')
      const t = parse(threadIdSchema, threadId, 'thread')
      const b = parse(z.string().max(5000), body, 'body')
      return engine(() => ctx().wiki.comment(ctx().leagues.dbFor(s), t, b, { slug: s, folder: ctx().leagues.folderOf(s) }))
    },
    'wiki.setThread': (slug, threadId, open, note) => {
      const t = parse(threadIdSchema, threadId, 'thread')
      engine(() => ctx().wiki.setThread(db(slug), t, parse(z.boolean(), open, 'open'), parse(z.string().max(300), note, 'note')))
      return { ok: true as const }
    },
    'wiki.saveSettings': (slug, wiki) => ({ version: engine(() => ctx().wiki.saveSettings(db(slug), parse(wikiConfigSchema, wiki, 'wiki'))) }),
    'wiki.playerPagesPlan': (slug) => {
      const s = parse(slugSchema, slug, 'slug')
      return engine(() => ctx().story.playerPagesPlan(ctx().leagues.dbFor(s), ctx().leagues.folderOf(s)))
    },
    'wiki.polishPlayerPages': (slug) => {
      const s = parse(slugSchema, slug, 'slug')
      return engine(() => ctx().story.polishPlayerPages(s, ctx().leagues.dbFor(s), ctx().leagues.folderOf(s)))
    },
    'wiki.playerPagesStatus': (slug) => ctx().story.playerPagesStatus(db(slug)),
    'lore.index': (slug) => {
      const s = parse(slugSchema, slug, 'slug')
      return ctx().lore.index(ctx().leagues.dbFor(s), ctx().leagues.folderOf(s))
    },
    'lore.open': (slug, file) => {
      const s = parse(slugSchema, slug, 'slug')
      return ctx().lore.open(ctx().leagues.folderOf(s), parse(loreFileSchema, file, 'file'))
    },
    'roster.update': (slug, edits) => {
      const s = parse(slugSchema, slug, 'slug')
      const list = parse(rosterEditsSchema, edits, 'roster') as PlayerEdit[]
      return guarded(s, 'roster-edit', (d) => editRoster(d, ctx().leagues.folderOf(s), ctx().lore, list))
    },
    'lore.table': (slug) => {
      const s = parse(slugSchema, slug, 'slug')
      return ctx().lore.table(ctx().leagues.dbFor(s), ctx().leagues.folderOf(s))
    },
    'lore.save': (slug, input) => {
      const s = parse(slugSchema, slug, 'slug')
      const i = parse(loreSaveSchema, input, 'lore') as LoreSaveInput
      // Saving needs the league open (its folder); the database isn't touched.
      ctx().leagues.dbFor(s)
      return ctx().lore.save(ctx().leagues.folderOf(s), i)
    },
    'lore.create': (slug, target) => {
      const s = parse(slugSchema, slug, 'slug')
      return ctx().lore.create(ctx().leagues.dbFor(s), ctx().leagues.folderOf(s), parse(loreTargetSchema, target, 'target') as LoreCreateTarget)
    },
    'lore.createMissing': (slug) => {
      const s = parse(slugSchema, slug, 'slug')
      return ctx().lore.createMissing(ctx().leagues.dbFor(s), ctx().leagues.folderOf(s))
    },
    'lore.backupText': (slug, file, backupId) => {
      const s = parse(slugSchema, slug, 'slug')
      return { text: ctx().lore.backupText(ctx().leagues.folderOf(s), parse(loreFileSchema, file, 'file'), parse(backupIdSchema, backupId, 'backup')) }
    },
    'lore.restore': (slug, file, backupId) => {
      const s = parse(slugSchema, slug, 'slug')
      return ctx().lore.restore(ctx().leagues.folderOf(s), parse(loreFileSchema, file, 'file'), parse(backupIdSchema, backupId, 'backup'))
    },
    'lore.remove': (slug, file) => {
      const s = parse(slugSchema, slug, 'slug')
      ctx().lore.remove(ctx().leagues.folderOf(s), parse(loreFileSchema, file, 'file'))
    },
    'lore.reveal': (slug, file) => {
      const s = parse(slugSchema, slug, 'slug')
      deps.showItem(ctx().lore.fullPath(ctx().leagues.folderOf(s), parse(loreFileSchema, file, 'file')))
    },
    'lore.sync': (slug) => {
      const s = parse(slugSchema, slug, 'slug')
      return { moved: syncLoreFolder(ctx().leagues.dbFor(s), ctx().leagues.folderOf(s)).moved.length }
    },
    'suggestions.status': (slug) => ctx().suggestions.status(db(slug)),
    'suggestions.list': (slug, which) => {
      const s = parse(slugSchema, slug, 'slug')
      return ctx().suggestions.list(ctx().leagues.dbFor(s), ctx().leagues.folderOf(s), parse(z.enum(['pending', 'decided']), which, 'which'))
    },
    'suggestions.draft': (slug, request) => {
      const s = parse(slugSchema, slug, 'slug')
      const r = parse(draftRequestSchema, request, 'request') as DraftRequest
      return ctx().suggestions.draft(s, ctx().leagues.dbFor(s), ctx().leagues.folderOf(s), r)
    },
    'suggestions.approve': (slug, id, patch) => {
      const s = parse(slugSchema, slug, 'slug')
      const edited = patch === undefined || patch === null ? undefined : parse(lorePatchSchema, patch, 'patch')
      return ctx().suggestions.approve(ctx().leagues.dbFor(s), ctx().leagues.folderOf(s), parse(idSchema, id, 'id'), edited)
    },
    'suggestions.approveMany': (slug, ids) => {
      const s = parse(slugSchema, slug, 'slug')
      return ctx().suggestions.approveMany(ctx().leagues.dbFor(s), ctx().leagues.folderOf(s), parse(z.array(idSchema).max(500), ids, 'ids'))
    },
    'suggestions.reject': (slug, id) => ctx().suggestions.reject(db(slug), parse(idSchema, id, 'id')),
    'suggestions.setMode': (slug, kind, mode) => {
      const s = parse(slugSchema, slug, 'slug')
      const k = parse(z.enum(SUGGESTION_KINDS), kind, 'kind')
      const m = parse(suggestionModeSchema, mode, 'mode')
      // Secret reveals always ask: auto is refused.
      return engine(() => ctx().suggestions.setMode(ctx().leagues.dbFor(s), ctx().leagues.folderOf(s), k, m))
    },
    'gm.status': (slug) => {
      const s = parse(slugSchema, slug, 'slug')
      return ctx().gm.status(s, ctx().leagues.dbFor(s), ctx().leagues.folderOf(s))
    },
    'gm.windows': (slug) => ctx().gm.windows(db(slug)),
    'gm.list': (slug) => {
      const s = parse(slugSchema, slug, 'slug')
      return ctx().gm.gms(ctx().leagues.dbFor(s), ctx().leagues.folderOf(s))
    },
    'gm.openWindow': (slug) => {
      const s = parse(slugSchema, slug, 'slug')
      return ctx().gm.openWindow(s, ctx().leagues.dbFor(s), ctx().leagues.folderOf(s), 'manual', null)
    },
    'gm.approve': (slug, negotiationId) => {
      const s = parse(slugSchema, slug, 'slug')
      return engine(() => ctx().gm.approve(s, ctx().leagues.dbFor(s), ctx().leagues.folderOf(s), parse(idSchema, negotiationId, 'negotiation')))
    },
    'gm.decline': (slug, negotiationId) => ctx().gm.decline(db(slug), parse(idSchema, negotiationId, 'negotiation')),
    'gm.draftNotes': (slug) => ctx().gm.draftNotes(db(slug)),
    'gm.reconcileDraft': (slug) => {
      const s = parse(slugSchema, slug, 'slug')
      engine(() => ctx().gm.reconcileDraft(s, ctx().leagues.dbFor(s), ctx().leagues.folderOf(s), true))
    },
    'ai.saveJobs': (slug, ai) => {
      const s = parse(slugSchema, slug, 'slug')
      const a = parse(aiConfigSchema, ai, 'ai')
      return guarded(s, 'config', (d) => {
        const { config } = loadConfig(d)
        return { version: updateConfig(d, { ...config, ai: a }) }
      })
    },
    'gm.saveSettings': (slug, gm) => {
      const s = parse(slugSchema, slug, 'slug')
      const g = parse(gmSchema, gm, 'gm')
      return guarded(s, 'config', (d) => {
        const { config } = loadConfig(d)
        return { version: updateConfig(d, { ...config, gm: g }) }
      })
    },
    'suggestions.saveSettings': (slug, lore) => {
      const s = parse(slugSchema, slug, 'slug')
      const l = parse(loreConfigSchema, lore, 'lore')
      return guarded(s, 'config', (d) => ctx().suggestions.saveSettings(d, ctx().leagues.folderOf(s), l))
    },
  }
}

/** League moves the community reacts to: after each succeeds, new events become threads. */
export const STORY_TRIGGERS: readonly ApiChannel[] = [
  'season.start',
  'season.recordScore',
  'season.unrecord',
  'season.startPlayoffs',
  'season.finishPlayoffs',
  'season.next',
  // 2K 일정대로's 오늘 경기 끝: the session counts as a completed round (round-ups, wiki edits, the lore sweep, trade windows, polls).
  'schedule.closeSession',
  'trades.apply',
  'trades.veto',
  'draft.move',
  'draft.closeProtection',
  'draft.vetoSwap',
  'draft.finish',
  'awards.give',
  'awards.remove',
  // A starter sent to the bench (or the reverse) in 로스터 편집 moves moods and is news.
  'roster.update',
  'gameday.confirm',
  // An approved secret reveal is news (secret_revealed).
  'suggestions.approve',
]

/** Moves that change rosters: lore files follow the players to their new teams' folders. */
export const LORE_TRIGGERS: readonly ApiChannel[] = ['trades.apply', 'trades.veto', 'draft.move', 'draft.vetoSwap']

/**
 * Wraps the handlers so league moves are followed by lore files moving with
 * their players and by the community's reactions (never failing the move itself).
 */
export function withStory(handlers: Handlers, ctx: () => AppContext): Handlers {
  const out = { ...handlers } as Record<string, (...args: unknown[]) => unknown>
  for (const channel of STORY_TRIGGERS) {
    const inner = out[channel]!
    out[channel] = (...args: unknown[]) => {
      const result = inner(...args)
      const slug = args[0]
      const react = () => {
        if (typeof slug !== 'string') return
        if (LORE_TRIGGERS.includes(channel)) {
          try {
            const c = ctx()
            syncLoreFolder(c.leagues.dbFor(slug), c.leagues.folderOf(slug))
          } catch (e) {
            console.warn('[lore] moving files failed', e)
          }
        }
        try {
          const c = ctx()
          c.story.afterChange(slug, c.leagues.dbFor(slug), c.leagues.folderOf(slug))
        } catch (e) {
          console.warn('[story] reacting failed', e)
        }
      }
      if (result instanceof Promise) return result.then((v) => (react(), v))
      react()
      return result
    }
  }
  return out as Handlers
}
