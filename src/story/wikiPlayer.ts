import { z } from 'zod'
import type { JobKind, JobRow } from '@ai/queue'
import { peckingOrder, playerValue } from '@core/value'
import { aiFor, type EffortLevel, type ModelName } from '@shared/config/schema'
import { heightCm, positionOf, ratingLabel } from '@shared/labels'
import type { PlayerRow } from '@shared/league'
import { tagUnverified, untag } from '@shared/numbers'
import { lastEventId, setStoryValue, storyValue } from '@data/community'
import { transaction, type Db } from '@data/db'
import { listPlayers } from '@data/league'
import { openDisputes } from '@data/talk'
import { ownedSections, pageById, pageByRef, pageFlags, revisionBody, saveRevision, sectionKeys, setSectionText, type PageRow } from '@data/wiki'
import { castBlock, ensureCast, join2, pickCast, said, short, type League } from './context'
import { numberGate, NumbersRedo, readFacts, withRetryNote } from './numbers'
import { autoOverview, numberRanges, ratedColumns, roleOf, strengthsOf, styleHash, type Rated, type Role } from './playerPage'
import { playerSeason, readSeason } from './statsPack'
import { OVERVIEW, PLAY_STYLE, seedWiki, upgradeWiki } from './wiki'
import { quoteBlock, safeEditText, STYLE } from './wikiEdits'
import { fightable } from './wikiTalk'

/**
 * The wiki's player pages, written up by the AI editors (job `wiki_player`):
 * a page's 플레이 스타일 as Namuwiki prose (how he scores, defends, his role,
 * a weakness, a comparison with players of this league), and a better 개요
 * line when that's still the app's own.
 *
 * - When: a completed round's top performers whose pages still show the
 *   app's text; pages written from ratings or lore play sentences that have
 *   changed since (a hash of them is kept per player, `wiki-style:<id>` in
 *   story state); and every page left, from 편집실 → 위키's 선수 문서 다듬기.
 *   About six players of one school a job, below chatter in the queue.
 * - It writes only a section that's empty (the app's text shows) or still as
 *   it wrote it: never one you wrote or changed last, one held by a dispute,
 *   or one another editor has taken over. A section changed after the job
 *   looked is left alone.
 * - Each page is one revision under an editor's name, with history, so you
 *   can revert or edit it as any editor's text. Numbers its facts don't hold
 *   get the job redone once, then are marked (numbers.ts).
 * - It reads public lore (공개) only, never 소문 or 비밀.
 */

export const WIKI_PLAYER = 'wiki_player'
/** Below chatter refills (10): writing pages up can wait for everything else. */
export const WIKI_PLAYER_PRIORITY = 5
/** Players one job writes: about one school's lineup. */
export const PLAYERS_PER_JOB = 6
/** A job waiting this long has nothing fresh to say. */
const KEEP_MS = 7 * 86_400_000

/** One player a job writes: his page as the job saw it, and what it writes from. */
export interface WikiPlayerTarget {
  key: string
  playerId: string
  pageId: number
  page: string
  /** The page's revision when the job was queued: a section changed since isn't the job's to write. */
  seen: number
  /** What the 플레이 스타일 is written from (styleHash): kept with it, to know when it's stale. */
  hash: string
  /** 'new': the page still shows the app's text; 'stale': its ratings or lore changed since it was written. */
  need: 'new' | 'stale'
  /** Whether the job may write the 개요 too (it's empty, or still its own). */
  overview: boolean
}

export interface WikiPlayerInput {
  model: ModelName
  /** Claude Code's --effort for this job (left out: its default). */
  effort?: EffortLevel
  instructions: string
  context: string
  teamId: string
  targets: WikiPlayerTarget[]
  editors: string[]
  asOfEvent: number
  demo: { editors: string[]; targets: { key: string; strengths: string[]; weakness: string | null; position: string }[] }
  /** The one retry after the first answer used numbers the facts don't hold (these): it's saved with them marked. */
  numberRetry?: string[]
  /** On that retry: the job it redoes (for 최근 작업). */
  retryOf?: number
}

export const wikiPlayerOutputSchema = z.object({
  pages: z
    .array(
      z.object({
        target: z.string().describe('대상 기호 (P1 등)'),
        playStyle: z.string().describe("'플레이 스타일' 문단 내용(제목 줄 없이), 나무위키 문법, 2~4문단(문단 사이는 빈 줄), 1200자 이내"),
        overview: z.string().nullable().default(null).describe("'개요' 문단 내용 1~3문장. 개요를 쓸 수 있는 대상만, 아니면 null"),
        editor: z.string().describe('편집자 id'),
        summary: z.string().describe('편집 요약, 20자 이내'),
      }),
    )
    .default([]),
})

export type WikiPlayerOutput = z.infer<typeof wikiPlayerOutputSchema>

// ── Whose pages want writing ─────────────────────────────────────────────

/** What a player-page job last wrote on a page: the revision, the sections, and what it wrote them from. */
interface StyleMark {
  pageId: number
  rev: number
  sections: string[]
  hash: string
}

const markKey = (playerId: string) => `wiki-style:${playerId}`

function styleMark(db: Db, playerId: string): StyleMark | null {
  const raw = storyValue(db, markKey(playerId))
  if (!raw) return null
  try {
    const m = JSON.parse(raw) as StyleMark
    return typeof m.rev === 'number' && typeof m.pageId === 'number' && Array.isArray(m.sections) && typeof m.hash === 'string' ? m : null
  } catch {
    return null
  }
}

/**
 * Whose a section of a player page is now: 'empty' (the app's text shows),
 * 'ours' (as a player-page job last wrote it), 'theirs' (an editor's),
 * 'yours' (you changed it last, even to empty it), 'held' by a dispute, or
 * 'missing' (no such section, or two of them).
 */
type SectionState = 'empty' | 'ours' | 'theirs' | 'yours' | 'held' | 'missing'

/** A page as the player-page job judges it: its text now, the sections you wrote last, those held by a dispute, and the job's own mark. */
interface PageNow {
  page: PageRow
  body: string
  owned: Map<string, string>
  held: Set<string>
  mark: StyleMark | null
}

function pageNow(db: Db, page: PageRow, playerId: string): PageNow {
  return {
    page,
    body: revisionBody(db, page.id, page.currentRev!)!.body,
    owned: ownedSections(db, page.id),
    held: new Set(openDisputes(db, page.id).map((d) => d.section)),
    mark: styleMark(db, playerId),
  }
}

function sectionState(db: Db, now: PageNow, title: string, body = now.body): SectionState {
  const key = `${title}#1`
  const keys = sectionKeys(body)
  if (!keys.has(key) || keys.has(`${title}#2`)) return 'missing'
  if (now.owned.has(key)) return 'yours'
  if (now.held.has(title)) return 'held'
  const text = keys.get(key)!
  if (text === '') return 'empty'
  const { mark } = now
  if (mark && mark.pageId === now.page.id && mark.sections.includes(title)) {
    const then = revisionBody(db, now.page.id, mark.rev)?.body
    if (then !== undefined && sectionKeys(then).get(key) === text) return 'ours'
  }
  return 'theirs'
}

const writable = (s: SectionState) => s === 'empty' || s === 'ours'

/** A player whose page wants a player-page job, and why. */
export interface PageNeed {
  player: PlayerRow
  page: PageRow
  need: 'new' | 'stale'
  hash: string
  overview: boolean
}

/**
 * Whether a player's page wants its 플레이 스타일 written: 'new' while it
 * shows the app's text, 'stale' when the job wrote it from ratings or lore
 * play sentences that have changed since (and nobody has touched it). Null
 * otherwise: written by you or another editor, held by a dispute, or current.
 */
export function pageNeed(db: Db, league: League, player: PlayerRow): PageNeed | null {
  const page = pageByRef(db, 'player', player.id)
  if (!page || page.currentRev === null) return null
  const now = pageNow(db, page, player.id)
  const style = sectionState(db, now, PLAY_STYLE)
  const hash = styleHash(league.config, player.ratings, league.lore.player.get(player.id)?.sections.public ?? '')
  const need = style === 'empty' ? 'new' : style === 'ours' && now.mark?.hash !== hash ? 'stale' : null
  if (!need) return null
  return { player, page, need, hash, overview: writable(sectionState(db, now, OVERVIEW)) }
}

/** Players in a player-page job not finished yet: a new job leaves them out. */
function inQueue(db: Db): Set<string> {
  const out = new Set<string>()
  for (const j of db.prepare("SELECT input FROM jobs WHERE kind = ? AND status IN ('queued', 'running')").all(WIKI_PLAYER) as { input: string }[]) {
    try {
      for (const t of (JSON.parse(j.input) as Partial<WikiPlayerInput>).targets ?? []) out.add(t.playerId)
    } catch {
      // An unreadable row fails by itself in the queue.
    }
  }
  return out
}

type Who = readonly string[] | 'all' | null

/**
 * Pages that want a job: of `fresh` (ids, everyone or nobody) those still
 * showing the app's 플레이 스타일, of `stale` those written from ratings or
 * lore that changed since. Anyone in a job not finished yet is left out.
 */
export function planPlayerPages(league: League, opts: { fresh: Who; stale: Who }): PageNeed[] {
  const has = (who: Who, id: string) => who === 'all' || (who !== null && who.includes(id))
  const busy = inQueue(league.db)
  const out: PageNeed[] = []
  for (const p of listPlayers(league.db)) {
    // Only a page the job wrote can be stale: one without its mark needn't be read for that.
    if (busy.has(p.id) || !(has(opts.fresh, p.id) || (has(opts.stale, p.id) && styleMark(league.db, p.id) !== null))) continue
    const need = pageNeed(league.db, league, p)
    if (need && has(need.need === 'new' ? opts.fresh : opts.stale, p.id)) out.push(need)
  }
  return out
}

/** Pages in jobs: by school, about six to a job, split evenly (seven make a job of four and one of three). */
export function batches(needs: readonly PageNeed[]): PageNeed[][] {
  const bySchool = new Map<string, PageNeed[]>()
  for (const n of needs) bySchool.set(n.player.teamId, [...(bySchool.get(n.player.teamId) ?? []), n])
  return [...bySchool.values()].flatMap((list) => {
    const jobs = Math.ceil(list.length / PLAYERS_PER_JOB)
    const size = Math.ceil(list.length / jobs)
    return Array.from({ length: jobs }, (_, i) => list.slice(i * size, (i + 1) * size))
  })
}

// ── What the editors get ─────────────────────────────────────────────────

/** The job's own rules: they ride with each job, so a league's own guide without a 플레이 스타일 part still gets them (the guide's 12장 says it at length). */
const RULES = `선수 문서의 '플레이 스타일'(쓸 수 있으면 '개요'도)을 나무위키처럼 쓴다. pages에 대상마다 하나, target에는 대상 기호를 쓴다.
플레이 스타일:
- 목록이 아니라 2~4문단의 글로 쓴다(문단 사이는 빈 줄). 능력치 목록이나 등급 글자를 옮기지 않는다. 등급은 자료에 붙은 말로 푼다("3점 슛은 수준급이다", "외곽 수비는 확실한 약점이다").
- 첫 줄은 정체성 한 줄: 유형 + 팀 안의 역할("'''가람고 공격의 시작과 끝을 맡는 득점형 스몰 포워드.'''"). 굵게는 이 줄 하나만 쓴다.
- 장점은 판정 → 근거 하나(자료의 기록이나 능력치) → 팀에 주는 의미 순으로. 가장 큰 무기에는 이름을 붙인다("최대의 무기는 ~", "주특기는 ~").
- 단점은 판정부터("약점이라면 ~이다", "~도 좋지 못하다"). 반전 문장 하나로 균형을 잡는다("하지만 ~에도 불구하고", "물론 ~를 감안하더라도").
- 비교는 하나, 자료에 나온 이 리그 선수(같은 학교나 같은 포지션)와만 한다: "A가 ~형이라면 B는 ~형이다", "~를 연상시킨다". 실존 선수나 다른 리그 이야기는 쓰지 않는다.
- 끝은 총평 한 문장("종합적으로 ~", "정리하자면 ~", "한마디로 ~").
- 숫자는 자료에 있는 것만, 문단에 하나까지, 의미 있는 것(순위, 성공률, 시즌 하이)만 쓴다. 박스스코어 줄은 쓰지 않는다. 경기 기록이 없으면 능력치에서 읽히는 유형과 장단점만 2~3문장으로 쓰고 "~로 평가받는다", "~라는 평이다"로 남의 입을 빌린다. 경기 장면은 지어내지 않는다.
- 뼈대 제안이 있으면 그 틀을 따른다(A 에이스형, B 스페셜리스트형, C 흠 많은 피지컬형, D 기대 이하형, E 식스맨·수비형).
- 잘하는 선수는 기록과 순위로 증명하고 남의 입을 빌려 띄운다("명실공히 ~", "~라는 평가를 받는다"). 그래도 약점 하나는 남긴다. 기대 이하인 선수는 기대 → 실제 → 변호 한 문장("다만 ~", "그래도 ~만큼은 확실하다") 순으로 쓴다. '먹튀'는 쓰지 않는다('기대 이하', '이름값을 못 한다'). 벤치 선수는 역할로 소개한다. 부상, 몸, 외모, 가족사는 비꼬지 않는다. 가벼운 ~~취소선~~은 2~8글자로 문서에 하나까지. 선수들은 고등학생이다.
- 공개 로어는 커미셔너가 쓴 설정이다. 플레이 스타일이 적혀 있으면 그 내용이 먼저고, 어긋나게 쓰지 않는다. 소문과 비밀은 받지 않는다.
- 다시 쓰는 대상은 능력치나 로어가 바뀌었다: 지금 글에서 맞는 부분은 살리고, 바뀐 것을 반영해 새로 쓴다.
개요(overview):
- "개요: 써도 된다"인 대상만 쓰고, 아니면 null. 주어 없이 명사형 줄로 연다: "[[가람고|가람고등학교]] 농구부 소속의 농구 선수. 포지션은 스몰 포워드." 벤치 선수는 "… 농구부 소속의 식스맨." 그다음 정체성 한 줄(팀 안의 역할 + 대표 특징, 숫자는 하나까지), 별명이 있으면 "별명은 '''…'''."(굵게는 별명만).
공통:
- [[문서 제목]] 링크는 자료에 나온 문서 제목으로만 단다. 제목 줄(== ==), 분류, 표, [기록] 같은 줄은 쓰지 않는다.
- editor에는 "쓸 수 있는 사람" 목록의 id를, summary에는 짧은 편집 요약("플레이 스타일 서술" 등)을 쓴다.`

/** "운동 능력 A+(리그 최정상급)": a rating as the writers see it, the grade with the word prose uses for it. */
const ratingList = (list: readonly Rated[]) => list.map((x) => `${x.label} ${x.value}(${x.word})`).join(', ')

const ROLE_KO: Record<Role, string> = { ace: '에이스(주전 가운데 전력 1위)', starter: '주전', bench: '벤치' }

/**
 * Which of the guide's skeletons fits a player, by code (a suggestion, never
 * an order): E off the bench; A for the lineup's best with a strength; B one
 * weapon and two weak sides; C a strong body or paint game with a hole; D a
 * school's top two by value scoring in its bottom half after three games.
 */
function skeletonOf(role: Role, rated: readonly Rated[], below: boolean): string | null {
  if (role === 'bench') return 'E 식스맨·수비형'
  const { top } = strengthsOf(rated)
  const weak = rated.filter((x) => x.tier === 'weak').length
  if (below) return 'D 기대 이하형'
  if (role === 'ace' && top.length) return 'A 에이스형'
  if (top.length === 1 && weak >= 2) return 'B 스페셜리스트형'
  if (top.some((x) => x.kind === 'body' || x.kind === 'rim' || x.kind === 'board') && weak >= 1) return 'C 흠 많은 피지컬형'
  return null
}

/**
 * A player-page job for some players of one school (`needs`, from
 * planPlayerPages): each player's position, height, nicknames, grades and
 * overall in Korean with his place on his team and in the league, his season
 * so far, his public lore and what his page says now; a few players of the
 * league worth comparing with; the cast. Null when none still wants writing.
 */
export function playerPagesInput(league: League, needs: readonly PageNeed[], salt: string): WikiPlayerInput | null {
  const { db, config } = league
  const teamId = needs[0]?.player.teamId
  if (!teamId) return null
  // Pages exist (on today's layout) before anyone writes them.
  upgradeWiki(db, Date.now())
  seedWiki(db, config, league.lore, Date.now())
  const rows = listPlayers(db)
  const ranges = numberRanges(config, rows)
  const rated = (p: PlayerRow) => ratedColumns(config, p.ratings, ranges)
  const valued = rows.map((r) => ({ id: r.id, teamId: r.teamId, slotId: r.slotId, value: playerValue(config, r.ratings) }))
  const leagueOrder = peckingOrder(valued).map((v) => v.id)
  const mates = valued.filter((v) => v.teamId === teamId)
  const teamOrder = peckingOrder(mates).map((v) => v.id)
  const overall = config.ratings.columns.find((c) => c.id === config.ratings.overallColumnId)
  const ovr = (p: PlayerRow) => (overall && p.ratings[overall.id] !== null && p.ratings[overall.id] !== undefined ? `${ratingLabel(overall)} ${String(p.ratings[overall.id])}` : '')
  const season = readSeason(league)
  const titleOf = (id: string) => pageByRef(db, 'player', id)?.title ?? league.players.get(id)?.name ?? id
  const teamPage = pageByRef(db, 'team', teamId)?.title ?? short(league, teamId)
  const team = league.teams.get(teamId)
  // Points a game this season, for whom it's known: a school's top two scoring in its bottom half is below expectations.
  const ppg = (id: string) => {
    const t = season.totals.get(id)
    return t && season.cols.pts && t.games >= 3 ? (t.totals[season.cols.pts] ?? 0) / t.games : null
  }
  const scoring = mates.map((v) => ppg(v.id)).filter((v): v is number => v !== null).sort((a, b) => a - b)
  const median = scoring.length ? scoring[Math.floor((scoring.length - 1) / 2)]! : null

  const targets: WikiPlayerTarget[] = []
  const blocks: string[] = []
  const demo: WikiPlayerInput['demo']['targets'] = []
  const compare: string[] = []
  for (const n of needs.slice(0, PLAYERS_PER_JOB)) {
    // Looked at again: the page may have changed since it was planned.
    const now = n.player.teamId === teamId ? pageNeed(db, league, n.player) : null
    if (!now) continue
    const p = now.player
    const key = `P${targets.length + 1}`
    const mine = rated(p)
    const { top, more, solid, weak } = strengthsOf(mine)
    const position = positionOf(config, p.slotId)
    const body = revisionBody(db, now.page.id, now.page.currentRev!)!.body
    const flags = pageFlags(db, now.page.id, now.page.currentRev!, body)
    const current = (title: string) => {
      const text = sectionKeys(body).get(`${title}#1`) ?? ''
      return text ? quoteBlock(tagUnverified(text, flags), 1500) : ''
    }
    const lore = league.lore.player.get(p.id)?.sections.public.trim() ?? ''
    const role = roleOf(config, rows, p)
    const slot = config.roster.slots.find((s) => s.id === p.slotId)
    const own = autoOverview({ team: team ? { title: teamPage, name: team.name, short: team.shortName } : null, position, starter: slot?.starter ?? true, role, nicknames: p.nicknames, lore })
    const rank = teamOrder.indexOf(p.id) + 1
    const mineScoring = ppg(p.id)
    const skeleton = skeletonOf(role, mine, rank <= 2 && mineScoring !== null && median !== null && scoring.length >= 4 && mineScoring < median)
    // What prose calls his best and worst sides (the dictionary's words), so the writer needn't name a grade.
    const sides = [...top, ...(weak ? [weak] : [])].filter((x) => x.prose.length).map((x) => `${x.label}: ${x.prose.join(', ')}`)
    const facts = [
      `## ${key} · ${p.name} — 문서 ${said(now.page.title, 100)} (${now.need === 'new' ? '새로 쓴다' : '다시 쓴다: 능력치나 로어가 바뀌었다'})`,
      `- ${[short(league, p.teamId), position, `팀 안의 역할: ${ROLE_KO[role]}`, heightCm(p.heightCm, p.height) && `신장 ${heightCm(p.heightCm, p.height)}`].filter(Boolean).join(' · ')}${
        p.nicknames.length ? ` · 별명: ${p.nicknames.map((x) => said(x, 30)).join(', ')}` : ''
      }`,
      `- ${[ovr(p), `팀 내 전력 ${rank}위(${mates.length}명 중)`, `리그 전체 ${leagueOrder.indexOf(p.id) + 1}위(${rows.length}명 중)`].filter(Boolean).join(' · ')}`,
      mine.length ? `- 2K 능력치(등급과 본문에서 쓰는 말): ${ratingList(mine)}` : '- 2K 능력치: 없음',
      mine.length
        ? `- ${[
            top.length ? `강점: ${ratingList(top)}` : '뚜렷한 강점 없음',
            more.length ? `그 밖의 장점: ${ratingList(more)}` : '',
            solid.length ? `무난: ${ratingList(solid)}` : '',
            weak ? `약점: ${ratingList([weak])}` : '뚜렷한 약점 없음',
          ]
            .filter(Boolean)
            .join(' / ')}`
        : '',
      sides.length ? `- 본문에서는 이렇게 부른다: ${sides.join(' / ')}` : '',
      skeleton ? `- 뼈대 제안: ${skeleton}` : '',
      ...(season.totals.has(p.id) ? ['- 이번 시즌:', ...playerSeason(season, p.id).map((l) => `  ${l}`)] : ['- 이번 시즌: 기록 없음']),
      lore ? `- 공개 로어 (커미셔너가 쓴 설정. 플레이 스타일이 적혀 있으면 따른다):\n${quoteBlock(lore, 1500)}` : '- 공개 로어: 없음',
      `- 지금 문서의 개요: ${current(OVERVIEW) ? `\n${current(OVERVIEW)}` : `(비어 있음: 화면에는 앱이 쓴 ${said(own, 200)}가 나온다)`}`,
      `- 개요: ${now.overview ? '써도 된다' : '다른 사람이 썼다: overview는 null'}`,
      now.need === 'stale' && current(PLAY_STYLE) ? `- 지금 문서의 플레이 스타일 (다시 쓰기 전):\n${current(PLAY_STYLE)}` : '',
    ].filter(Boolean)
    targets.push({ key, playerId: p.id, pageId: now.page.id, page: now.page.title, seen: now.page.currentRev!, hash: now.hash, need: now.need, overview: now.overview })
    blocks.push(facts.join('\n'))
    demo.push({ key, strengths: top.map((x) => x.label), weakness: weak?.label ?? null, position })
    // Worth comparing with: the closest players at his position elsewhere, and its best.
    const peers = valued.filter((v) => v.id !== p.id && v.teamId !== p.teamId && positionOf(config, v.slotId) === position && position !== '')
    const mineValue = valued.find((v) => v.id === p.id)!.value
    const near = [...peers].sort((a, b) => Math.abs(a.value - mineValue) - Math.abs(b.value - mineValue)).slice(0, 2)
    const best = peckingOrder(peers)[0]
    for (const v of [...(best ? [best] : []), ...near]) if (!compare.includes(v.id)) compare.push(v.id)
  }
  if (targets.length === 0) return null
  const byId = new Map(rows.map((r) => [r.id, r]))
  const peerLines = compare.slice(0, 12).flatMap((id) => {
    const r = byId.get(id)
    if (!r) return []
    const { top } = strengthsOf(rated(r))
    return [
      `- ${r.name} (${short(league, r.teamId)}, ${positionOf(config, r.slotId)}) — 문서 ${said(titleOf(r.id), 100)} · ${[ovr(r), `리그 전체 ${leagueOrder.indexOf(r.id) + 1}위`].filter(Boolean).join(' · ')}${top.length ? ` · 강점: ${ratingList(top)}` : ''}`,
    ]
  })
  const ovrs = overall ? rows.map((r) => r.ratings[overall.id]).filter((v): v is number => typeof v === 'number') : []
  const scale = config.ratings.gradeScale.map((g) => g.label)
  const schoolLore = league.lore.team.get(teamId)?.sections.public.trim() ?? ''
  // The editors are the community's cast (made the first time anyone needs it); with nobody to write, no job.
  ensureCast(league)
  const editors = pickCast(league, { teams: [teamId], fans: 4, reporters: 0, salt: `wiki-player:${salt}` })
  if (editors.length === 0) return null
  return {
    ...aiFor(config, 'wikiPlayer'),
    instructions: `대상 ${targets.length}명: ${targets.map((t) => `${t.key} ${said(t.page, 60)}`).join(', ')}.`,
    context: join2(
      [
        `# 리그`,
        `${config.league.name} · 학교 ${league.teams.size}곳 · 선수 ${rows.length}명`,
        `능력치 등급: ${scale.join(' > ')} (${scale[0]}가 가장 좋다)`,
        ovrs.length && overall ? `${ratingLabel(overall)} 범위 ${Math.min(...ovrs)}~${Math.max(...ovrs)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      `# 학교: ${short(league, teamId)}${team && team.name !== team.shortName ? ` (${team.name})` : ''} — 문서 ${said(teamPage, 100)}${schoolLore ? `\n${quoteBlock(schoolLore, 600)}` : ''}`,
      `# 대상\n${blocks.join('\n\n')}`,
      peerLines.length ? `# 비교할 만한 리그 선수 (비교는 이 목록과 대상끼리만)\n${peerLines.join('\n')}` : '',
      castBlock(league, editors, 'editor'),
    ),
    teamId,
    targets,
    editors: editors.map((e) => e.id),
    asOfEvent: lastEventId(db),
    demo: { editors: editors.map((e) => e.id), targets: demo },
  }
}

// ── Saving ───────────────────────────────────────────────────────────────

/** Text the job may put in a section: heading lines dropped; no categories, macro lines or folds. */
function clean(raw: string | null | undefined, max: number): string | null {
  if (!raw) return null
  const text = untag(raw)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*=.*=\s*$/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
  return text && safeEditText(text) && fightable(text) ? text : null
}

export interface WikiPlayerHooks {
  /** Queues the job again after it used numbers its facts don't hold. Left out: no retry, the numbers are marked. */
  requeue?: (input: WikiPlayerInput) => void
}

function accept(db: Db, output: WikiPlayerOutput, job: JobRow, hooks: WikiPlayerHooks): void {
  const input = job.input as WikiPlayerInput
  if (db.prepare('SELECT 1 FROM wiki_revisions WHERE job_id = ? LIMIT 1').get(job.id)) return
  const gate = numberGate(readFacts(input.context, input.instructions), input.numberRetry !== undefined || !hooks.requeue)
  const at = Date.now()
  const done = new Set<string>()
  try {
    transaction(db, () => {
      for (const out of output.pages) {
        const t = input.targets.find((x) => x.key === out.target.trim())
        if (!t || done.has(t.key)) continue
        done.add(t.key)
        const page = pageById(db, t.pageId)
        if (!page || page.currentRev === null || page.kind !== 'player') continue
        const seen = revisionBody(db, page.id, t.seen)?.body
        // Checked now, not when the job was queued: you (or another editor) may have written since.
        const now = pageNow(db, page, t.playerId)
        let body = now.body
        // Sections still as this job's earlier text: kept on the mark, so a later rewrite may take them too.
        const kept = (now.mark?.sections ?? []).filter((s) => sectionState(db, now, s) === 'ours')
        const wrote: string[] = []
        const texts: string[] = []
        const put = (title: string, raw: string | null | undefined, max: number) => {
          const text = clean(raw, max)
          if (!text || !writable(sectionState(db, now, title, body))) return
          // Changed after the job looked (you, or another editor): not this job's to write.
          const key = `${title}#1`
          if (seen === undefined || sectionKeys(seen).get(key) !== sectionKeys(body).get(key)) return
          const next = setSectionText(body, key, text)
          if (next === null || next === body) return
          body = next
          wrote.push(title)
          texts.push(text)
        }
        put(PLAY_STYLE, out.playStyle, 2500)
        if (t.overview) put(OVERVIEW, out.overview, 600)
        if (wrote.length === 0) continue
        const editor = input.editors.includes(out.editor) ? out.editor : (input.editors[0] ?? 'system')
        const flags = gate.check(texts.join('\n\n'))
        const { rev } = saveRevision(
          db,
          { title: page.title, body, authorId: editor, summary: untag(out.summary).slice(0, 60) || '플레이 스타일 서술', jobId: job.id, baseRev: page.currentRev, flags },
          at,
        )
        const mine: StyleMark = { pageId: page.id, rev, sections: [...new Set([...wrote, ...kept])], hash: t.hash }
        setStoryValue(db, markKey(t.playerId), JSON.stringify(mine))
      }
      gate.redoIfAny()
    })
  } catch (e) {
    if (!(e instanceof NumbersRedo)) throw e
    // None of it landed: the same job again (the same pages and what the job saw), with a note.
    hooks.requeue!({ ...input, numberRetry: e.numbers, retryOf: job.id })
  }
}

/** Whether a waiting job still has a page to write: one whose section is still empty, or still its own. */
function stillWritable(db: Db, t: WikiPlayerTarget): boolean {
  const page = pageById(db, t.pageId)
  if (!page || page.currentRev === null) return false
  const now = pageNow(db, page, t.playerId)
  return writable(sectionState(db, now, PLAY_STYLE)) || (t.overview && writable(sectionState(db, now, OVERVIEW)))
}

/** `style` returns the editable wiki style guide (defaults/prompts/wiki.md); null falls back to the built-in one. */
export function wikiPlayerKind(db: Db, style: () => string | null = () => null, hooks: WikiPlayerHooks = {}): JobKind<WikiPlayerInput, WikiPlayerOutput> {
  return {
    kind: WIKI_PLAYER,
    model: (input) => input.model,
    effort: (input) => input.effort,
    tools: [],
    output: wikiPlayerOutputSchema,
    systemPrompt: () => style() ?? STYLE,
    // The rules ride with each job, so a league's own guide without a 플레이 스타일 part still gets them.
    prompt: (input) => withRetryNote(`${RULES}\n\n${input.instructions}`, input.numberRetry),
    stdin: (input) => input.context,
    timeoutMs: 8 * 60_000,
    stillWanted: (input, job) => Date.now() - Date.parse(job.createdAt) < KEEP_MS && input.targets.some((t) => stillWritable(db, t)),
    accept: (output, job) => accept(db, output, job, hooks),
  }
}

/** Demo pages (TWOK_FAKE_AI=1): a two-paragraph 플레이 스타일 from each player's grades, and a 개요 where it may write one. */
export function wikiPlayerDemo(kind: string, input: unknown): WikiPlayerOutput | null {
  if (kind !== WIKI_PLAYER) return null
  const i = input as WikiPlayerInput
  const editor = (n: number) => i.demo.editors[n % Math.max(1, i.demo.editors.length)] ?? 'system'
  return {
    pages: i.demo.targets.map((t, n) => {
      const target = i.targets.find((x) => x.key === t.key)
      return {
        target: t.key,
        playStyle: [
          `'''맡은 역할을 착실히 해내는 ${t.position || '선수'}.''' ${t.strengths.length ? `강점으로는 ${t.strengths.join(', ')} 쪽이 꼽힌다.` : '뚜렷한 강점은 없지만 성실하다는 평가다.'}`,
          `${t.weakness ? `다만 ${t.weakness} 쪽은 보완이 필요하다는 지적이 나온다.` : '약점이라 할 만한 부분은 딱히 보이지 않는다.'} 정리하자면 팀에 꼭 필요한 선수다.`,
        ].join('\n\n'),
        overview: target?.overview ? `${t.position || '선수'}로 뛰는 선수. 성실함이 장점으로 꼽힌다.` : null,
        editor: editor(n),
        summary: '플레이 스타일 서술',
      }
    }),
  }
}
