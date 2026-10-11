import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MANUAL_RETRY_OF, type JobRow } from '@ai/queue'
import type { ConfirmInput, ConfirmView, GameRef, JobInfo } from '@shared/gameday'
import { transaction, validJson, type Db } from '@data/db'
import { listJobsByInput, sqliteJobStore } from '@data/jobs'
import { listPlayers, listTeams, loadConfig } from '@data/league'
import { learnedNames, learnNames } from '@data/namemap'
import { refuse } from '@data/rules'
import { getGame, recordScore, teamsWaitingOn2k } from '@data/season'
import { buildConfirmView, boxScoreReadSchema, readProblem, type BoxScoreRead, type BoxScoreJobInput } from '@ingest/boxscore'
import { englishStyleName, normalizeSource } from '@ingest/namemap'
import type { BoxIssue } from '@shared/season'
import { aiFor } from '@shared/config/schema'
import { FAKE_OUTPUT_FILE, type AiService } from './ai'
import { AppError } from './errors'

const MAX_IMAGE = 20 * 1024 * 1024
const MAX_SHOTS = 4
/** Screenshots jump the queue: they block the game you're entering. */
const PRIORITY_SCREENSHOT = 50
const READ_KIND = 'read_box_score'
/** What saveImage hands out; nothing else names a file in the inbox. */
const TOKEN = /^\d+-[0-9a-f]{8}\.(png|jpg)$/
/** How read() names screenshots in a game's folder. */
const SHOT_NAME = /^\d+\.(png|jpg)$/
/** Inbox screenshots nobody read (the window closed, the app crashed) go after a day. */
const INBOX_TTL_MS = 24 * 60 * 60 * 1000

function imageKind(bytes: Uint8Array): 'png' | 'jpg' | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  return null
}

const inboxOf = (leagueFolder: string) => join(leagueFolder, 'screenshots', 'inbox')

function checkToken(token: string): void {
  if (!TOKEN.test(token)) throw new AppError('invalid-input', `unknown screenshot ${token}`)
}

/** Deletes inbox screenshots older than a day. Best effort: a locked file stays for next time. */
function sweepInbox(inbox: string, now = Date.now()): void {
  if (!existsSync(inbox)) return
  for (const name of readdirSync(inbox)) {
    if (!TOKEN.test(name)) continue
    const file = join(inbox, name)
    try {
      if (now - statSync(file).mtimeMs > INBOX_TTL_MS) unlinkSync(file)
    } catch {
      // Gone already, or in use.
    }
  }
}

const gameOf = (job: JobRow): number | null => {
  const id = (job.input as { gameId?: unknown } | null)?.gameId
  return typeof id === 'number' ? id : null
}

type GameNow = NonNullable<ReturnType<typeof getGame>>

/**
 * Which game a reading is for, beyond its id: the season, stage, round,
 * series and the two teams (in either order, so ⇄ in 일정 keeps it). Ids are
 * no longer reused (migration 19), but a reading queued before that could
 * name an id a different game has since taken; it must not attach to it.
 */
export const gameKey = (g: GameNow): string => `${g.seasonId}:${g.stage}:${g.round}:${g.seriesId ?? ''}:${[g.home, g.away].sort().join('|')}`

/** The game a reading is for, if it's still that game (older readings carry no key and are taken at their word). */
function gameFor(db: Db, job: JobRow): GameNow | null {
  const id = gameOf(job)
  const game = id === null ? null : getGame(db, id)
  if (!game) return null
  const key = (job.input as Partial<BoxScoreJobInput>).gameKey
  return key === undefined || key === gameKey(game) ? game : null
}

const hashOf = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** The 2K checklist blocks recording a game while either team has a move to make there: say so before a read is spent. */
function waitingTeams(db: Db, game: GameNow): string[] {
  const waiting = teamsWaitingOn2k(db)
  return [game.home, game.away].filter((t) => waiting.has(t))
}

/**
 * Other games the same screenshots (by their bytes) were read for: each
 * reading keeps its images' hashes. Cancelled readings don't count, nor a
 * reading whose game is gone or is now a different game.
 */
export function gamesReadWith(db: Db, hashes: readonly string[], except: number): GameRef[] {
  if (hashes.length === 0) return []
  const rows = db
    .prepare(
      `SELECT DISTINCT j.id FROM jobs j, json_each(${validJson('j.input')}, '$.hashes') h
       WHERE j.kind = ? AND j.status <> 'cancelled' AND h.value IN (${hashes.map(() => '?').join(',')})`,
    )
    .all(READ_KIND, ...hashes) as { id: number }[]
  const store = sqliteJobStore(db)
  const out = new Map<number, GameRef>()
  for (const { id } of rows) {
    const job = store.get(id)
    const game = job ? gameFor(db, job) : null
    if (!game || game.id === except || out.has(game.id)) continue
    out.set(game.id, { id: game.id, stage: game.stage, round: game.round, home: game.home, away: game.away, status: game.status })
  }
  return [...out.values()]
}

/** Refuses screenshots that are already another recorded game's box score (기록 취소 there frees them). */
function refuseRecordedElsewhere(used: GameRef[]): void {
  const recorded = used.find((g) => g.status === 'final')
  if (recorded) refuse('screenshot-recorded', { stage: recorded.stage, round: recorded.round, teams: `${recorded.home}, ${recorded.away}` })
}

const toInfo = (job: JobRow): JobInfo => ({
  id: job.id,
  kind: job.kind,
  status: job.status,
  error: job.error,
  errorKind: job.errorKind,
  attempts: job.attempts,
  gameId: gameOf(job),
  createdAt: job.createdAt,
})

/** Screenshots older than this aren't "the game you just played". */
const LATEST_WINDOW_MS = 6 * 3600_000

/**
 * The newest PNG/JPEG files in the screenshot folder (not its subfolders),
 * taken in the last few hours, newest first.
 */
export function latestScreenshots(folder: string, count: number, nowMs = Date.now()): { name: string; bytes: Uint8Array }[] {
  if (!existsSync(folder)) throw new AppError('not-found', 'screenshot folder')
  const files = readdirSync(folder)
    .filter((n) => /\.(png|jpe?g)$/i.test(n))
    .map((n) => {
      try {
        const st = statSync(join(folder, n))
        return st.isFile() && st.size <= MAX_IMAGE ? { name: n, mtime: st.mtimeMs } : null
      } catch {
        return null
      }
    })
    .filter((f): f is { name: string; mtime: number } => f !== null && nowMs - f.mtime <= LATEST_WINDOW_MS)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, Math.max(1, Math.min(4, count)))
  return files.map((f) => ({ name: f.name, bytes: new Uint8Array(readFileSync(join(folder, f.name))) }))
}

/** Pasted or dropped screenshots → a reading job → the confirm screen → a recorded game. */
export class GameDayService {
  constructor(private readonly ai: AiService) {}

  /** Saves one screenshot into the league's inbox and returns its token (file name). */
  saveImage(leagueFolder: string, bytes: Uint8Array): { token: string } {
    // Their own codes, so the screen can say what's wrong (a WebP or HEIC file, a huge one).
    if (bytes.byteLength > MAX_IMAGE) throw new AppError('image-too-large', 'image too large')
    const kind = imageKind(bytes)
    if (!kind) throw new AppError('image-type', 'not a PNG or JPEG image')
    const dir = inboxOf(leagueFolder)
    mkdirSync(dir, { recursive: true })
    sweepInbox(dir)
    const token = `${Date.now()}-${randomBytes(4).toString('hex')}.${kind}`
    writeFileSync(join(dir, token), bytes)
    return { token }
  }

  /** Deletes a screenshot the user took back (or one over the limit) from the inbox. */
  discardImage(leagueFolder: string, token: string): void {
    checkToken(token)
    try {
      unlinkSync(join(inboxOf(leagueFolder), token))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }

  /**
   * Moves the screenshots into a folder for this game and queues the reading
   * job. Everything that would stop the game being recorded is checked first,
   * so no read is spent on it: the game already final, a move still to make
   * in 2K, the same screenshot twice, or screenshots that are already
   * another recorded game's box score.
   */
  read(slug: string, db: Db, leagueFolder: string, gameId: number, tokens: string[]): { jobId: number } {
    const game = getGame(db, gameId)
    if (!game) refuse('unknown-game', { game: gameId })
    if (game.status === 'final') refuse('game-final')
    const blocked = waitingTeams(db, game)
    if (blocked.length > 0) refuse('pending-2k-moves', { teams: blocked.join(', ') })
    if (tokens.length < 1 || tokens.length > MAX_SHOTS) throw new AppError('invalid-input', 'one to four screenshots')
    if (new Set(tokens).size !== tokens.length) throw new AppError('invalid-input', 'the same screenshot twice')
    const inbox = inboxOf(leagueFolder)
    for (const t of tokens) {
      checkToken(t)
      if (!existsSync(join(inbox, t))) throw new AppError('invalid-input', `unknown screenshot ${t}`)
    }
    // The same screenshot pasted twice would read as one team twice.
    const hashes = tokens.map((t) => hashOf(join(inbox, t)))
    if (new Set(hashes).size !== hashes.length) refuse('same-screenshot')
    refuseRecordedElsewhere(gamesReadWith(db, hashes, game.id))
    const folder = join(leagueFolder, 'screenshots', `game-${gameId}-${Date.now()}`)
    mkdirSync(folder, { recursive: true })
    const images = tokens.map((t, i) => {
      const name = `${i + 1}.${t.split('.').pop()}`
      renameSync(join(inbox, t), join(folder, name))
      return name
    })
    sweepInbox(inbox)
    const teams = listTeams(db)
    const short = (id: string) => teams.find((tm) => tm.id === id)?.shortName ?? id
    if (this.ai.fake) writeFileSync(join(folder, FAKE_OUTPUT_FILE), JSON.stringify(fakeRead(db, game.away, game.home)), 'utf8')
    const input: BoxScoreJobInput = {
      images,
      teams: [short(game.home), short(game.away)],
      ...aiFor(loadConfig(db).config, 'screenshot'),
      hashes,
      gameKey: gameKey(game),
    }
    const jobId = this.ai.queueFor(slug, db, leagueFolder).enqueue(READ_KIND, { ...input, gameId }, PRIORITY_SCREENSHOT, folder)
    return { jobId }
  }

  job(db: Db, jobId: number): JobInfo {
    const job = sqliteJobStore(db).get(jobId)
    if (!job) throw new AppError('not-found', `job ${jobId}`)
    return toInfo(job)
  }

  /**
   * The reading jobs for one game, latest first, so the screen can pick up
   * where it left off. Jobs still waiting get their queue going (after a
   * restart nothing else may have opened it yet).
   */
  jobs(slug: string, db: Db, leagueFolder: string, gameId: number): JobInfo[] {
    // Only readings of this very game (see gameKey).
    const rows = listJobsByInput(db, READ_KIND, 'gameId', gameId).filter((j) => gameFor(db, j)?.id === gameId)
    if (rows.some((j) => j.status === 'queued' || j.status === 'running')) this.ai.queueFor(slug, db, leagueFolder)
    return rows.map(toInfo)
  }

  /**
   * Reads a failed job's screenshots again: a new job over the same folder,
   * marked as its 다시 시도. Once a reread of it (or of any read in its
   * chain) waits, runs or is done, it isn't read again.
   */
  retry(slug: string, db: Db, leagueFolder: string, jobId: number): { jobId: number } {
    const store = sqliteJobStore(db)
    const job = store.get(jobId)
    if (!job || job.kind !== READ_KIND) throw new AppError('not-found', `job ${jobId}`)
    if (job.status !== 'failed' && job.status !== 'cancelled') throw new AppError('invalid-input', `job ${jobId} is ${job.status}`)
    if (store.liveRetryOf?.(jobId) != null) refuse('job-retried')
    const game = gameFor(db, job)
    if (!game) refuse('unknown-game', { game: gameOf(job) ?? 0 })
    if (game.status === 'final') refuse('game-final')
    const blocked = waitingTeams(db, game)
    if (blocked.length > 0) refuse('pending-2k-moves', { teams: blocked.join(', ') })
    const images = (job.input as Partial<BoxScoreJobInput>).images ?? []
    if (!job.folder || images.length === 0 || images.some((name) => !existsSync(join(job.folder!, name)))) refuse('screenshots-gone')
    // A reading from before hashes were kept stays unchecked, as it always was.
    refuseRecordedElsewhere(gamesReadWith(db, (job.input as Partial<BoxScoreJobInput>).hashes ?? [], game.id))
    // Read again with the screenshot setting as it is now (you may have picked a stronger model after a bad read).
    const { model: _model, effort: _effort, ...rest } = job.input as BoxScoreJobInput & { gameId?: number }
    const input = { ...rest, ...aiFor(loadConfig(db).config, 'screenshot'), gameKey: gameKey(game), [MANUAL_RETRY_OF]: jobId }
    const id = this.ai.queueFor(slug, db, leagueFolder).enqueue(READ_KIND, input, PRIORITY_SCREENSHOT, job.folder)
    return { jobId: id }
  }

  confirmView(db: Db, jobId: number, flip = false): ConfirmView {
    const job = sqliteJobStore(db).get(jobId)
    if (!job || job.kind !== READ_KIND) throw new AppError('not-found', `job ${jobId}`)
    if (job.status !== 'done') throw new AppError('invalid-input', 'the screenshots are not read yet')
    const read = boxScoreReadSchema.parse(job.output) as BoxScoreRead
    const game = gameFor(db, job)
    if (!game) refuse('unknown-game', { game: gameOf(job) ?? 0 })
    const input = job.input as Partial<BoxScoreJobInput>
    const { config } = loadConfig(db)
    const players = listPlayers(db)
    const teams = listTeams(db)
    const side = (teamId: string) => {
      const team = teams.find((tm) => tm.id === teamId)
      return {
        teamId,
        names: team ? [team.name, team.shortName] : [],
        roster: players.filter((p) => p.teamId === teamId).map((p) => ({ id: p.id, name: p.name })),
        learned: learnedNames(db, teamId),
      }
    }
    return {
      ...buildConfirmView(config, read, { id: game.id, jobId }, side(game.home), side(game.away), flip),
      usedFor: gamesReadWith(db, input.hashes ?? [], game.id),
      waiting2k: waitingTeams(db, game),
      images: input.images?.length ?? 0,
    }
  }

  /**
   * A reading's screenshots, to show beside the confirm tables. Only the
   * files the job names, in its own folder.
   */
  shots(db: Db, jobId: number): { name: string; bytes: Uint8Array }[] {
    const job = sqliteJobStore(db).get(jobId)
    if (!job || job.kind !== READ_KIND || !job.folder) throw new AppError('not-found', `job ${jobId}`)
    const names = ((job.input as Partial<BoxScoreJobInput>).images ?? []).filter((n) => SHOT_NAME.test(n))
    return names.flatMap((name) => {
      const file = join(job.folder!, name)
      try {
        return statSync(file).size <= MAX_IMAGE ? [{ name, bytes: new Uint8Array(readFileSync(file)) }] : []
      } catch {
        // Gone (cleaned up by hand): the tables still show.
        return []
      }
    })
  }

  /**
   * Records the confirmed box score and remembers the confirmed names, in one
   * transaction. Only a finished reading of this game can be confirmed, only
   * once, and only when it has two different teams with lines.
   */
  confirm(db: Db, input: ConfirmInput): { warnings: BoxIssue[] } {
    const job = sqliteJobStore(db).get(input.jobId)
    if (!job || job.kind !== READ_KIND) throw new AppError('not-found', `job ${input.jobId}`)
    if (job.status !== 'done') refuse('read-not-done')
    if (gameOf(job) !== input.gameId) refuse('read-other-game')
    const game = getGame(db, input.gameId)
    if (!game) refuse('unknown-game', { game: input.gameId })
    // The id names another game now than the one read (a reading from before ids stopped being reused).
    if (gameFor(db, job)?.id !== game.id) refuse('read-other-game')
    // A final game would be overwritten as a correction, hand-entered lines and all.
    if (game.status === 'final') refuse('game-final')
    // Another game was recorded from these screenshots since they were read.
    refuseRecordedElsewhere(gamesReadWith(db, (job.input as Partial<BoxScoreJobInput>).hashes ?? [], game.id))
    const read = boxScoreReadSchema.parse(job.output) as BoxScoreRead
    const problem = readProblem(read)
    if (problem) refuse(problem === 'one-team' ? 'read-one-team' : 'read-same-team')
    for (const teamId of [game.home, game.away]) {
      if (!input.lines.some((l) => l.teamId === teamId)) refuse('empty-side', { teams: teamId })
    }
    // Names to remember: each one a row that was read, for a player with a line for that team.
    const readRows = new Set(read.teams.flatMap((t) => t.players.map((p, row) => `${row}\u0000${normalizeSource(p.name)}`)))
    const lineTeam = new Map(input.lines.map((l) => [l.playerId, l.teamId]))
    for (const n of input.names) {
      if (lineTeam.get(n.playerId) !== n.teamId || !readRows.has(`${n.row}\u0000${normalizeSource(n.source)}`)) {
        refuse('name-not-read', { source: n.source })
      }
    }
    return transaction(db, () => {
      const result = recordScore(db, { gameId: input.gameId, homeScore: input.homeScore, awayScore: input.awayScore, lines: input.lines })
      learnNames(db, input.names)
      return result
    })
  }
}

/** The demo reader's answer: each player's 2K-style name and plausible numbers. */
function fakeRead(db: Db, first: string, second: string): BoxScoreRead {
  const players = listPlayers(db)
  const team = (teamId: string, label: string) => ({
    team: label,
    players: players
      .filter((p) => p.teamId === teamId)
      .map((p, i) => {
        const fgm = 3 + ((p.name.charCodeAt(0) + i) % 8)
        const tpm = i % 3
        const ftm = (p.name.length + i) % 5
        return {
          // Unique across the league, so two teams never read as the same one.
          name: englishStyleName(p.name) ?? `X. Player${players.indexOf(p) + 1}`,
          pts: 2 * fgm + tpm + ftm,
          reb: 2 + (i % 7),
          ast: 1 + (i % 5),
          stl: i % 3,
          blk: i % 2,
          to: 1 + (i % 3),
          fgm,
          fga: fgm + 6,
          tpm,
          tpa: tpm + 3,
          ftm,
          fta: ftm + 1,
        }
      }),
  })
  // Away first, as if the screenshots came in that order.
  return { teams: [team(first, 'AWAY'), team(second, 'HOME')], notes: '' }
}
