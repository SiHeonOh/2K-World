import { z } from 'zod'
import type { EffortLevel, LeagueConfig, ModelName, StatMeaning } from '@shared/config/schema'
import type { ConfirmView, ReadProblem, ReadRow, ReadTeam } from '@shared/gameday'
import type { JobKind } from '@ai/queue'
import { confirmIssues, rowsPoints, suggestedScore } from '@shared/boxcheck'
import { labelNamesTeam, matchNames, normalizeSource, type LearnedName, type RosterEntry } from './namemap'

/**
 * The `read_box_score` job: Claude reads one game's box-score screenshots
 * (copied into the job's own folder) and returns every player line. Names
 * stay in English as shown; the name map turns them into players afterwards.
 */

const count = z.number().int().min(0).max(300)

export const boxScoreReadSchema = z.object({
  teams: z
    .array(
      z.object({
        team: z.string().describe('The team name or abbreviation exactly as shown on the screenshot'),
        players: z
          .array(
            z.object({
              name: z.string().describe('Player name exactly as shown, e.g. "H. Hu"'),
              pts: count,
              reb: count,
              ast: count,
              stl: count,
              blk: count,
              to: count,
              fgm: count,
              fga: count,
              tpm: count.describe('3-pointers made'),
              tpa: count.describe('3-pointers attempted'),
              ftm: count,
              fta: count,
            }),
          )
          .max(20),
        // Optional so reads made before it still parse. A cropped screenshot can lose bench rows; this total can't.
        score: z
          .number()
          .int()
          .min(0)
          .max(400)
          .nullable()
          .optional()
          .describe("The team's total points as the screenshot shows them (its totals row, or the final score on a scoreboard); null if it shows neither"),
      }),
    )
    // One team is a valid answer (only one screenshot was readable). The confirm screen shows it and
    // refuses to record it (readProblem), instead of failing the job on a schema error.
    .min(1)
    .max(2),
  notes: z.string().describe('Anything unreadable or uncertain; empty if everything was clear'),
})

export type BoxScoreRead = z.infer<typeof boxScoreReadSchema>

export interface BoxScoreJobInput {
  /** Image file names inside the job folder. */
  images: string[]
  /** Short names of the two teams, as hints for which screenshot is which. */
  teams: string[]
  /** The league's choice for screenshot reading (older jobs have none: Sonnet). */
  model?: ModelName
  effort?: EffortLevel
  /** SHA-256 of each image, to notice the same screenshots read for two games (older jobs have none). */
  hashes?: string[]
  /** The game it reads, as it was when queued (older jobs have none): see gameKey. */
  gameKey?: string
}

const SYSTEM_PROMPT = `You read NBA 2K26 box score screenshots and copy the numbers exactly.

Rules:
- Each screenshot shows one team's "Total Game" box score. Read every player row.
- Copy each player's name exactly as shown (usually "F. Lastname"). Do not translate or guess full names.
- FG, 3PT and FT are shown as made-attempted (e.g. 7-12): split them into made and attempted.
- Use 0 for a blank or dash. Never invent rows. A team-total row is not a player: put its points in the team's "score" instead (or the team's final score, if a scoreboard shows it). Use null when neither is on the screenshot.
- Check yourself: for every player, PTS should equal 2 × FGM + 3PM + FTM, and the players' points should add up to "score". If a number is unclear, re-read it; if still unclear, give your best reading and say so in "notes". If a screenshot looks cut off (rows missing), say so in "notes".
- Answer only with the JSON the schema asks for.`

export const readBoxScoreJob: JobKind<BoxScoreJobInput, BoxScoreRead> = {
  kind: 'read_box_score',
  model: (i) => i.model ?? 'sonnet',
  effort: (i) => i.effort,
  tools: ['Read'],
  output: boxScoreReadSchema,
  timeoutMs: 5 * 60 * 1000,
  systemPrompt: () => SYSTEM_PROMPT,
  prompt: (i) =>
    `Read the box score screenshots in the current folder: ${i.images.join(', ')}. ` +
    `They are for one game between two teams (in Korean: ${i.teams.join(' vs ')}; 2K may show English names). ` +
    `Return one entry per team with every player line.`,
  // Only what the reader needs (not the model settings).
  stdin: (i) => JSON.stringify({ images: i.images, teams: i.teams }),
}

// ── From what was read to what the confirm screen shows ──────────────────

const FIELD_FOR: Partial<Record<StatMeaning, keyof BoxScoreRead['teams'][number]['players'][number]>> = {
  points: 'pts',
  rebounds: 'reb',
  assists: 'ast',
  steals: 'stl',
  blocks: 'blk',
  turnovers: 'to',
  fgm: 'fgm',
  fga: 'fga',
  tpm: 'tpm',
  tpa: 'tpa',
  ftm: 'ftm',
  fta: 'fta',
}

export interface SideInput {
  teamId: string
  /** The team's full and short names, to recognise its label on a screenshot. */
  names?: string[]
  roster: RosterEntry[]
  learned: LearnedName[]
}

/**
 * Whether the read can be recorded at all: it needs two teams with player
 * lines, and not the same team twice (the same screenshot pasted twice).
 */
export function readProblem(read: BoxScoreRead): ReadProblem | null {
  const [a, b] = read.teams
  if (!a || !b || a.players.length === 0 || b.players.length === 0) return 'one-team'
  // Most names on both sides → one team read twice (a misread name or two still counts).
  const left = new Map<string, number>()
  for (const p of a.players) left.set(normalizeSource(p.name), (left.get(normalizeSource(p.name)) ?? 0) + 1)
  let shared = 0
  for (const p of b.players) {
    const n = left.get(normalizeSource(p.name)) ?? 0
    if (n > 0) {
      shared++
      left.set(normalizeSource(p.name), n - 1)
    }
  }
  return shared >= 0.8 * Math.max(a.players.length, b.players.length) ? 'same-team' : null
}

/** The confirm view as the read alone gives it; the game day service adds what the league knows (other games, the 2K checklist). */
export type ReadView = Omit<ConfirmView, 'usedFor' | 'waiting2k' | 'images'>

/**
 * Builds the confirm view: decides which read team is home (by its label
 * when that names one of the teams, otherwise by how many of its names match
 * each roster), maps stats onto the league's stat columns, matches names, and
 * runs the box-score self-checks.
 */
export function buildConfirmView(
  config: LeagueConfig,
  read: BoxScoreRead,
  game: { id: number; jobId: number },
  home: SideInput,
  away: SideInput,
  /** Overrides the automatic choice of which read team is home (the confirm screen's swap button). */
  flip = false,
): ReadView {
  const toRows = (team: BoxScoreRead['teams'][number], side: SideInput): ReadRow[] => {
    const matches = matchNames(
      team.players.map((p, row) => ({ row, source: p.name })),
      side.roster,
      side.learned,
    )
    return team.players.map((p, row) => {
      const stats: Record<string, number> = {}
      for (const col of config.stats.columns) {
        const field = FIELD_FOR[col.meaning]
        if (field) stats[col.id] = p[field] as number
      }
      const m = matches[row]!
      return { row, source: p.name, stats, playerId: m.playerId, how: m.how, candidates: m.candidates }
    })
  }
  const matched = (rows: ReadRow[]) => rows.filter((r) => r.playerId !== null).length
  const [first, second] = read.teams
  const empty = { team: '', players: [] }
  const a = first ?? empty
  const b = second ?? empty
  const straight = { home: toRows(a, home), away: toRows(b, away) }
  const crossed = { home: toRows(b, home), away: toRows(a, away) }
  const sScore = matched(straight.home) + matched(straight.away)
  const cScore = matched(crossed.home) + matched(crossed.away)
  const byNames = cScore > sScore ? 'crossed' : sScore > cScore ? 'straight' : null
  // A label that names exactly one of the two teams settles it.
  const labelSide = (label: string): 'home' | 'away' | null => {
    const h = labelNamesTeam(label, home.names ?? [])
    const w = labelNamesTeam(label, away.names ?? [])
    return h && !w ? 'home' : w && !h ? 'away' : null
  }
  const la = labelSide(a.team)
  const lb = labelSide(b.team)
  const saysStraight = la === 'home' || lb === 'away'
  const saysCrossed = la === 'away' || lb === 'home'
  const byLabel = saysStraight && !saysCrossed ? 'straight' : saysCrossed && !saysStraight ? 'crossed' : null
  const useCrossed = (byLabel ?? byNames ?? 'straight') === 'crossed' !== flip
  const pick = useCrossed ? crossed : straight
  const side = (teamId: string, readIndex: number, read: BoxScoreRead['teams'][number], rows: ReadRow[]): ReadTeam => ({
    teamId,
    readIndex,
    label: read.team,
    rows,
    score: rowsPoints(config, rows),
    shown: read.score ?? null,
  })
  const homeTeam = useCrossed ? side(home.teamId, 1, b, pick.home) : side(home.teamId, 0, a, pick.home)
  const awayTeam = useCrossed ? side(away.teamId, 0, a, pick.away) : side(away.teamId, 1, b, pick.away)
  // The same checks the screen runs as you edit, here on the numbers as read and the suggested final score.
  const sides = [homeTeam, awayTeam].map((t) => ({ teamId: t.teamId, rows: t.rows, shown: t.shown }))
  const issues = confirmIssues(config, sides[0]!, sides[1]!, { home: suggestedScore(config, sides[0]!), away: suggestedScore(config, sides[1]!) })
  return {
    gameId: game.id,
    jobId: game.jobId,
    home: homeTeam,
    away: awayTeam,
    // Little to go on: no label says, and few names matched either way or both ways matched the same;
    // or the labels and the names disagree.
    sidesUncertain: byLabel !== null ? byNames !== null && byNames !== byLabel : Math.max(sScore, cScore) < 2 || sScore === cScore,
    problem: readProblem(read),
    issues,
    notes: read.notes,
  }
}
