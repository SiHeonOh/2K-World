import { columnFor, leaders, seasonTotals, type BoxLine, type LeaderBoard, type PlayerTotals } from '@core/stats'
import { computeRows, rankTeams, type FinalScore, type TeamRef } from '@core/standings'
import type { LeagueConfig, StatMeaning } from '@shared/config/schema'
import type { StandingLine, StandingsView } from '@shared/season'
import { seasonFor } from '@data/league'
import { regularFinals, seasonBoxLines, standings, teamRefs } from '@data/season'
import type { League } from './context'

/**
 * The season in numbers, worked out by code for the writers' analysis: a
 * school's profile (record and places, points for and against, shooting,
 * recent form, home and away, best win and worst loss), a player's season
 * line (averages with their totals, shooting, his last five against his
 * season, best game, share of his team's points, where he ranks), two
 * schools' meetings, the standings race, who's hot and cold, what a round
 * or a game changed in the table, and where a game was decided.
 *
 * Every number is formatted once, here, the way writers should repeat it
 * (45.2%, 18.3점, 승률 .700, 득실 +6.3점), and numbers that belong together
 * share a line, so the number check (numbers.ts) knows each of them and what
 * can be worked out from them there (a score's margin, a share from 12/30,
 * two shares apart in %p). Works on whatever was played: rounds or 2K
 * 일정대로 sessions (uneven games per school), with or without box lines.
 */

const KEYS = {
  pts: 'points',
  reb: 'rebounds',
  ast: 'assists',
  stl: 'steals',
  blk: 'blocks',
  to: 'turnovers',
  fgm: 'fgm',
  fga: 'fga',
  tpm: 'tpm',
  tpa: 'tpa',
  ftm: 'ftm',
  fta: 'fta',
} as const satisfies Record<string, StatMeaning>
type Key = keyof typeof KEYS
/** The league's column for each stat the pack uses (null: not tracked). */
export type Columns = Record<Key, string | null>

const columnsOf = (config: LeagueConfig): Columns =>
  Object.fromEntries(Object.entries(KEYS).map(([k, meaning]) => [k, columnFor(config, meaning)])) as Columns

/** A season's numbers, read once for a job. */
export interface Season {
  config: LeagueConfig
  cols: Columns
  /** Regular-season results, in the order they were played (round or session, then game). */
  games: FinalScore[]
  /** Their box lines, in the same order. */
  lines: BoxLine[]
  totals: Map<string, PlayerTotals>
  table: StandingsView
  refs: TeamRef[]
  /** The season's seed: ties break as they do in the table. */
  seed: string
  team: (id: string) => string
  player: (id: string) => string
}

export function readSeason(league: Pick<League, 'db' | 'config' | 'teams' | 'players'>, seasonId?: number): Season {
  const { db, config } = league
  const season = seasonFor(db, seasonId)
  const lines = seasonBoxLines(db, season.id)
  return {
    config,
    cols: columnsOf(config),
    games: regularFinals(db, season.id).sort((a, b) => a.round - b.round || a.id - b.id),
    lines,
    totals: seasonTotals(lines),
    table: standings(db, season.id),
    refs: teamRefs(db, config),
    seed: season.seed,
    team: (id) => league.teams.get(id)?.shortName ?? id,
    player: (id) => league.players.get(id)?.name ?? id,
  }
}

// ── How numbers are written ──────────────────────────────────────────────

/** One decimal, as averages are written: 18.3. */
const one = (n: number) => n.toFixed(1)
/** A number as shown with one decimal, for working out a gap writers can check against what they see. */
const shown = (n: number) => Number(one(n))
/** A share as writers repeat it: 45.2%. */
const percent = (made: number, tried: number) => `${((made / tried) * 100).toFixed(1)}%`
/** A win rate: .700, 1.000 unbeaten. */
const winRate = (w: number, l: number) => (w + l === 0 ? '.000' : l === 0 ? '1.000' : (w / (w + l)).toFixed(3).slice(1))
/** A per-game margin with its sign: +6.3, -2.0. */
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${one(Math.abs(n))}`
const record = (w: number, l: number) => `${w}승 ${l}패`
/** The table's "4-1" as 4승 1패. */
const fromDash = (r: string) => {
  const [w, l] = r.split('-').map(Number)
  return record(w ?? 0, l ?? 0)
}
/** Games behind: 1, 1.5. */
const behind = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

/** "W3" as 3연승 (two games or more; '' otherwise). */
export const streakText = (streak: string) => {
  const m = /^([WL])(\d+)$/.exec(streak)
  return m && Number(m[2]) >= 2 ? `${m[2]}${m[1] === 'W' ? '연승' : '연패'}` : ''
}

/**
 * A player's averages over some games, with the totals they come from (what
 * a writer would otherwise multiply out, and the check can't vouch for):
 * "4경기 평균 22.5점 7.5리바 3.3어시(총 90점 30리바 13어시)".
 */
export function averages(t: { games: number; totals: Record<string, number> }, columns: { col: string | null | undefined; unit: string }[]): string {
  const shownCols = columns.filter((c): c is { col: string; unit: string } => Boolean(c.col))
  if (shownCols.length === 0) return `${t.games}경기`
  const avg = shownCols.map((c) => `${one((t.totals[c.col] ?? 0) / t.games)}${c.unit}`).join(' ')
  const total = shownCols.map((c) => `${t.totals[c.col] ?? 0}${c.unit}`).join(' ')
  return `${t.games}경기 평균 ${avg}${t.games > 1 ? `(총 ${total})` : ''}`
}

/** Points, rebounds and assists, the averages every line shows. */
const main = (cols: Columns) => [
  { col: cols.pts, unit: '점' },
  { col: cols.reb, unit: '리바' },
  { col: cols.ast, unit: '어시' },
]

const SHOTS = [
  ['fgm', 'fga', '야투'],
  ['tpm', 'tpa', '3점슛'],
  ['ftm', 'fta', '자유투'],
] as const

/** Shooting as 야투 45.2%(312/690) · 3점슛 …, for the kinds tracked and tried. */
function shooting(cols: Columns, total: (key: Key) => number | null): string {
  return SHOTS.flatMap(([m, a, label]) => {
    const made = cols[m] ? total(m) : null
    const tried = cols[a] ? total(a) : null
    return made !== null && tried !== null && tried > 0 ? [`${label} ${percent(made, tried)}(${made}/${tried})`] : []
  }).join(' · ')
}

// ── Schools ──────────────────────────────────────────────────────────────

interface Result {
  gameId: number
  opp: string
  own: number
  their: number
  home: boolean
  won: boolean
}

function resultsOf(games: readonly FinalScore[], teamId: string): Result[] {
  return games.flatMap((g) => {
    const home = g.home === teamId
    if (!home && g.away !== teamId) return []
    const own = home ? g.homeScore : g.awayScore
    const their = home ? g.awayScore : g.homeScore
    return [{ gameId: g.id, opp: home ? g.away : g.home, own, their, home, won: own > their }]
  })
}

const conferenceOf = (s: Season, teamId: string) => {
  const id = s.refs.find((r) => r.id === teamId)?.conferenceId
  return s.config.structure.conferences.find((c) => c.id === id) ?? null
}

/** Places that matter in the race: straight into the playoffs, and with the play-in (null without playoffs). */
function cutoffs(config: LeagueConfig): { direct: number; field: number } | null {
  const { playoffs } = config.season
  if (!playoffs.enabled) return null
  return { direct: playoffs.directSeeds, field: playoffs.directSeeds + (playoffs.playIn.enabled ? 4 : 0) }
}

/** The groups a race is run in: each conference when the bracket is by conference, else the whole league. */
function raceGroups(s: Season): { id: string; name: string; lines: StandingLine[] }[] {
  const { conferences } = s.config.structure
  if (s.config.season.playoffs.bracket === 'conference' && conferences.length > 0) {
    return conferences.map((c) => ({ id: c.id, name: c.name, lines: s.table.conferences[c.id] ?? [] }))
  }
  return [{ id: 'league', name: '리그 전체', lines: s.table.overall }]
}

/** A school's place note: the leader's lead over 2nd, anyone else's gap to 1st. Nothing when no gap shows (2K 일정대로 can rank by win rate alone). */
function gapNote(list: readonly StandingLine[], at: number): string {
  if (at === 0) {
    const lead = list[1]?.gamesBehind ?? 0
    return lead > 0 ? `(2위와 ${behind(lead)}경기 차)` : ''
  }
  const gb = list[at]!.gamesBehind
  return gb > 0 ? `(1위와 ${behind(gb)}경기 차)` : ''
}

/** A school's box-score totals over the games it has lines for (null: the league doesn't track that stat). */
function teamBox(s: Season, teamId: string): { games: number; total: (key: Key) => number | null } {
  const mine = s.lines.filter((l) => l.teamId === teamId)
  const games = new Set(mine.map((l) => l.gameId)).size
  return {
    games,
    total: (key) => {
      const col = s.cols[key]
      return col ? mine.reduce((sum, l) => sum + (l.stats[col] ?? 0), 0) : null
    },
  }
}

/** A game decided by this many points or fewer is a close one. */
const CLOSE = 5

/**
 * A school's season in up to eight lines: record, win rate, places and
 * streak; points for and against per game; shooting and per-game counts
 * (from box lines, when there are any); the last five; home and away; close
 * games; best win and worst loss.
 */
export function teamProfile(s: Season, teamId: string): string[] {
  const name = s.team(teamId)
  const rows = resultsOf(s.games, teamId)
  const at = s.table.overall.findIndex((x) => x.teamId === teamId)
  const line = s.table.overall[at]
  if (rows.length === 0 || !line) return [`[${name}] 이번 시즌 치른 경기 없음`]
  const gp = rows.length
  const head = [`${gp}경기 ${record(line.wins, line.losses)}(승률 ${winRate(line.wins, line.losses)})`]
  const conf = conferenceOf(s, teamId)
  const list = conf ? (s.table.conferences[conf.id] ?? []) : []
  const place = list.findIndex((x) => x.teamId === teamId)
  if (conf && place >= 0) head.push(`${conf.name} ${place + 1}위${gapNote(list, place)}`)
  head.push(`전체 ${at + 1}위`)
  const streak = streakText(line.streak)
  if (streak) head.push(streak)
  const out = [`[${name}] ${head.join(' · ')}`]
  out.push(`- 경기당 득점 ${one(line.pointsFor / gp)}점, 실점 ${one(line.pointsAgainst / gp)}점, 득실 ${signed((line.pointsFor - line.pointsAgainst) / gp)}점`)
  const box = teamBox(s, teamId)
  if (box.games > 0) {
    const basis = box.games < gp ? ` (박스스코어 있는 ${box.games}경기 기준)` : ''
    const shots = shooting(s.cols, box.total)
    if (shots) out.push(`- ${shots}${basis}`)
    const counts = (
      [
        ['reb', '리바'],
        ['ast', '어시'],
        ['to', '턴오버'],
      ] as const
    ).flatMap(([k, label]) => {
      const v = box.total(k)
      return v === null ? [] : [`${label} ${one(v / box.games)}`]
    })
    if (counts.length) out.push(`- 경기당 ${counts.join(' · ')}${shots ? '' : basis}`)
  }
  const last = rows.slice(-5).reverse()
  const scores = last.map((r) => `${s.team(r.opp)}전 ${r.own}:${r.their} ${r.won ? '승' : '패'}`).join(', ')
  const lastWins = last.filter((r) => r.won).length
  out.push(gp > 5 ? `- 최근 5경기 ${record(lastWins, last.length - lastWins)}(최근 경기부터): ${scores}` : `- 경기 결과(최근 경기부터): ${scores}`)
  out.push(`- 홈 ${fromDash(line.home)} · 원정 ${fromDash(line.away)}`)
  const close = rows.filter((r) => Math.abs(r.own - r.their) <= CLOSE)
  const closeWins = close.filter((r) => r.won).length
  if (close.length) out.push(`- ${CLOSE}점 차 이내 접전 ${record(closeWins, close.length - closeWins)}`)
  const widest = (list: Result[]) => list.reduce<Result | null>((a, r) => (a === null || Math.abs(r.own - r.their) > Math.abs(a.own - a.their) ? r : a), null)
  const best = widest(rows.filter((r) => r.won))
  const worst = widest(rows.filter((r) => !r.won))
  const game = (r: Result) => `${s.team(r.opp)}전 ${r.own}:${r.their}(${Math.abs(r.own - r.their)}점 차)`
  const extremes = [best ? `최고의 승리 ${game(best)}` : '', worst ? `최악의 패배 ${game(worst)}` : ''].filter(Boolean)
  if (extremes.length) out.push(`- ${extremes.join(' · ')}`)
  return out
}

/** Two schools' meetings this regular season, the home side first in each score. */
export function headToHead(s: Season, a: string, b: string): string {
  const met = s.games.filter((g) => (g.home === a && g.away === b) || (g.home === b && g.away === a))
  if (met.length === 0) return `맞대결(이번 시즌): ${s.team(a)}와 ${s.team(b)}는 아직 안 만났다`
  const wins = met.filter((g) => (g.home === a ? g.homeScore > g.awayScore : g.awayScore > g.homeScore)).length
  return `맞대결(이번 시즌): ${s.team(a)} 기준 ${record(wins, met.length - wins)} — ${met.map((g) => `${s.team(g.home)} ${g.homeScore}:${g.awayScore} ${s.team(g.away)}`).join(', ')}`
}

// ── Players ──────────────────────────────────────────────────────────────

const gameMap = (s: Season) => new Map(s.games.map((g) => [g.id, g]))
const opponent = (g: FinalScore | undefined, teamId: string) => (g ? (g.home === teamId ? g.away : g.home) : '')
const scoreOf = (g: FinalScore | undefined, teamId: string) => (g ? (g.home === teamId ? g.homeScore : g.awayScore) : 0)

/** Leader boards as writers name them. */
const BOARD_KO: Partial<Record<string, string>> = {
  points: '득점',
  rebounds: '리바운드',
  assists: '어시스트',
  steals: '스틸',
  blocks: '블록',
  turnovers: '턴오버',
  tpm: '3점슛 성공',
  fgm: '야투 성공',
  ftm: '자유투 성공',
  'fg%': '야투율',
  '3p%': '3점슛 성공률',
  'ft%': '자유투 성공률',
}

/** Games a player needs to rank: half the most anyone has played (2K 일정대로 schools play unevenly). */
const minGames = (s: Season) => Math.max(1, Math.ceil(Math.max(0, ...[...s.totals.values()].map((t) => t.games)) / 2))

function boards(s: Season): LeaderBoard[] {
  return leaders(s.config, s.totals, minGames(s), 10).filter((b) => b.rows.length > 0)
}

const boardName = (s: Season, b: LeaderBoard) =>
  BOARD_KO[b.kind === 'percent' ? b.key : (s.config.stats.columns.find((c) => c.id === b.key)?.meaning ?? '')] ?? b.label

/** Where a player ranks among the league's top 10s: 득점 2위, 어시스트 5위 (not a "1위" at nothing a game). */
function leaderRanks(s: Season, playerId: string, all = boards(s)): string[] {
  return all.flatMap((b) => {
    const at = b.rows.filter((r) => r.value > 0).findIndex((r) => r.playerId === playerId)
    return at >= 0 ? [`${boardName(s, b)} ${at + 1}위`] : []
  })
}

/** A player's points per game over his last five and his season, as shown (one decimal), and the gap between them. */
export interface PlayerForm {
  playerId: string
  teamId: string
  games: number
  season: number
  last5: number
  diff: number
}

/** Players with a game before their last five, and their scoring form. Empty when the league tracks no points. */
export function playerForms(s: Season): PlayerForm[] {
  const pts = s.cols.pts
  if (!pts) return []
  const byPlayer = new Map<string, BoxLine[]>()
  for (const l of s.lines) byPlayer.set(l.playerId, [...(byPlayer.get(l.playerId) ?? []), l])
  return [...byPlayer.entries()].flatMap(([playerId, mine]) => {
    if (mine.length < 6) return []
    const avg = (list: BoxLine[]) => shown(list.reduce((sum, l) => sum + (l.stats[pts] ?? 0), 0) / list.length)
    const season = avg(mine)
    const last5 = avg(mine.slice(-5))
    return [{ playerId, teamId: mine.at(-1)!.teamId, games: mine.length, season, last5, diff: shown(last5 - season) }]
  })
}

/** How his last five compare: "보다 4.1점 많음". */
const swing = (diff: number) => (diff === 0 ? '과 같음' : `보다 ${one(Math.abs(diff))}점 ${diff > 0 ? '많음' : '적음'}`)

const formLine = (s: Season, f: PlayerForm) => `${s.player(f.playerId)}(${s.team(f.teamId)}) 최근 5경기 평균 ${one(f.last5)}점, 시즌 평균 ${one(f.season)}점${swing(f.diff)}`

/**
 * A player's season in up to four lines: averages with totals; shooting;
 * his last five against his season (with a game before them); his best game,
 * his share of his team's points in the games he played, and where he ranks.
 */
export function playerSeason(s: Season, playerId: string): string[] {
  const t = s.totals.get(playerId)
  if (!t) return [`[${s.player(playerId)}] 이번 시즌 기록 없음`]
  const { cols } = s
  const out = [`[${s.player(playerId)}(${s.team(t.teamId)})] ${averages(t, main(cols))}`]
  const shots = shooting(cols, (k) => t.totals[cols[k]!] ?? 0)
  if (shots) out.push(`- ${shots}`)
  const mine = s.lines.filter((l) => l.playerId === playerId)
  const form = playerForms(s).find((f) => f.playerId === playerId)
  if (form) {
    const last = seasonTotals(mine.slice(-5)).get(playerId)!
    out.push(`- 최근 ${averages(last, main(cols))} · 득점은 시즌 평균${swing(form.diff)}`)
  }
  const notes: string[] = []
  if (cols.pts) {
    const pts = cols.pts
    const games = gameMap(s)
    const best = mine.reduce((a, l) => ((l.stats[pts] ?? 0) > (a.stats[pts] ?? 0) ? l : a))
    if ((best.stats[pts] ?? 0) > 0) notes.push(`시즌 최고 ${best.stats[pts]}점(${s.team(opponent(games.get(best.gameId), best.teamId))}전)`)
    const team = mine.reduce((sum, l) => sum + scoreOf(games.get(l.gameId), l.teamId), 0)
    if (team > 0) notes.push(`뛴 경기 팀 득점의 ${percent(t.totals[pts] ?? 0, team)}`)
  }
  const ranks = leaderRanks(s, playerId)
  if (ranks.length) notes.push(`리그 ${ranks.join(', ')}`)
  if (notes.length) out.push(`- ${notes.join(' · ')}`)
  return out
}

/**
 * A player's night next to his season: his averages before this game (the
 * regular season's, for a playoff game), how far tonight is from them, a
 * season high, and his share of his team's points tonight.
 */
export function nightInContext(s: Season, line: BoxLine, teamScore: number, regular: boolean): string {
  const { cols } = s
  const pts = cols.pts
  const tonight = pts ? (line.stats[pts] ?? 0) : null
  const mine = s.lines.filter((l) => l.playerId === line.playerId)
  const at = regular ? mine.findIndex((l) => l.gameId === line.gameId) : -1
  const before = at >= 0 ? mine.slice(0, at) : regular ? mine.filter((l) => l.gameId !== line.gameId) : mine
  const parts = [`${s.player(line.playerId)}(${s.team(line.teamId)})${tonight !== null ? ` 오늘 ${tonight}점` : ''}`]
  if (before.length === 0) parts.push(regular ? '이번 시즌 첫 경기' : '정규시즌 기록 없음')
  else {
    const t = seasonTotals(before).get(line.playerId)!
    parts.push(`${regular ? '이 경기 전' : '정규시즌'} ${averages(t, main(cols))}`)
    if (pts && tonight !== null) {
      const gap = shown(tonight - shown((t.totals[pts] ?? 0) / t.games))
      parts.push(gap === 0 ? '평균과 같음' : `평균보다 ${one(Math.abs(gap))}점 ${gap > 0 ? '많음' : '적음'}`)
      const high = Math.max(...before.map((l) => l.stats[pts] ?? 0))
      if (regular) parts.push(tonight > high ? `시즌 최고 경신(종전 ${high}점)` : tonight === high ? '시즌 최고 타이' : `시즌 최고 ${high}점`)
    }
  }
  if (tonight !== null && teamScore > 0) parts.push(`오늘 팀 득점 ${teamScore}점의 ${percent(tonight, teamScore)}`)
  return `- ${parts.join(' · ')}`
}

/** A night's line in a round-up, put in its season: "시즌 10경기 평균 21.3점 …(총 …) · 시즌 최고". */
export function seasonNote(s: Season, line: BoxLine): string {
  const t = s.totals.get(line.playerId)
  if (!t) return ''
  const pts = s.cols.pts
  const high = pts ? Math.max(...s.lines.filter((l) => l.playerId === line.playerId).map((l) => l.stats[pts] ?? 0)) : 0
  const top = pts !== null && t.games > 1 && high > 0 && (line.stats[pts] ?? 0) === high
  return `시즌 ${averages(t, main(s.cols))}${top ? ' · 시즌 최고 기록' : ''}`
}

// ── The table ────────────────────────────────────────────────────────────

/**
 * The race in each seeding group: its top places (through the play-in and
 * two more), the playoff and play-in lines drawn in, and who's just inside
 * and just out of each, with the gap.
 */
export function standingsRace(s: Season, only?: string): string[] {
  const cut = cutoffs(s.config)
  const out: string[] = []
  for (const g of raceGroups(s).filter((x) => only === undefined || x.id === only)) {
    const list = g.lines
    if (list.length === 0) continue
    out.push(`## ${g.name}`)
    const show = Math.min(list.length, cut ? cut.field + 2 : 6)
    list.slice(0, show).forEach((x, i) => {
      const streak = streakText(x.streak)
      out.push(`${i + 1}. ${s.team(x.teamId)} ${record(x.wins, x.losses)}(${winRate(x.wins, x.losses)})${x.gamesBehind > 0 ? ` · ${behind(x.gamesBehind)}경기 차` : ''}${streak ? ` · ${streak}` : ''}`)
      if (cut && i + 1 === cut.direct && cut.direct < list.length) out.push('── 여기까지 플레이오프 직행 ──')
      if (cut && cut.field > cut.direct && i + 1 === cut.field && cut.field < list.length) out.push('── 여기까지 플레이-인 ──')
    })
    if (show < list.length) out.push(`(나머지 ${list.length - show}개 학교 생략)`)
    if (!cut) continue
    const lines: [number, string][] = [[cut.direct, '직행']]
    if (cut.field > cut.direct) lines.push([cut.field, '플레이-인'])
    for (const [k, what] of lines) {
      const inside = list[k - 1]
      const outside = list[k]
      if (!inside || !outside) continue
      const gap = outside.gamesBehind - inside.gamesBehind
      out.push(
        `- ${what} 경계: ${k}위 ${s.team(inside.teamId)} ${record(inside.wins, inside.losses)} / ${k + 1}위 ${s.team(outside.teamId)} ${record(outside.wins, outside.losses)}, ${
          gap > 0 ? `${behind(gap)}경기 차` : '승률로 갈림'
        }`,
      )
    }
  }
  return out
}

/**
 * Close calls in the race worth an analysis: the top two of a group, and the
 * schools either side of each playoff line, a game or less apart (or level,
 * split by win rate). The two schools, inside first.
 */
export function closeRaces(s: Season): { groupId: string; group: string; line: string; teams: [string, string] }[] {
  const cut = cutoffs(s.config)
  const lines: [number, string][] = [[1, '1위']]
  if (cut && cut.direct > 1) lines.push([cut.direct, '플레이오프 직행'])
  if (cut && cut.field > cut.direct) lines.push([cut.field, '플레이-인'])
  return raceGroups(s).flatMap((g) =>
    lines.flatMap(([k, line]) => {
      const inside = g.lines[k - 1]
      const outside = g.lines[k]
      if (!inside || !outside || outside.gamesBehind - inside.gamesBehind > 1) return []
      return [{ groupId: g.id, group: g.name, line, teams: [inside.teamId, outside.teamId] as [string, string] }]
    }),
  )
}

/** The best scorers per game, best first: league-wide among players with games enough to rank, or a school's own. */
export function topScorers(s: Season, n: number, teamId?: string): string[] {
  const pts = s.cols.pts
  if (!pts) return []
  const least = teamId === undefined ? minGames(s) : 1
  const avg = (t: PlayerTotals) => (t.totals[pts] ?? 0) / t.games
  return [...s.totals.values()]
    .filter((t) => (teamId === undefined || t.teamId === teamId) && t.games >= least && avg(t) > 0)
    .sort((a, b) => avg(b) - avg(a) || a.playerId.localeCompare(b.playerId))
    .slice(0, n)
    .map((t) => t.playerId)
}

/** A school's run and last five: +3 for 3연승, −2 for 2연패. */
export interface TeamForm {
  teamId: string
  games: number
  wins: number
  losses: number
  streak: number
  /** Wins in the last five (null before five games). */
  last5: number | null
}

export function teamForms(s: Season): TeamForm[] {
  return s.table.overall.map((x) => {
    const rows = resultsOf(s.games, x.teamId)
    const m = /^([WL])(\d+)$/.exec(x.streak)
    return {
      teamId: x.teamId,
      games: rows.length,
      wins: x.wins,
      losses: x.losses,
      streak: m ? (m[1] === 'W' ? 1 : -1) * Number(m[2]) : 0,
      last5: rows.length >= 5 ? rows.slice(-5).filter((r) => r.won).length : null,
    }
  })
}

/** A player's scoring swing big enough to talk about: 3 points, or 15% of his average, either way. */
export const bigSwing = (f: PlayerForm) => Math.abs(f.diff) >= Math.max(3, f.season * 0.15)

/** Who's hot and who's cold: schools on a run of 3 or with 4 of their last 5 (or 1), and players whose last five stand out. */
export function formWatch(s: Season, limit = 3): string[] {
  const teamLine = (f: TeamForm) =>
    `${s.team(f.teamId)} ${Math.abs(f.streak) >= 2 ? `${Math.abs(f.streak)}${f.streak > 0 ? '연승' : '연패'} · ` : ''}${f.last5 !== null ? `최근 5경기 ${record(f.last5, 5 - f.last5)} · ` : ''}시즌 ${record(f.wins, f.losses)}`
  const forms = teamForms(s)
  const hot = forms.filter((f) => f.streak >= 3 || (f.last5 ?? 0) >= 4).sort((a, b) => b.streak - a.streak || (b.last5 ?? 0) - (a.last5 ?? 0))
  const cold = forms.filter((f) => f.streak <= -3 || (f.last5 !== null && f.last5 <= 1)).sort((a, b) => a.streak - b.streak || (a.last5 ?? 0) - (b.last5 ?? 0))
  const players = playerForms(s).filter(bigSwing)
  const up = players.filter((f) => f.diff > 0).sort((a, b) => b.diff - a.diff)
  const down = players.filter((f) => f.diff < 0).sort((a, b) => a.diff - b.diff)
  return [
    ...hot.slice(0, limit).map((f) => `- 상승세 학교: ${teamLine(f)}`),
    ...cold.slice(0, limit).map((f) => `- 하락세 학교: ${teamLine(f)}`),
    ...up.slice(0, limit).map((f) => `- 물오른 선수: ${formLine(s, f)}`),
    ...down.slice(0, limit).map((f) => `- 주춤한 선수: ${formLine(s, f)}`),
  ]
}

/** Each race group's order, and the overall one, from some of the season's games. */
function orderFrom(s: Season, games: readonly FinalScore[]): { overall: string[]; groups: Map<string, string[]> } {
  const rows = computeRows(s.refs, games)
  const tb = s.config.season.standings.tiebreakers
  const rank = (ids: string[]) => rankTeams(ids, rows, games, tb, s.seed)
  const { conferences } = s.config.structure
  const byConference = s.config.season.playoffs.bracket === 'conference' && conferences.length > 0
  const groups = new Map(
    byConference
      ? conferences.map((c) => [c.id, rank(s.refs.filter((r) => r.conferenceId === c.id).map((r) => r.id))] as const)
      : [['league', rank(s.refs.map((r) => r.id))] as const],
  )
  return { overall: rank(s.refs.map((r) => r.id)), groups }
}

/**
 * What these games changed in the table: a new overall #1, places moved in
 * each race group (the biggest moves first), and who came into or fell out
 * of the playoff and play-in places.
 */
export function rankShift(s: Season, gameIds: ReadonlySet<number>, limit = 6): string[] {
  const without = s.games.filter((g) => !gameIds.has(g.id))
  if (without.length === s.games.length) return []
  const before = orderFrom(s, without)
  const after = orderFrom(s, s.games)
  const out: string[] = []
  if (before.overall[0] !== after.overall[0] && after.overall[0]) out.push(`- 전체 1위: ${s.team(before.overall[0] ?? '')} → ${s.team(after.overall[0])}`)
  const cut = cutoffs(s.config)
  for (const g of raceGroups(s)) {
    const was = before.groups.get(g.id) ?? []
    const now = after.groups.get(g.id) ?? []
    const moved = now
      .map((id, i) => ({ id, from: was.indexOf(id) + 1, to: i + 1 }))
      .filter((m) => m.from > 0 && m.from !== m.to)
      .sort((a, b) => Math.abs(b.from - b.to) - Math.abs(a.from - a.to) || a.to - b.to)
      .slice(0, limit)
    const where = g.id === 'league' ? '' : `${g.name} `
    if (moved.length) out.push(`- ${where}순위 이동: ${moved.map((m) => `${s.team(m.id)} ${m.from}위 → ${m.to}위`).join(', ')}`)
    if (!cut) continue
    const zones: [number, string][] = [[cut.direct, '플레이오프 직행권']]
    if (cut.field > cut.direct) zones.push([cut.field, '플레이-인권'])
    for (const [k, zone] of zones) {
      if (k >= now.length) continue
      const inNow = new Set(now.slice(0, k))
      const inBefore = new Set(was.slice(0, k))
      const came = now.slice(0, k).filter((id) => !inBefore.has(id))
      const fell = was.slice(0, k).filter((id) => !inNow.has(id))
      if (came.length || fell.length) {
        out.push(`- ${where}${zone}(${k}위 안): ${[came.length ? `진입 ${came.map(s.team).join(', ')}` : '', fell.length ? `밀려남 ${fell.map(s.team).join(', ')}` : ''].filter(Boolean).join(' · ')}`)
      }
    }
  }
  return out.length ? out : ['- 순위 변동 없음']
}

// ── A game ───────────────────────────────────────────────────────────────

/**
 * Where a game was decided, from both sides' box lines (empty unless both
 * have some): each kind of shot side by side with the gap in %p and the
 * points it made, then rebounds, assists, turnovers and steals, and the two
 * biggest gaps by a rough weight (a 10%p, 9 points from threes, 8 rebounds,
 * 6 assists, 5 turnovers and 4 steals each count as one).
 */
export function gameEdges(s: Season, game: { home: string; away: string; homeScore: number; awayScore: number }, lines: readonly BoxLine[]): string[] {
  const homeWon = game.homeScore > game.awayScore
  const [w, l] = homeWon ? [game.home, game.away] : [game.away, game.home]
  const sum = (team: string, key: Key) => {
    const col = s.cols[key]
    return col ? lines.filter((x) => x.teamId === team).reduce((t, x) => t + (x.stats[col] ?? 0), 0) : null
  }
  if (!lines.some((x) => x.teamId === w) || !lines.some((x) => x.teamId === l)) return []
  const W = s.team(w)
  const L = s.team(l)
  const out: string[] = []
  const gaps: { label: string; weight: number; side: string }[] = []
  for (const [m, a, label] of SHOTS) {
    const [wm, wa, lm, la] = [sum(w, m), sum(w, a), sum(l, m), sum(l, a)]
    if (wm === null || wa === null || lm === null || la === null || wa === 0 || la === 0) continue
    const [wp, lp] = [shown((wm / wa) * 100), shown((lm / la) * 100)]
    // Points from the shot: threes count three, free throws one.
    const points = m === 'tpm' ? `, 3점으로 ${wm * 3}점 대 ${lm * 3}점` : m === 'ftm' ? `, 자유투로 ${wm}점 대 ${lm}점` : ''
    out.push(`- ${label} ${W} ${percent(wm, wa)}(${wm}/${wa}) 대 ${L} ${percent(lm, la)}(${lm}/${la}), ${one(Math.abs(wp - lp))}%p 차${points}`)
    const weight = m === 'tpm' ? Math.abs(wm - lm) / 3 : m === 'ftm' ? Math.abs(wm - lm) / 5 : Math.abs(wp - lp) / 10
    const side = m === 'fgm' ? (wp > lp ? W : wp < lp ? L : '') : wm > lm ? W : wm < lm ? L : ''
    gaps.push({ label, weight, side })
  }
  const counts: [Key, string, number, boolean][] = [
    ['reb', '리바', 8, false],
    ['ast', '어시', 6, false],
    ['to', '턴오버', 5, true],
    ['stl', '스틸', 4, false],
  ]
  for (const [k, label, per, fewer] of counts) {
    const [a, b] = [sum(w, k), sum(l, k)]
    if (a === null || b === null || a + b === 0) continue
    out.push(`- ${label} ${W} ${a} 대 ${L} ${b}${a !== b ? `(${Math.abs(a - b)}개 차)` : ''}`)
    gaps.push({ label, weight: Math.abs(a - b) / per, side: a === b ? '' : (a < b) === fewer ? W : L })
  }
  const top = gaps.filter((g) => g.side && g.weight >= 1).sort((a, b) => b.weight - a.weight).slice(0, 2)
  if (top.length) out.push(`- 가장 크게 갈린 곳: ${top.map((g) => `${g.label}(${g.side} 우위)`).join(', ')}`)
  return out
}

/**
 * What a game thread gets beside the game itself: both schools' seasons and
 * meetings, what the game changed in the table (a regular-season game), the
 * night's top players against their seasons, and where it was decided.
 */
export function gameBlocks(
  s: Season,
  game: { id: number; stage: string; home: string; away: string; homeScore: number; awayScore: number },
  lines: readonly BoxLine[],
  players: readonly string[],
): string[] {
  const regular = game.stage === 'regular'
  const teams = [
    `# 두 학교 시즌 기록 (정규시즌${regular ? ', 이 경기 포함' : ''}; 숫자는 여기 적힌 그대로)`,
    ...teamProfile(s, game.home),
    ...teamProfile(s, game.away),
    headToHead(s, game.home, game.away),
  ]
  if (regular) teams.push('이 경기로 바뀐 순위:', ...rankShift(s, new Set([game.id])))
  const score = (teamId: string) => (teamId === game.home ? game.homeScore : game.awayScore)
  const night = players.flatMap((id) => {
    const line = lines.find((l) => l.playerId === id)
    return line ? [nightInContext(s, line, score(line.teamId), regular)] : []
  })
  const edges = gameEdges(s, game, lines)
  return [
    teams.join('\n'),
    night.length ? `# 오늘 활약과 시즌 기록\n${night.join('\n')}` : '',
    edges.length ? `# 승부를 가른 숫자 (이긴 쪽 먼저)\n${edges.join('\n')}` : '',
  ].filter(Boolean)
}

/**
 * A round-up's column material (a session's, in 2K 일정대로): the standings
 * race, who's hot and cold, and what the round changed in the table.
 */
export function roundBlocks(s: Season, label: string, gameIds: ReadonlySet<number>): string[] {
  const race = standingsRace(s)
  const form = formWatch(s)
  const shift = rankShift(s, gameIds)
  return [
    race.length ? `# 순위 경쟁 (${label}까지; 숫자는 여기 적힌 그대로)\n${race.join('\n')}` : '',
    form.length ? `# 상승세와 하락세\n${form.join('\n')}` : '',
    shift.length ? `# ${label}로 바뀐 것\n${shift.join('\n')}` : '',
  ].filter(Boolean)
}
