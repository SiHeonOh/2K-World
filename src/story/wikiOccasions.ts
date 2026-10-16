import { awardTitle } from '@shared/awards'
import type { EventPayloads, LeagueEvent } from '@shared/events'
import { seriesTitle, type BracketSpot } from '@shared/season'
import { setStoryValue, storyValue } from '@data/community'
import { jsonField, validJson, type Db } from '@data/db'
import { playerName, short, type League } from './context'
import { particle } from './wiki'
import { seriesStandouts, WIKI_EDITS, wikiEditInput, type WikiEditInput } from './wikiEdits'

/**
 * Wiki edits after awards, draft swaps and playoff series ("occasions").
 *
 * This news comes in bursts (awards typed in one by one, a draft's swaps over
 * a few looks), so each kind keeps one job waiting that later news joins: the
 * job's input carries its items, and joining rebuilds the input from all of
 * them. Something taken back while its job waits (an award removed, a swap
 * vetoed, a series result changed) just leaves it. Once written, an award
 * taken back is a short line (with the winner's page) for an awards job's
 * editors; a vetoed swap and a changed series result get their own items,
 * since pages need putting right. Only what a job that ran (or runs) held
 * counts as written. Words putting something right wait in story state
 * while no job may be made (the community off, Claude Code unusable).
 */

export type OccasionKind = 'award' | 'draft' | 'playoffs'
export const OCCASION_KINDS: readonly OccasionKind[] = ['award', 'draft', 'playoffs']

/** A series result as written, so a later change can say what no longer stands. */
export interface SeriesResult {
  winner: string
  loser: string
  /** The title it gave the winner ('우승', '동 컨퍼런스 우승'), if any. */
  title?: string
}

/** One piece of news: its facts and the pages it touches. `key` finds it again when it's taken back. */
export interface OccasionItem {
  key: string
  facts: string[]
  players: string[]
  teams: string[]
  /** Schools whose fans turn up as editors besides `teams` (an award winner's, the one he won it for). Left out: the players' schools now. */
  cast?: string[]
  /** A series item's result. */
  result?: SeriesResult
}

/** A line about news taken back after it was written; `key` is the item it undoes, `players` the pages it puts right. */
export interface OccasionNote {
  key: string
  text: string
  /** Missing on lines kept before they named their pages. */
  players?: string[]
  cast?: string[]
}

export interface WikiOccasion {
  kind: OccasionKind
  seasonId: number
  items: OccasionItem[]
  notes: OccasionNote[]
}

/**
 * Words putting right what was written, waiting for a job: lines about
 * awards taken back, and the items for a vetoed swap or a changed series
 * result (with the new result), held while no job may be made.
 */
export interface TakenBack {
  notes: OccasionNote[]
  items: OccasionItem[]
}

/** Players and schools one job writes about at most (each may get its two edits: see maxEdits). Later news starts another job. */
export const OCCASION_TARGETS = 12
/** "Taken back" lines one job carries, and the most kept waiting (the newest). */
export const MAX_NOTES = 6

/** What each kind of job tells its editors, in front of the pages they may edit. */
const NOTES: Record<OccasionKind, string> = {
  award:
    '이번 일은 수상이다. 수상자 문서의 이번 시즌 문단에 무슨 상을 언제 받았는지 녹여 쓴다. 시즌 상(MVP, 올-리그 팀 등)은 시즌을 정리하는 문장의 중심이 될 만하고, 주간·월간 상은 한 구절이면 된다. "수상 취소"로 적힌 상은 없던 일이다: 쓰지 않고, 그 선수 문서에 적혀 있으면 빼고 다시 정리한다.',
  draft:
    '이번 일은 드래프트다. 스왑으로 옮긴 선수 문서는 개요의 소속을 새 학교로 고치고, 이번 시즌 문단 끝에 드래프트로 학교를 옮긴 일과 새 학교를 쓴다. 학교 문서는 이번 시즌 문단에 누구를 내주고 누구를 데려왔는지 정리한다. "무효"로 적힌 스왑은 되돌려진 것이다: 원래 학교로 돌아갔다고 고친다.',
  playoffs:
    '이번 일은 플레이오프다. 학교 문서의 이번 시즌 문단에 결과(라운드, 상대, 승패)를 녹여 쓴다. "우승:"으로 시작하는 줄의 학교는 리그 우승이다: 시즌 문단에 우승을 분명히 쓴다. "컨퍼런스 우승"은 컨퍼런스 우승으로만 쓴다. 진 학교가 떨어졌다고 쓰는 건 플레이오프 시리즈에서 졌거나 "탈락"으로 적힌 경우뿐이다: 플레이-인에서 지고도 다음 경기가 남은 학교는 떨어지지 않았다. 활약한 선수 문서에는 "활약" 줄의 기록만 쓴다. "정정"으로 적힌 결과는 바뀐 것이다: 문서에 옛 결과(우승 포함)가 적혀 있으면 고친다.',
}

/** The occasion an event belongs to, or null (protections and passes need no wiki edits). */
export function occasionOf(e: LeagueEvent): OccasionKind | null {
  switch (e.type) {
    case 'award_given':
    case 'award_removed':
      return 'award'
    case 'draft_swap':
      return 'draft'
    case 'move_vetoed':
      return (e.payload as EventPayloads['move_vetoed']).kind === 'draft-swap' ? 'draft' : null
    case 'series_won':
    case 'series_result_changed':
      return 'playoffs'
    default:
      return null
  }
}

/** '로' or '으로' after a word (로 after ㄹ too: 가람고로, 한결로, 지훈으로). */
const toward = (word: string) => particle(word, '으로', '로')

type AwardPayload = EventPayloads['award_given']

const awardKey = (a: AwardPayload) => `award:${a.awardId}:${a.period}:${a.teamRank}:${a.playerId}`
const seriesKey = (seriesId: number) => `series:${seriesId}`
/** The line putting right a written result `winner` no longer holds. */
const fixKey = (seriesId: number, winner: string) => `fix:series:${seriesId}:${winner}`

const ORDINALS = ['퍼스트', '세컨드', '서드']

/** A selection's team by rank, as it's said: '올-리그 팀' → '올-리그 퍼스트 팀', '올-리그 4번째 팀'. */
function selectionTeam(name: string, rank: number): string {
  return `${name.trim().replace(/\s*팀$/, '')} ${ORDINALS[rank - 1] ?? `${rank}번째`} 팀`
}

/**
 * "MVP(시즌 상) — 가나다 (가람고)", "3주차 동부 이주의 선수(주간 상) — …": the
 * group as it was given (the event keeps it). `teamId` is the school he won it for.
 */
function awardText(league: League, a: AwardPayload, teamId: string): string {
  const season = league.config.awards.season.find((x) => x.id === a.awardId)
  const periodic = league.config.awards.periodic.find((x) => x.id === a.awardId)
  const name = season?.kind === 'selection' ? selectionTeam(season.name, a.teamRank) : awardTitle(league.config, a)
  const what = season ? '시즌 상' : periodic?.period === 'month' ? '월간 상' : '주간 상'
  return `${name}(${what}) — ${playerName(league, a.playerId)} (${short(league, teamId)})`
}

/** The school a player won an award for: kept with the award (a move since doesn't change it), or his school now. */
function awardTeam(league: League, seasonId: number, a: AwardPayload): string {
  const row = league.db
    .prepare('SELECT team_id FROM awards WHERE season_id = ? AND award_id = ? AND period = ? AND team_rank = ? AND player_id = ? ORDER BY id DESC LIMIT 1')
    .get(seasonId, a.awardId, a.period, a.teamRank, a.playerId) as { team_id: string | null } | undefined
  return row?.team_id ?? league.players.get(a.playerId)?.teamId ?? ''
}

function awardItem(league: League, a: AwardPayload, seasonId: number): OccasionItem {
  const team = awardTeam(league, seasonId, a)
  return { key: awardKey(a), facts: [`수상: ${awardText(league, a, team)}`], players: [a.playerId], teams: [], cast: team ? [team] : [] }
}

/**
 * The line for an award taken back after it was written: what its editors
 * were told, now undone, with the winner's page. The fans who turn up are
 * the award's (the school he won it for), or with none kept his school's now.
 */
function removalNote(league: League, key: string, was: OccasionItem, a: AwardPayload): OccasionNote {
  const told = was.facts[0]?.replace(/^수상: /, '') ?? awardText(league, a, league.players.get(a.playerId)?.teamId ?? '')
  return { key, text: `수상 취소(없던 일이 됨): ${told}`, players: [a.playerId], ...(was.cast ? { cast: was.cast } : {}) }
}

function swapItem(league: League, s: EventPayloads['draft_swap']): OccasionItem {
  const by = short(league, s.teamId)
  const from = short(league, s.targetTeamId)
  const got = playerName(league, s.targetPlayerId)
  const gave = playerName(league, s.playerId)
  return {
    key: `swap:${s.actionId}`,
    facts: [
      `드래프트 스왑: ${by}${particle(by, '이', '가')} ${from}의 ${got}${particle(got, '을', '를')} 지명하고 ${gave}${particle(gave, '을', '를')} 내줌`,
      `${got}: 드래프트 스왑으로 ${from}에서 ${by}${toward(by)} 이적`,
      `${gave}: 드래프트 스왑으로 ${by}에서 ${from}${toward(from)} 이적`,
    ],
    players: [s.targetPlayerId, s.playerId],
    teams: [s.teamId, s.targetTeamId],
  }
}

/** A vetoed swap that was already written up: both players went back, and their pages and both schools' need putting right. */
function vetoItem(league: League, actionId: number): OccasionItem | null {
  const a = league.db.prepare("SELECT team_id, player_id, target_player_id, target_team_id FROM draft_actions WHERE id = ? AND kind = 'swap'").get(actionId) as
    | { team_id: string; player_id: string | null; target_player_id: string | null; target_team_id: string | null }
    | undefined
  if (!a?.player_id || !a.target_player_id || !a.target_team_id) return null
  const by = short(league, a.team_id)
  const from = short(league, a.target_team_id)
  const got = playerName(league, a.target_player_id)
  const gave = playerName(league, a.player_id)
  return {
    key: `veto:${actionId}`,
    facts: [
      `드래프트 스왑 무효(되돌려짐): ${by}의 ${got} 지명이 취소돼 ${got}${particle(got, '은', '는')} ${from}${toward(from)}, ${gave}${particle(gave, '은', '는')} ${by}${toward(by)} 돌아감. 이적은 없던 일이 됐다`,
    ],
    players: [a.target_player_id, a.player_id],
    teams: [a.team_id, a.target_team_id],
  }
}

interface SeriesInfo {
  label: string
  /** What the winner takes: '우승' (the league's), a conference's ('동 컨퍼런스 우승'), or null. */
  title: string | null
  /** A final follows (a conference title is the way there). */
  finalsNext: boolean
  /** Where the two schools go after a play-in game: ' — 가람고는 …'. */
  after: (winner: string, loser: string) => string
}

/**
 * What a series is called and what winning it means, as the bracket says
 * (core/playoffs.ts): a play-in game by its slot (7·8위전, 9·10위전, 8번 시드
 * 결정전: the first one's loser plays again), a round, a group's last round
 * (컨퍼런스 결승) and the final. Titles go by seriesTitle, as on the
 * 플레이오프 screen: the champion is the final's winner, and with no final
 * ('none') one group's last round is the final.
 */
function seriesInfo(league: League, seriesId: number): SeriesInfo {
  const { db, config } = league
  const row = db.prepare('SELECT season_id, stage, round, slot, conference_id FROM series WHERE id = ?').get(seriesId) as
    | { season_id: number; stage: BracketSpot['stage']; round: number; slot: string; conference_id: string | null }
    | undefined
  const none = { title: null, finalsNext: false, after: () => '' }
  if (!row) return { label: '플레이오프', ...none }
  const conference = config.structure.conferences.find((c) => c.id === row.conference_id)?.name
  const group = conference ? `${conference} 컨퍼런스` : ''
  const named = (what: string) => (group ? `${group} ${what}` : what)
  if (row.stage === 'finals') return { label: '파이널', ...none, title: '우승' }
  const is = (s: string) => (w: string) => `${w}${particle(w, '은', '는')} ${s}`
  if (row.stage === 'play-in') {
    const d = config.season.playoffs.directSeeds
    const game = row.slot.split(':').at(-1)
    if (game === 'a') {
      return {
        label: named(`플레이-인 ${d + 1}·${d + 2}위전`),
        ...none,
        after: (w, l) => ` — ${is(`${d + 1}번 시드로 플레이오프 진출`)(w)}, ${is(`탈락하지 않고 ${d + 2}번 시드 결정전으로`)(l)}`,
      }
    }
    if (game === 'b') return { label: named(`플레이-인 ${d + 3}·${d + 4}위전`), ...none, after: (w, l) => ` — ${is(`${d + 2}번 시드 결정전으로`)(w)}, ${is('탈락')(l)}` }
    if (game === 'c') return { label: named(`플레이-인 ${d + 2}번 시드 결정전`), ...none, after: (w, l) => ` — ${is(`${d + 2}번 시드로 플레이오프 진출`)(w)}, ${is('탈락')(l)}` }
    return { label: named('플레이-인'), ...none }
  }
  const bracket = db.prepare('SELECT stage, round, conference_id AS "group" FROM series WHERE season_id = ?').all(row.season_id) as BracketSpot[]
  const title = seriesTitle(bracket, { stage: row.stage, round: row.round, group: row.conference_id })
  if (title === null) return { label: named(`플레이오프 ${row.round}라운드`), ...none }
  // A group's last round, with the final after it, or none (then one group's is the league's final).
  const finalsNext = bracket.some((s) => s.stage === 'finals')
  return { label: named('결승'), ...none, finalsNext, title: title === 'league' ? '우승' : named('우승') }
}

/** A series won: the result (one game's score for a single game), the title it gives, and its standouts (whose pages it touches too). */
function seriesItem(league: League, s: EventPayloads['series_won']): OccasionItem {
  const info = seriesInfo(league, s.seriesId)
  const w = short(league, s.winner)
  const l = short(league, s.loser)
  const games = league.db.prepare("SELECT home_id, home_score, away_score FROM games WHERE series_id = ? AND status = 'final'").all(s.seriesId) as {
    home_id: string
    home_score: number
    away_score: number
  }[]
  // A single game: its score, not "1-0".
  const one = games.length === 1 ? games[0]! : null
  const [won, lost] = one ? (one.home_id === s.winner ? [one.home_score, one.away_score] : [one.away_score, one.home_score]) : [s.wins, s.losses]
  const facts = [`${info.label}: ${w}${particle(w, '이', '가')} ${l}${particle(l, '을', '를')} ${won}-${lost}${toward(String(lost))} 꺾음${info.after(w, l)}`]
  if (info.title === '우승') facts.push(`우승: ${w} (준우승 ${l})`)
  else if (info.title) facts.push(`${info.title}: ${w} (${info.finalsNext ? '파이널 진출' : `준우승 ${l}`})`)
  const stars = seriesStandouts(league, s.seriesId)
  facts.push(...stars.map((x) => `${info.label} ${one ? '' : '시리즈 '}활약: ${x.text}`))
  return {
    key: seriesKey(s.seriesId),
    facts,
    players: stars.map((x) => x.playerId),
    teams: [s.winner, s.loser],
    result: { winner: s.winner, loser: s.loser, ...(info.title ? { title: info.title } : {}) },
  }
}

/** What a written series item said (items written before they kept it: the winner first, the title from its lines). */
function resultOf(item: OccasionItem): SeriesResult | null {
  if (item.result) return item.result
  const [winner, loser] = item.teams
  if (!winner || !loser) return null
  return { winner, loser, ...(item.facts.some((f) => f.startsWith('우승:')) ? { title: '우승' } : {}) }
}

/**
 * The latest item with a key that editors may have written, the job that
 * held it, and when that job ran (`ran`: jobs don't always run in the order
 * they were queued; a retry goes ahead). See writtenItem.
 */
export type Written = (key: string) => { item: OccasionItem; job: number; ran: string } | null

/** A series' games won by each of two schools so far, when they're still the two playing it. */
function seriesScore(league: League, seriesId: number, a: string, b: string): [number, number] | null {
  const row = league.db.prepare('SELECT high_team_id, low_team_id FROM series WHERE id = ?').get(seriesId) as { high_team_id: string | null; low_team_id: string | null } | undefined
  if (!row || ![row.high_team_id, row.low_team_id].includes(a) || ![row.high_team_id, row.low_team_id].includes(b)) return null
  const won = (team: string) =>
    (
      league.db
        .prepare(
          "SELECT COUNT(*) AS n FROM games WHERE series_id = ? AND status = 'final' AND ((home_id = ? AND home_score > away_score) OR (away_id = ? AND away_score > home_score))",
        )
        .get(seriesId, team, team) as { n: number }
    ).n
  return [won(a), won(b)]
}

/**
 * A written series result that no longer stands (`winner`: who holds it now,
 * if anyone): both schools' pages and its standouts' are put right, the
 * title too. One not decided again says where it stands, so editors needn't
 * guess. Null when no written result needs it, or a line putting it right
 * was written since.
 */
function correctionItem(league: League, seriesId: number, written: Written, winner: string | null): OccasionItem | null {
  const was = written(seriesKey(seriesId))
  const old = was && resultOf(was.item)
  if (!was || !old || old.winner === winner) return null
  const key = fixKey(seriesId, old.winner)
  const fixed = written(key)
  if (fixed && fixed.ran > was.ran) return null
  const info = seriesInfo(league, seriesId)
  const w = short(league, old.winner)
  const l = short(league, old.loser)
  const decided = (league.db.prepare('SELECT winner_id FROM series WHERE id = ?').get(seriesId) as { winner_id: string | null } | undefined)?.winner_id
  const score = decided ? null : seriesScore(league, seriesId, old.winner, old.loser)
  const open = decided ? '' : `. 이 시리즈는 아직 끝나지 않았다${score ? `(현재 ${w} 기준 ${score[0]}승 ${score[1]}패)` : ''}`
  return {
    key,
    facts: [
      `정정: ${info.label}에서 ${w}${particle(w, '이', '가')} ${l}${particle(l, '을', '를')} 꺾었다는 결과는 바뀌어 없던 일이 됐다${old.title ? `(${w}의 ${old.title}도 없던 일)` : ''}${open}`,
    ],
    // The old result's standouts' pages may tell of it too.
    players: was.item.players,
    teams: [old.winner, old.loser],
  }
}

/** The key of the words that take an item back: an award's line, a swap's veto, a series result's correction. */
function undoneBy(item: OccasionItem): string | null {
  if (item.key.startsWith('award:')) return item.key
  if (item.key.startsWith('swap:')) return `veto:${item.key.slice('swap:'.length)}`
  const series = /^series:(\d+)$/.exec(item.key)
  const result = series && resultOf(item)
  return series && result ? fixKey(Number(series[1]), result.winner) : null
}

/** Items that put written news right (they wait for a job like lines do). */
const putsRight = (item: OccasionItem) => item.key.startsWith('veto:') || item.key.startsWith('fix:')

/** Distinct players and schools these items touch, with the pages of the lines they carry. */
function targets(items: OccasionItem[], notes: OccasionNote[] = []): number {
  return new Set([
    ...items.flatMap((i) => [...i.players.map((p) => `p:${p}`), ...i.teams.map((t) => `t:${t}`)]),
    ...notes.flatMap((n) => (n.players ?? []).map((p) => `p:${p}`)),
  ]).size
}

export interface OccasionPlanOptions {
  /** New items and jobs may be made: the community is on and Claude Code works. Otherwise only take-backs are planned, and words putting right what was written wait. */
  create: boolean
  written: Written
}

/**
 * One look's news of one kind, folded into the jobs still waiting for it
 * (changed in place) and new jobs. New items join the latest waiting job
 * while it has room; something taken back leaves wherever it waits; a job
 * left with nothing to write (no items, no lines) is dropped. What was taken
 * back after it was written (`written`) gets words: an award a line (going
 * to a job with room for its page, or a job of its own), a swap or a series
 * result an item of its own. While no job may be made, words with no job to
 * go to wait (`pending`) for the next plan that may make one.
 */
export function planOccasion(
  league: League,
  kind: OccasionKind,
  seasonId: number,
  waiting: WikiOccasion[],
  events: LeagueEvent[],
  pending: TakenBack,
  opts: OccasionPlanOptions,
): { added: WikiOccasion[]; pending: TakenBack } {
  // An item never waits beside the words taking it back: a job put back in the queue (a usage limit, the app
  // closed, a failed first try) still holds what was taken back while it ran.
  const words = new Set([
    ...[...pending.notes, ...waiting.flatMap((w) => w.notes)].map((n) => n.key),
    ...[...pending.items, ...waiting.flatMap((w) => w.items)].filter(putsRight).map((i) => i.key),
  ])
  for (const w of waiting) w.items = w.items.filter((i) => !words.has(undoneBy(i) ?? ''))
  // Words held while no job could be made go out with this look's news.
  const fresh: OccasionItem[] = opts.create ? [...pending.items] : []
  let held: OccasionItem[] = opts.create ? [] : [...pending.items]
  let notes = [...pending.notes]
  const drop = (key: string) => {
    const at = fresh.findIndex((i) => i.key === key)
    if (at >= 0) fresh.splice(at, 1)
    held = held.filter((x) => x.key !== key)
    for (const w of waiting) w.items = w.items.filter((x) => x.key !== key)
  }
  const forget = (key: string) => {
    notes = notes.filter((n) => n.key !== key)
    for (const w of waiting) w.notes = w.notes.filter((n) => n.key !== key)
  }
  const add = (item: OccasionItem | null) => {
    if (!item) return
    drop(item.key)
    fresh.push(item)
  }
  // Words putting right what was written: held until a job may be made.
  const putRight = (item: OccasionItem | null) => {
    if (!item) return
    drop(item.key)
    if (opts.create) fresh.push(item)
    else held.push(item)
  }
  for (const e of events) {
    if (e.type === 'award_given') {
      const a = e.payload as AwardPayload
      // Given again after it was taken back: the news is the award, not that it went.
      forget(awardKey(a))
      if (opts.create) add(awardItem(league, a, e.seasonId ?? seasonId))
    } else if (e.type === 'award_removed') {
      const a = e.payload as AwardPayload
      const key = awardKey(a)
      drop(key)
      // Only what editors may have written needs a line saying it's gone.
      const was = opts.written(key)
      if (was) {
        forget(key)
        notes.push(removalNote(league, key, was.item, a))
      }
    } else if (e.type === 'draft_swap') {
      if (opts.create) add(swapItem(league, e.payload as EventPayloads['draft_swap']))
    } else if (e.type === 'move_vetoed') {
      const v = e.payload as EventPayloads['move_vetoed']
      if (v.kind !== 'draft-swap') continue
      drop(`swap:${v.refId}`)
      // A written swap gets its pages put right; one never written just leaves its job.
      if (opts.written(`swap:${v.refId}`)) putRight(vetoItem(league, v.refId))
    } else if (e.type === 'series_result_changed') {
      const c = e.payload as EventPayloads['series_result_changed']
      drop(seriesKey(c.seriesId))
      putRight(correctionItem(league, c.seriesId, opts.written, c.after))
    } else if (e.type === 'series_won') {
      const s = e.payload as EventPayloads['series_won']
      // A waiting line saying this winner's result is void is out of date.
      drop(fixKey(s.seriesId, s.winner))
      // A flipped result: what was written for the old winner (a title too) is put right, and the new result
      // goes with it (held too while no job may be made: the words would say who no longer won, not who did).
      const fix = correctionItem(league, s.seriesId, opts.written, s.winner)
      if (opts.create) add(seriesItem(league, s))
      else if (fix) putRight(seriesItem(league, s))
      putRight(fix)
    }
  }
  const alive = waiting.filter((w) => w.items.length > 0 || w.notes.length > 0)
  const added: WikiOccasion[] = []
  const fits = (job: WikiOccasion, item: OccasionItem) => job.items.length + job.notes.length === 0 || targets([...job.items, item], job.notes) <= OCCASION_TARGETS
  let into = alive.at(-1) ?? null
  for (const item of fresh) {
    if (!into || !fits(into, item)) {
      into = { kind, seasonId, items: [], notes: [] }
      added.push(into)
    }
    into.items.push(item)
  }
  // Lines go where there's room for their pages, the newest waiting job first.
  const homes = [...alive].reverse().concat(added)
  const room = (job: WikiOccasion, note: OccasionNote) => job.notes.length < MAX_NOTES && targets(job.items, [...job.notes, note]) <= OCCASION_TARGETS
  const placed = new Set(homes.flatMap((h) => h.notes.map((n) => n.key)))
  const left: OccasionNote[] = []
  for (const note of notes) {
    if (placed.has(note.key)) continue
    const home = homes.find((h) => room(h, note))
    if (home) home.notes.push(note)
    else left.push(note)
    placed.add(note.key)
  }
  if (!opts.create) return { added, pending: { notes: left.slice(-MAX_NOTES), items: held } }
  // The rest get a job of their own: no awards may come this season to carry them.
  for (const note of left) {
    let home = added.find((h) => room(h, note))
    if (!home) {
      home = { kind, seasonId, items: [], notes: [] }
      added.push(home)
    }
    home.notes.push(note)
  }
  return { added, pending: { notes: [], items: [] } }
}

/** A rebuilt occasion only lost items or lines: nothing joined it, so its job is no fresher than before. */
export function onlyLost(before: WikiOccasion, after: WikiOccasion): boolean {
  const had = new Set([...before.items, ...before.notes].map((x) => JSON.stringify(x)))
  return [...after.items, ...after.notes].every((x) => had.has(JSON.stringify(x)))
}

/**
 * A job's input from its occasion: every item's facts and pages, then the
 * lines about what was taken back (with their players' pages), with the note
 * on what kind of news it is. A job may be lines alone. Null when nothing is
 * left to write.
 */
export function occasionInput(league: League, occasion: WikiOccasion): WikiEditInput | null {
  const first = occasion.items[0]?.key ?? occasion.notes[0]?.key
  if (first === undefined) return null
  const unique = (xs: string[]) => [...new Set(xs.filter(Boolean))]
  const players = unique([...occasion.items.flatMap((i) => i.players), ...occasion.notes.flatMap((n) => n.players ?? [])])
  const teams = unique(occasion.items.flatMap((i) => i.teams))
  const facts = [...occasion.items.flatMap((i) => i.facts), ...occasion.notes.map((n) => n.text)]
  // Fans of the schools involved turn up as editors: an award winner's (the school he won it for), or the players' now.
  const fans = [...occasion.items, ...occasion.notes].flatMap((i) => i.cast ?? (i.players ?? []).map((p) => league.players.get(p)?.teamId ?? ''))
  const input = wikiEditInput(league, { players, teams }, facts, `${occasion.kind}:${first}`, unique([...teams, ...fans]), NOTES[occasion.kind])
  return input && { ...input, occasion }
}

/**
 * The latest item with this key (this season's) that editors may have
 * written: in a job that's running, or one that finished and saved
 * something. Null when none did (still waiting, cancelled, failed, or a
 * number check's first try that saved nothing). Latest by when the job ran,
 * since a retry runs ahead of jobs queued before it.
 */
export function writtenItem(db: Db, seasonId: number, key: string): { item: OccasionItem; job: number; ran: string } | null {
  const row = db
    .prepare(
      // instr first: a cheap look for the key, so only the few jobs that hold it are read as JSON.
      `SELECT j.id, COALESCE(j.started_at, j.created_at) AS ran, i.value AS item FROM jobs j, json_each(${validJson('j.input')}, '$.occasion.items') i
       WHERE j.kind = ? AND j.status IN ('running', 'done') AND instr(j.input, ?) > 0
         AND ${jsonField('j.input', '$.occasion.seasonId')} = ? AND json_extract(i.value, '$.key') = ?
         AND (j.status = 'running' OR EXISTS (SELECT 1 FROM wiki_revisions r WHERE r.job_id = j.id))
       ORDER BY ran DESC, j.id DESC LIMIT 1`,
    )
    .get(WIKI_EDITS, JSON.stringify(key), seasonId, key) as { id: number; ran: string; item: string } | undefined
  return row ? { item: JSON.parse(row.item) as OccasionItem, job: row.id, ran: row.ran } : null
}

const TAKEN_BACK = 'wiki-taken-back'

/** As kept in story state: the awards' lines (`notes`, kept since before items were), and the other kinds' items. */
interface Kept {
  seasonId: number
  notes: OccasionNote[]
  items?: Partial<Record<OccasionKind, OccasionItem[]>>
}

function kept(db: Db): Kept | null {
  try {
    const v = JSON.parse(storyValue(db, TAKEN_BACK) ?? 'null') as Kept | null
    return v && typeof v.seasonId === 'number' ? v : null
  } catch {
    return null
  }
}

/** Words putting right what was written that wait for a job of this kind (this season's only). */
export function takenBack(db: Db, seasonId: number, kind: OccasionKind): TakenBack {
  const v = kept(db)
  if (!v || v.seasonId !== seasonId) return { notes: [], items: [] }
  const items = v.items?.[kind]
  return { notes: kind === 'award' && Array.isArray(v.notes) ? v.notes : [], items: Array.isArray(items) ? items : [] }
}

export function keepTakenBack(db: Db, seasonId: number, kind: OccasionKind, words: TakenBack): void {
  const v = kept(db)
  const was = v && v.seasonId === seasonId ? v : null
  const notes = kind === 'award' ? words.notes : was && Array.isArray(was.notes) ? was.notes : []
  const items = Object.fromEntries(Object.entries({ ...was?.items, [kind]: words.items }).filter(([, xs]) => Array.isArray(xs) && xs.length > 0))
  if (notes.length === 0 && Object.keys(items).length === 0 && storyValue(db, TAKEN_BACK) === null) return
  setStoryValue(db, TAKEN_BACK, JSON.stringify({ seasonId, notes, ...(Object.keys(items).length > 0 ? { items } : {}) }))
}

/** Whether words putting right what was written wait for a job of any kind (this season's). */
export function anyTakenBack(db: Db, seasonId: number): boolean {
  return OCCASION_KINDS.some((kind) => {
    const words = takenBack(db, seasonId, kind)
    return words.notes.length + words.items.length > 0
  })
}
