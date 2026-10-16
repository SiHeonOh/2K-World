import { rng, shuffle } from '@core/random'
import { leaders, seasonTotals } from '@core/stats'
import { DEFAULT_TOPIC_MIX, TOPIC_KINDS, type TopicKind } from '@shared/config/schema'
import { leaderLabel } from '@shared/labels'
import { playedMode, roundLabel } from '@shared/played'
import { currentSeason, listPlayers, listTeams } from '@data/league'
import { listGames, seasonBoxLines, standings } from '@data/season'
import { listAwards } from '@data/moves'
import type { League } from './context'
import {
  bigSwing,
  closeRaces,
  headToHead,
  playerForms,
  playerSeason,
  readSeason,
  standingsRace,
  teamForms,
  teamProfile,
  topScorers,
  type Season,
} from './statsPack'

/**
 * What the forum talks about between games. A real board is mostly not game
 * recaps: it's lore and nicknames, 찌라시, rival-school wars, roasting the
 * league, tier lists, stat nerds, bold predictions, shitposts, off-topic
 * school life, newbie questions and polls, now and then a long analysis
 * post. Each chatter batch gets a planned mix of these, every one with real
 * facts from the league, so the writers have something true to riff on and
 * every refresh feels different; and a planned mix of lengths, mostly short.
 */

/** How long a post should be: a one-liner (the title is the post), a few lines, a short post, or a long one (장문). */
export type PostLength = 'line' | 'short' | 'medium' | 'long'

export interface TopicSeed {
  kind: TopicKind
  /** Board role the post belongs on. */
  board: string
  /** What to write, in Korean. */
  brief: string
  /** Facts to build on (the only numbers and events the post may state as true). */
  facts: string[]
  /** An analysis topic's stats pack (statsPack.ts), one fact per line: the numbers it may use, as written. */
  pack?: string[]
  teams: string[]
  players: string[]
  /** Tag (말머리) the post should carry, if any. */
  tag?: string
  /** A poll topic's question and options: the post carries a real poll that fans vote on. */
  poll?: { question: string; options: string[] }
  length: PostLength
  /** What a long post reads as (분석글, 썰, 뇌피셜, 비교글). */
  form?: string
}

/** A topic before the plan gives it a length. */
type Draft = Omit<TopicSeed, 'length' | 'form'>
type Maker = (ctx: Ctx) => Draft | null

interface Ctx {
  league: League
  random: () => number
  pick: <T>(list: readonly T[]) => T | undefined
  roster: ReturnType<typeof listPlayers>
  ovr: (playerId: string) => number | null
  short: (teamId: string) => string
  slot: (slotId: string | null) => string
  /** Players already used in this batch, so one name doesn't carry every post. */
  used: Set<string>
  /** The season's numbers, read the first time a topic needs them. */
  season: () => Season
}

/**
 * Of every ten chatter posts, how many get each length, as on FMKorea's
 * sports boards (a day without games, and roughly a game day too): four
 * one-liners whose title is the post, three short, two medium, one long.
 * An analysis post is always long and counts toward its share.
 */
export const LENGTH_MIX: Record<PostLength, number> = { line: 4, short: 3, medium: 2, long: 1 }

/** Long posts a day at most, analysis included: a board sees one or two, and they cost the most to write. */
export const LONG_PER_DAY = 2

/** What a long post of each kind reads as; kinds not listed are never long. */
const LONG_FORM: Partial<Record<TopicKind, string>> = {
  analysis: '분석글',
  stats: '분석글',
  game_talk: '분석글',
  rankings: '비교글',
  rivalry: '비교글',
  school_pride: '비교글',
  lore_story: '썰',
  world_topic: '썰',
  off_topic: '썰',
  rumor: '뇌피셜',
  prediction: '뇌피셜',
  drama: '뇌피셜',
}

/** Kinds that stay short: a poll's body is a jab, a newbie asks in a line or two. */
const SHORT_ONLY: ReadonlySet<TopicKind> = new Set(['poll', 'newbie'])

/** Kinds that can be a one-liner (a title, a "(움짤) …" line): taunts, jokes, a scene, a call. The rest need a body. */
const LINE_OK: ReadonlySet<TopicKind> = new Set(['meme', 'off_topic', 'school_pride', 'game_talk', 'rivalry', 'league_roast', 'drama', 'prediction', 'poll', 'newbie'])

/**
 * Gives each topic its length by LENGTH_MIX: analysis long, then other
 * long-capable kinds while the long share and `longLeft` (today's) allow,
 * then medium, then one-liners, the rest short.
 */
function withLengths(drafts: Draft[], random: () => number, longLeft: number): TopicSeed[] {
  const quota = (length: PostLength) => Math.round((drafts.length * LENGTH_MIX[length]) / 10)
  const lengths = new Map<Draft, PostLength>()
  for (const d of drafts) if (d.kind === 'analysis') lengths.set(d, 'long')
  const open = (ok: (d: Draft) => boolean) => shuffle(drafts.filter((d) => !lengths.has(d) && ok(d)), random)
  const long = Math.max(0, Math.min(quota('long'), longLeft) - lengths.size)
  for (const d of open((x) => LONG_FORM[x.kind] !== undefined).slice(0, long)) lengths.set(d, 'long')
  for (const d of open((x) => !SHORT_ONLY.has(x.kind)).slice(0, quota('medium'))) lengths.set(d, 'medium')
  for (const d of open((x) => LINE_OK.has(x.kind)).slice(0, quota('line'))) lengths.set(d, 'line')
  return drafts.map((d) => {
    const length = lengths.get(d) ?? 'short'
    return length === 'long' ? { ...d, length, form: LONG_FORM[d.kind]! } : { ...d, length }
  })
}

/** Everyday things high-school basketball fans talk about when they aren't talking basketball. */
const OFF_TOPIC = [
  '시험 기간인데 농구만 보는 중',
  '오늘 급식 메뉴 평가',
  '야자 째고 직관 간 썰',
  '편의점 신상 리뷰',
  '알바하다 생긴 일',
  '수학여행/수련회 썰',
  '학교 축제 준비',
  '농구화 추천 질문',
  '동네 농구장 픽업게임 썰',
  '비 오는 날 체육관 냄새',
  '새벽에 하이라이트 돌려보는 사람',
  '응원 도구 만들기',
]

/** League-wide things to poke fun at, when the league's own facts back them up. */
const ROAST_ANGLES = [
  '리그 사무국 일처리 디스',
  '컨퍼런스 간 전력 차이 논쟁',
  '꼴찌권 학교 놀리기 (선 넘지 않게)',
  '플레이오프 방식 불만',
  '카드 드래프트 제도 불만/옹호',
  '트레이드 금지 학교 드립',
  '심판 판정 불만 (특정 실존 인물 아님)',
  '일정 짠 사람 누구냐',
]

function seedOfLore(c: Ctx, section: 'public' | 'rumor'): { kind: 'player' | 'team'; id: string; teamId: string } | null {
  const players = [...c.league.lore.player].filter(([id, e]) => e.sections[section] !== '' && !c.used.has(id))
  const teams = [...c.league.lore.team].filter(([, e]) => e.sections[section] !== '')
  const options = [...players.map(([id]) => ({ kind: 'player' as const, id, teamId: c.league.players.get(id)?.teamId ?? '' })), ...teams.map(([id]) => ({ kind: 'team' as const, id, teamId: id }))]
  return c.pick(options) ?? null
}

function playerFacts(c: Ctx, id: string): string[] {
  const p = c.roster.find((x) => x.id === id)
  if (!p) return []
  const facts = [`${p.name}: ${c.short(p.teamId)} ${c.slot(p.slotId)}${c.ovr(id) !== null ? `, OVR ${c.ovr(id)}` : ''}`]
  if (p.nicknames.length) facts.push(`별명: ${p.nicknames.join(', ')}`)
  if (p.notes) facts.push(`메모: ${p.notes.slice(0, 200)}`)
  return facts
}

/** Rival schools named in school lore (`rivals`). */
function rivalPairs(c: Ctx): [string, string][] {
  const pairs: [string, string][] = []
  for (const [id, e] of c.league.lore.team) {
    if (e.kind !== 'team') continue
    for (const r of e.settings.rivals) {
      const other = [...c.league.teams.values()].find((t) => t.shortName === r)
      if (other) pairs.push([id, other.id])
    }
  }
  return pairs
}

/**
 * What an analysis post digs into: its subject in a few words, the angle,
 * the style guide's skeleton for it (B a column, C player blocks, D a
 * preview), who's in it and their numbers.
 */
interface Subject {
  topic: string
  brief: string
  skeleton: 'B' | 'C' | 'D'
  teams: string[]
  players: string[]
  pack: string[]
}

/** Schools a few games into the season: a record worth reading. */
const settled = (s: Season, games = 4) => s.games.length * 2 >= s.refs.length * games

/**
 * Analysis subjects, each null when the season gives it nothing to stand on.
 * They don't mark players as used: only the one picked does.
 */
const SUBJECTS: ((c: Ctx, s: Season) => Subject | null)[] = [
  // A school on a run of three or more.
  (c, s) => {
    const f = c.pick(teamForms(s).filter((x) => Math.abs(x.streak) >= 3))
    if (!f) return null
    const team = c.short(f.teamId)
    const n = Math.abs(f.streak)
    const stars = topScorers(s, 2, f.teamId).filter((id) => !c.used.has(id))
    return {
      topic: `${team} ${n}${f.streak > 0 ? '연승' : '연패'}`,
      brief:
        f.streak > 0
          ? `${team}의 ${n}연승, 뭐가 달라졌나. 최근 5경기와 시즌 전체(득실, 슈팅, 홈·원정, 접전)를 비교해 이유를 짚고, "상대가 약했을 뿐"이라는 반론도 다룬다.`
          : `${team} ${n}연패, 어디서 무너졌나. 최근 5경기와 시즌 전체를 비교해 원인을 짚고, 반등할 근거가 있는지도 따진다.`,
      skeleton: 'B',
      teams: [f.teamId],
      players: stars,
      pack: [...teamProfile(s, f.teamId), ...stars.flatMap((id) => playerSeason(s, id))],
    }
  },
  // A record the roster or the points don't explain: above or below its OVR, or winning on a losing margin (and the other way).
  (c, s) => {
    if (!settled(s)) return null
    const strength = new Map(
      s.refs.map((t) => {
        const top = c.roster.filter((p) => p.teamId === t.id).map((p) => c.ovr(p.id)).filter((v): v is number => v !== null).sort((a, b) => b - a).slice(0, 5)
        return [t.id, top.length ? Number((top.reduce((x, y) => x + y, 0) / top.length).toFixed(1)) : null] as const
      }),
    )
    const byStrength = [...strength].filter(([, v]) => v !== null).sort((a, b) => b[1]! - a[1]! || a[0].localeCompare(b[0])).map(([id]) => id)
    const options = s.table.overall.flatMap((x, i) => {
      const team = c.short(x.teamId)
      const margin = x.pointsFor - x.pointsAgainst
      const lucky = (x.wins > x.losses && margin < 0) || (x.wins < x.losses && margin > 0)
      const r = byStrength.indexOf(x.teamId)
      const gap = byStrength.length === s.refs.length && r >= 0 ? r - i : 0
      const extra = gap !== 0 ? [`[${team}] 상위 5명 평균 OVR ${strength.get(x.teamId)}(리그 ${r + 1}위) · 성적 전체 ${i + 1}위`] : []
      const out: { teamId: string; topic: string; brief: string; extra: string[] }[] = []
      if (Math.abs(gap) >= 3) {
        out.push({
          teamId: x.teamId,
          topic: `${team} 전력 대비 ${gap > 0 ? '돌풍' : '부진'}`,
          brief: gap > 0 ? `${team}, OVR로는 아래쪽인데 성적은 위다: 진짜인지 거품인지 기록으로 따진다.` : `${team}, OVR로는 위인데 성적이 안 나온다: 어디가 문제인지 기록으로 따진다.`,
          extra,
        })
      }
      if (lucky) {
        out.push({
          teamId: x.teamId,
          topic: `${team} 성적과 득실이 따로 논다`,
          brief: `${team}, ${x.wins > x.losses ? '이기는 경기가 많은데 득실은 마이너스' : '지는 경기가 많은데 득실은 플러스'}다: 접전 성적과 경기 내용을 보고 운인지 실력인지 따진다.`,
          extra,
        })
      }
      return out
    })
    const o = c.pick(options)
    if (!o) return null
    const stars = topScorers(s, 1, o.teamId).filter((id) => !c.used.has(id))
    return {
      topic: o.topic,
      brief: o.brief,
      skeleton: 'B',
      teams: [o.teamId],
      players: stars,
      pack: [...o.extra, ...teamProfile(s, o.teamId), ...stars.flatMap((id) => playerSeason(s, id))],
    }
  },
  // A player whose last five are far from his season.
  (c, s) => {
    const f = c.pick(playerForms(s).filter((x) => bigSwing(x) && !c.used.has(x.playerId)))
    if (!f) return null
    const name = s.player(f.playerId)
    const up = f.diff > 0
    return {
      topic: `${name} 최근 5경기 ${up ? '상승세' : '부진'}`,
      brief: up
        ? `${name}의 최근 5경기, 진짜 성장인가 반짝인가. 시즌 평균과 최근 5경기를 나란히 놓고 슈팅과 팀 내 비중까지 따진다.`
        : `${name} 최근 5경기 부진, 슬럼프인가 일시적인가. 시즌 평균과 최근 5경기를 비교하고 팀 성적과도 엮는다.`,
      skeleton: 'B',
      teams: [f.teamId],
      players: [f.playerId],
      pack: [...playerSeason(s, f.playerId), ...teamProfile(s, f.teamId)],
    }
  },
  // A meeting that's next on the schedule, or two rival schools from lore.
  (c, s) => {
    const next = listGames(c.league.db, currentSeason(c.league.db).id)
      .filter((g) => g.status === 'scheduled' && g.stage === 'regular')
      .slice(0, 6)
    const g = c.pick(next)
    const pair = g ? ([g.away, g.home] as const) : c.pick(rivalPairs(c))
    if (!pair) return null
    const [a, b] = pair
    const stars = [...topScorers(s, 1, a), ...topScorers(s, 1, b)].filter((id) => !c.used.has(id))
    return {
      topic: g ? `다음 맞대결 ${c.short(a)} @ ${c.short(b)} 프리뷰` : `${c.short(a)} vs ${c.short(b)} 라이벌 비교`,
      brief: `${g ? '다음 맞대결 프리뷰' : '라이벌 두 학교 비교'}. 두 학교의 시즌 기록, 맞대결, 에이스를 나란히 놓고 어디서 갈릴지 짚는다. 예상은 예상이라고 밝히고, 일정은 자료에 있는 것만.`,
      skeleton: 'D',
      teams: [a, b],
      players: stars,
      pack: [...teamProfile(s, a), ...teamProfile(s, b), headToHead(s, a, b), ...stars.flatMap((id) => playerSeason(s, id))],
    }
  },
  // A close call in the standings: the top two, or either side of a playoff line.
  (c, s) => {
    if (!settled(s, 3)) return null
    const r = c.pick(closeRaces(s))
    if (!r) return null
    const [a, b] = r.teams
    return {
      topic: `${r.group} ${r.line} 경쟁`,
      brief: `${r.group} ${r.line} 다툼 분석: ${c.short(a)}, ${c.short(b)} 두 학교의 성적, 최근 흐름, 득실, 맞대결을 비교해 누가 유리한지 따진다. 남은 일정은 자료에 있는 것만.`,
      skeleton: 'D',
      teams: [a, b],
      players: [],
      pack: [...standingsRace(s, r.groupId), ...teamProfile(s, a), ...teamProfile(s, b), headToHead(s, a, b)],
    }
  },
  // Two of the league's best scorers, side by side (from different schools when there's a choice).
  (c, s) => {
    const top = topScorers(s, 6).filter((id) => !c.used.has(id))
    const a = c.pick(top.slice(0, 4))
    if (!a) return null
    const teamOf = (id: string) => s.totals.get(id)?.teamId ?? ''
    const rest = top.filter((id) => id !== a)
    const b = rest.find((id) => teamOf(id) !== teamOf(a)) ?? rest[0]
    if (!b) return null
    return {
      topic: `${s.player(a)} vs ${s.player(b)}`,
      brief: `${s.player(a)} vs ${s.player(b)}, 누가 더 나은 선수인가. 득점만이 아니라 슈팅 효율, 최근 흐름, 팀 내 비중, 팀 성적까지 비교하고, 반대쪽 주장도 하나 세운다.`,
      skeleton: 'C',
      teams: [...new Set([teamOf(a), teamOf(b)])],
      players: [a, b],
      pack: [...playerSeason(s, a), ...playerSeason(s, b), teamProfile(s, teamOf(a))[0]!, teamProfile(s, teamOf(b))[0]!],
    }
  },
]

const MAKERS: Record<TopicKind, Maker> = {
  lore_story: (c) => {
    const s = seedOfLore(c, 'public')
    if (s) {
      if (s.kind === 'player') c.used.add(s.id)
      return {
        kind: 'lore_story',
        board: 'free',
        brief: `${s.kind === 'player' ? '이 선수' : '이 학교'}의 이야기를 꺼내는 글: 별명 유래, 플레이 스타일, 알려진 뒷이야기 중 하나를 골라서. 로어의 [공개] 내용을 바탕으로 쓰고, 없는 사실은 지어내지 않는다.`,
        facts: s.kind === 'player' ? playerFacts(c, s.id) : [`학교: ${c.short(s.id)}`],
        teams: [s.teamId],
        players: s.kind === 'player' ? [s.id] : [],
      }
    }
    // No lore written yet: the roster's nicknames and notes are stories too.
    const p = c.pick(c.roster.filter((x) => (x.nicknames.length > 0 || x.notes) && !c.used.has(x.id)))
    if (!p) return null
    c.used.add(p.id)
    return { kind: 'lore_story', board: 'free', brief: '이 선수의 별명이나 특징에 대한 글. 별명이 어떻게 붙었을지는 팬들의 추측으로만.', facts: playerFacts(c, p.id), teams: [p.teamId], players: [p.id] }
  },

  rumor: (c) => {
    const s = seedOfLore(c, 'rumor')
    if (!s) return null
    if (s.kind === 'player') c.used.add(s.id)
    return {
      kind: 'rumor',
      board: 'trades',
      tag: '찌라시',
      brief: '로어의 [소문 — 확인 안 됨]을 "소문 OK"인 사람이 카더라로 꺼내는 글. 단정하지 않고, 댓글은 믿는 쪽과 "출처 어디냐"는 쪽으로 갈린다.',
      facts: s.kind === 'player' ? playerFacts(c, s.id) : [`학교: ${c.short(s.id)}`],
      teams: [s.teamId],
      players: s.kind === 'player' ? [s.id] : [],
    }
  },

  world_topic: (c) => {
    const w = c.pick(c.league.lore.world.filter((e) => e.kind === 'world' && (e.sections.public !== '' || e.sections.rumor !== '')))
    if (!w || w.kind !== 'world') return null
    const kinds: Record<string, string> = { topic: '논쟁/주제', event: '지난 사건', place: '장소', rivalry: '라이벌리' }
    return {
      kind: 'world_topic',
      board: 'main',
      brief: `세계관 문서 "${w.settings.id}"(${kinds[w.settings.type] ?? w.settings.type})에서 나온 글: 논쟁이면 편을 갈라 싸우고, 사건이면 회상하거나 재평가하고, 장소면 썰을 푼다. 로어의 내용만 사실로 쓴다.`,
      facts: [`주제: ${w.settings.id}`, ...(w.settings.involves.length ? [`관련: ${w.settings.involves.join(', ')}`] : []), ...(w.settings.date ? [`날짜: ${w.settings.date}`] : [])],
      teams: [],
      players: [],
    }
  },

  rivalry: (c) => {
    // Rivals from school lore first; otherwise two schools from one division with close records.
    const pairs = rivalPairs(c)
    const table = standings(c.league.db)
    if (pairs.length === 0) {
      const rows = table.overall
      for (let i = 0; i + 1 < rows.length; i++) pairs.push([rows[i]!.teamId, rows[i + 1]!.teamId])
    }
    const pair = c.pick(pairs)
    if (!pair) return null
    const [a, b] = pair
    const rec = (id: string) => table.overall.find((s) => s.teamId === id)
    const facts = [a, b].map((id) => `${c.short(id)} ${rec(id)?.wins ?? 0}승 ${rec(id)?.losses ?? 0}패`)
    const met = listGames(c.league.db, currentSeason(c.league.db).id).filter(
      (g) => g.status === 'final' && ((g.home === a && g.away === b) || (g.home === b && g.away === a)),
    )
    for (const g of met) facts.push(`맞대결: ${c.short(g.home)} ${g.homeScore} : ${g.awayScore} ${c.short(g.away)}`)
    if (met.length === 0) facts.push('이번 시즌 맞대결: 아직 없음')
    return {
      kind: 'rivalry',
      board: 'free',
      brief: '두 학교 팬들의 키배 글: 한쪽 팬이 도발하고, 상대 팬이 반격하고, 중립이 팝콘 각. 학교 부심과 디스는 되지만 금지선은 지킨다.',
      facts,
      teams: [a, b],
      players: [],
    }
  },

  league_roast: (c) => {
    const cfg = c.league.config
    const table = standings(c.league.db)
    const frozen = listTeams(c.league.db).filter((t) => t.control === 'frozen')
    const facts = [
      `리그: ${cfg.league.name}, ${c.league.teams.size}개 학교, 컨퍼런스 ${cfg.structure.conferences.length}개, 디비전 ${cfg.structure.divisions.length}개`,
      ...(table.overall.length ? [`1위 ${c.short(table.overall[0]!.teamId)}, 꼴찌 ${c.short(table.overall.at(-1)!.teamId)}`] : []),
      ...(frozen.length ? [`트레이드를 못 하는 학교: ${frozen.map((t) => t.shortName).join(', ')}`] : []),
      // Only the card swap runs; an old 'standard' setting never held a draft.
      `드래프트: ${cfg.draft.kind === 'card-swap' ? '카드 스왑 드래프트' : '없음'}`,
    ]
    return {
      kind: 'league_roast',
      board: 'humor',
      tag: '유머',
      brief: `리그 전체를 까거나 비꼬는 드립 글. 각도: ${c.pick(ROAST_ANGLES)}. 실존 인물이나 혐오 표현 없이, 리그와 제도를 웃기게 깐다.`,
      facts,
      teams: [],
      players: [],
    }
  },

  rankings: (c) => {
    const slots = c.league.config.roster.slots
    const slot = c.pick(slots)
    if (!slot) return null
    const top = c.roster
      .filter((p) => p.slotId === slot.id && c.ovr(p.id) !== null)
      .sort((a, b) => (c.ovr(b.id) ?? 0) - (c.ovr(a.id) ?? 0))
      .slice(0, 6)
    if (top.length < 3) return null
    return {
      kind: 'rankings',
      board: 'main',
      brief: `${slot.name} 티어표/TOP5 논쟁 글. 글쓴이가 순위를 매기고, 댓글에서 "이게 왜 여기냐" 키배. 능력치는 아래 숫자만 쓴다.`,
      facts: top.map((p, i) => `${i + 1}. ${p.name}(${c.short(p.teamId)}) OVR ${c.ovr(p.id)}`),
      teams: [...new Set(top.map((p) => p.teamId))],
      players: top.map((p) => p.id),
    }
  },

  stats: (c) => {
    const season = currentSeason(c.league.db)
    const lines = seasonBoxLines(c.league.db, season.id)
    const boards = leaders(c.league.config, seasonTotals(lines), 1, 5).filter((b) => b.rows.length > 0)
    const board = c.pick(boards)
    const name = (id: string) => c.league.players.get(id)?.name ?? id
    if (board) {
      return {
        kind: 'stats',
        board: 'main',
        tag: '분석',
        brief: `분석러가 쓰는 기록 글: ${leaderLabel(c.league.config, board)} 상위권을 보고 해석한다(누가 거품인지, 누가 진짜인지). 숫자는 아래 그대로만 쓴다.`,
        // A per-game average comes with its total, so "4경기에서 95개" needs no arithmetic the check can't vouch for.
        facts: board.rows.map(
          (r, i) =>
            `${i + 1}. ${name(r.playerId)}(${c.short(r.teamId)}) ${board.kind === 'percent' ? `${(r.value * 100).toFixed(1)}%` : r.value.toFixed(1)} · ${r.games}경기${board.kind === 'percent' ? '' : ` · 총 ${Math.round(r.value * r.games)}`}`,
        ),
        teams: [...new Set(board.rows.map((r) => r.teamId))],
        players: board.rows.map((r) => r.playerId),
      }
    }
    // No box scores yet: team records and point margins.
    const table = standings(c.league.db).overall.slice(0, 6)
    if (table.length === 0) return null
    return {
      kind: 'stats',
      board: 'main',
      tag: '분석',
      brief: '분석러가 쓰는 팀 기록 글: 승패와 득실을 보고 진짜 강팀과 운빨 팀을 가른다. 숫자는 아래 그대로만.',
      facts: table.map((s, i) => `${i + 1}. ${c.short(s.teamId)} ${s.wins}승 ${s.losses}패`),
      teams: table.map((s) => s.teamId),
      players: [],
    }
  },

  prediction: (c) => {
    const view = standings(c.league.db)
    const table = view.overall
    // Regular-season games still to be drawn up (rounds built by hand): no fixtures to quote yet.
    const unbuilt = currentSeason(c.league.db).phase === 'regular' && view.played + view.scheduled < view.total
    const upcoming = listGames(c.league.db, currentSeason(c.league.db).id).filter((g) => g.status === 'scheduled').slice(0, 6)
    const facts = [
      ...table.slice(0, 5).map((s, i) => `${i + 1}위 ${c.short(s.teamId)} ${s.wins}승 ${s.losses}패`),
      ...upcoming.map((g) => `다음 경기: ${c.short(g.away)} @ ${c.short(g.home)}`),
    ]
    if (facts.length === 0) return null
    return {
      kind: 'prediction',
      board: 'main',
      brief: `대담한 예언 글 (우승팀, 다음 경기 스코어, 시즌 MVP 등). 댓글은 "박제" 드립과 반대 예언. ${
        upcoming.length === 0 && unbuilt
          ? playedMode(c.league.config)
            ? '다음 대진은 경기하는 날 정해진다(2K 일정대로). 특정 경기 일정을 지어내지 않는다.'
            : '다음 라운드 대진은 아직 안 정해졌다. 특정 경기 일정을 지어내지 않는다.'
          : '일정은 아래 "다음 경기"에 있는 것만 쓴다.'
      }`,
      facts,
      teams: upcoming.flatMap((g) => [g.home, g.away]).slice(0, 4),
      players: [],
    }
  },

  meme: (c) => {
    const ps = shuffle(c.roster.filter((p) => !c.used.has(p.id)), c.random).slice(0, 3)
    for (const p of ps) c.used.add(p.id)
    return {
      kind: 'meme',
      board: 'humor',
      tag: '유머',
      brief: '순수 드립 글: 이름이나 별명 말장난, 삼행시, 상황극, "[짤]" 설명 글, 밈 패러디 중 하나. 웃기면 되고 정보는 없어도 된다. 금지선은 지킨다.',
      facts: ps.flatMap((p) => playerFacts(c, p.id)),
      teams: [...new Set(ps.map((p) => p.teamId))],
      players: ps.map((p) => p.id),
    }
  },

  off_topic: (c) => ({
    kind: 'off_topic',
    board: 'free',
    brief: `농구랑 별 상관없는 잡담 글: "${c.pick(OFF_TOPIC)}". 댓글이 결국 농구 얘기로 새도 된다. 글쓴이는 고등학생 팬이거나 그 또래의 일상.`,
    facts: [],
    teams: [],
    players: [],
  }),

  newbie: (c) => {
    const cfg = c.league.config
    const team = c.pick([...c.league.teams.values()])
    const facts = [
      `리그: ${cfg.league.name}, ${c.league.teams.size}개 학교`,
      `포지션: ${cfg.roster.slots.map((s) => s.name).join(', ')}`,
      ...(cfg.trades.oncePerSeason?.enabled ? ['트레이드된 선수는 드래프트 전까지 다시 트레이드 불가'] : []),
      ...(team ? [`질문 예시 학교: ${team.shortName}`] : []),
    ]
    return {
      kind: 'newbie',
      board: 'free',
      tag: '질문',
      brief: '뉴비 질문 글 (어느 학교 응원할지, 규칙이 뭔지, 누가 잘하는지 등). 댓글은 친절한 고인물, 자기 학교 영업, 놀리는 사람이 섞인다. 규칙 설명은 아래 사실과 맞게.',
      facts,
      teams: team ? [team.id] : [],
      players: [],
    }
  },

  drama: (c) => {
    // The latest mood per player: someone visibly unhappy is gossip material (never his secrets).
    const row = c.league.db
      .prepare(
        `SELECT m.player_id, m.band FROM player_mood m
         WHERE m.id = (SELECT MAX(id) FROM player_mood WHERE player_id = m.player_id) AND m.band IN ('unhappy', 'boiling')`,
      )
      .all() as { player_id: string; band: string }[]
    const r = c.pick(row.filter((x) => !c.used.has(x.player_id)))
    if (!r) return null
    c.used.add(r.player_id)
    return {
      kind: 'drama',
      board: 'trades',
      tag: '찌라시',
      brief: '이 선수 요즘 분위기가 이상하다는 추측 글 (표정, 몸짓, 출전 시간 등 겉으로 보이는 것만). 이유는 확인 안 된 추측으로만, 비밀은 모른다.',
      facts: playerFacts(c, r.player_id),
      teams: [c.league.players.get(r.player_id)?.teamId ?? ''],
      players: [r.player_id],
    }
  },

  school_pride: (c) => {
    const teams = [...c.league.teams.values()]
    const bySize = teams.map((t) => {
      const e = c.league.lore.team.get(t.id)
      return { t, size: e?.kind === 'team' ? e.settings.fans.size : 3 }
    })
    // Bigger fan bases hype more often.
    const pool = bySize.flatMap((x) => Array.from({ length: x.size }, () => x.t))
    const t = c.pick(pool)
    if (!t) return null
    const star = c.roster.filter((p) => p.teamId === t.id).sort((a, b) => (c.ovr(b.id) ?? 0) - (c.ovr(a.id) ?? 0))[0]
    const rec = standings(c.league.db).overall.find((s) => s.teamId === t.id)
    return {
      kind: 'school_pride',
      board: 'free',
      brief: '자기 학교 부심 글 (응원가, 전통, 에이스 자랑, "우리 학교가 원래…"). 다른 학교 팬들이 태클 건다.',
      facts: [`${t.shortName}${rec ? ` ${rec.wins}승 ${rec.losses}패` : ''}`, ...(star ? playerFacts(c, star.id) : [])],
      teams: [t.id],
      players: star ? [star.id] : [],
    }
  },

  poll: (c) => {
    const top = c.roster
      .filter((p) => c.ovr(p.id) !== null)
      .sort((a, b) => (c.ovr(b.id) ?? 0) - (c.ovr(a.id) ?? 0))
      .slice(0, 8)
    const options = shuffle(top, c.random).slice(0, 4)
    if (options.length < 3) return null
    const awards = listAwards(c.league.db, currentSeason(c.league.db).id, c.league.config).length
    const question = c.pick(['올시즌 MVP는?', '같이 뛰고 싶은 선수는?', '제일 과대평가된 선수는?', '클러치에 공 줄 선수는?'])!
    const labels = options.map((p) => `${p.name}(${c.short(p.teamId)})`)
    return {
      kind: 'poll',
      board: 'main',
      tag: '투표',
      // The post carries a real poll (fans vote on it by code), so the options go in the output's poll, in this order.
      brief: `투표 글: "${question}" poll의 question에 이 질문을, options에 보기 ${labels.length}개를 자료 순서대로 "이름(학교)"로 넣는다(투표 칸이 따로 붙는다). 본문은 짧은 도발이나 자기 픽, 댓글은 "n번" 투표와 이유와 키배.${awards ? ' 이미 받은 상은 자료에 있는 것만.' : ''}`,
      facts: options.map((p, i) => `${i + 1}번 ${labels[i]} OVR ${c.ovr(p.id)}`),
      teams: [...new Set(options.map((p) => p.teamId))],
      players: options.map((p) => p.id),
      poll: { question, options: labels },
    }
  },

  game_talk: (c) => {
    const finals = listGames(c.league.db, currentSeason(c.league.db).id)
      .filter((g) => g.status === 'final')
      .sort((a, b) => (b.recordedAt ?? '').localeCompare(a.recordedAt ?? ''))
      .slice(0, 5)
    const g = c.pick(finals)
    if (!g) return null
    return {
      kind: 'game_talk',
      board: 'games',
      brief: '지난 경기 하나를 다시 씹는 글 (명장면 짤 설명, 승부처 복기, 감독 탓). 점수는 아래 그대로.',
      facts: [`${g.stage === 'regular' ? roundLabel(c.league.config, g.round) : `R${g.round}`} ${c.short(g.home)} ${g.homeScore} : ${g.awayScore} ${c.short(g.away)}`],
      teams: [g.home, g.away],
      players: [],
    }
  },

  analysis: (c) => {
    const s = c.season()
    if (s.games.length === 0) return null
    const subject = c.pick(SUBJECTS.map((f) => f(c, s)).filter((x): x is Subject => x !== null))
    if (!subject) return null
    for (const p of subject.players) c.used.add(p)
    return {
      kind: 'analysis',
      board: 'main',
      tag: '분석',
      brief: `장문 분석 글(뼈대 ${subject.skeleton}): ${subject.brief}`,
      facts: [`주제: ${subject.topic}`],
      pack: subject.pack,
      teams: subject.teams,
      players: subject.players,
    }
  },
}

/**
 * Picks `count` topics by the league's mix (weights 0–5; 0 = never), each
 * kind at most twice, game talk and analysis at most once, and fills each
 * with facts. A kind with nothing to work with (no lore yet, no box scores)
 * is skipped. Then each gets its length (LENGTH_MIX). `longLeft` is how many
 * long posts the day still allows (LONG_PER_DAY): with none left, no
 * analysis topic and no 장문.
 */
export function planTopics(league: League, count: number, seed: number, longLeft = LONG_PER_DAY): TopicSeed[] {
  const random = rng(seed)
  const roster = listPlayers(league.db)
  const overallId = league.config.ratings.overallColumnId
  let season: Season | null = null
  const ctx: Ctx = {
    season: () => (season ??= readSeason(league)),
    league,
    random,
    pick: (list) => (list.length ? list[Math.floor(random() * list.length)] : undefined),
    roster,
    ovr: (id) => {
      const v = overallId ? roster.find((p) => p.id === id)?.ratings[overallId] : undefined
      return typeof v === 'number' ? v : null
    },
    short: (id) => league.teams.get(id)?.shortName ?? id,
    slot: (id) => league.config.roster.slots.find((s) => s.id === id)?.name ?? '',
    used: new Set(),
  }
  const mix = { ...DEFAULT_TOPIC_MIX, ...league.config.community.topicMix }
  // An analysis post is always long.
  if (longLeft <= 0) mix.analysis = 0
  const taken = new Map<TopicKind, number>()
  const out: Draft[] = []
  for (let tries = 0; out.length < count && tries < count * 6; tries++) {
    // Every kind once before any comes twice, so each batch is as varied as it can be. An analysis post is long: once a batch.
    const most = (k: TopicKind) => (k === 'game_talk' || k === 'analysis' ? 1 : 2)
    const fresh = TOPIC_KINDS.filter((k) => (mix[k] ?? 0) > 0 && !taken.has(k))
    const open = fresh.length > 0 ? fresh : TOPIC_KINDS.filter((k) => (mix[k] ?? 0) > 0 && (taken.get(k) ?? 0) < most(k))
    const total = open.reduce((s, k) => s + mix[k]!, 0)
    if (total === 0) break
    let r = random() * total
    const kind = open.find((k) => (r -= mix[k]!) < 0) ?? open.at(-1)!
    taken.set(kind, (taken.get(kind) ?? 0) + 1)
    const s = MAKERS[kind](ctx)
    if (s) out.push(s)
  }
  return withLengths(out, random, longLeft)
}
