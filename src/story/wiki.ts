import type { LeagueConfig } from '@shared/config/schema'
import { splitWikiSections } from '@shared/namumark'
import { setStoryValue, storyValue } from '@data/community'
import type { Db } from '@data/db'
import { currentSeason, listPlayers, listTeams } from '@data/league'
import {
  normalTitle,
  pageById,
  pageByRef,
  pageByTitle,
  revisionBody,
  saveRevision,
  sectionAuthors,
  sectionKeys,
  setSectionText,
  SYSTEM,
  titlesByRef,
  TRAILER_LINE,
} from '@data/wiki'
import type { LoreLinks } from '@lore/folder'
import type { PlayerRow } from '@shared/league'
import type { Team } from '@shared/setup'

/**
 * Seeds the wiki: one page per player, team, the league, the current season,
 * the rules, the awards and the draft, plus a page per world lore topic.
 * Seeded text is a starting point written by "2K World"; the infobox, the
 * [기록]/[역사]/[정보]/[인간관계] macros and the text a player page shows in
 * its empty 개요 and 플레이 스타일 stay live from the league data. Existing
 * pages are never touched, but for the one-time layout upgrade (upgradeWiki).
 */

export interface WikiTitles {
  player: Map<string, string>
  team: Map<string, string>
  league: string
  rules: string
  awards: string
  draft: string
  season: string
}

/** Page titles: a player's name, with the school in brackets when two share it (Namuwiki-style); a team's short name. */
export function wikiTitles(config: LeagueConfig, seasonLabel: string, teams: Team[], players: PlayerRow[]): WikiTitles {
  const t = (s: string, fallback: string) => normalTitle(s) || fallback
  const raw = wikiTitlesRaw(config, seasonLabel, teams, players)
  return {
    player: new Map([...raw.player].map(([id, s]) => [id, t(s, id)])),
    team: new Map([...raw.team].map(([id, s]) => [id, t(s, id)])),
    league: t(raw.league, '리그'),
    rules: t(raw.rules, '리그/규칙'),
    awards: t(raw.awards, '리그/시상'),
    draft: t(raw.draft, '리그/드래프트'),
    season: t(raw.season, '리그 시즌'),
  }
}

function wikiTitlesRaw(config: LeagueConfig, seasonLabel: string, teams: Team[], players: PlayerRow[]): WikiTitles {
  const short = new Map(teams.map((t) => [t.id, t.shortName]))
  const count = new Map<string, number>()
  for (const p of players) count.set(p.name, (count.get(p.name) ?? 0) + 1)
  const teamTitles = new Set(teams.map((t) => t.shortName))
  const player = new Map(
    players.map((p) => [p.id, (count.get(p.name) ?? 0) > 1 || teamTitles.has(p.name) ? `${p.name}(${short.get(p.teamId) ?? p.teamId})` : p.name]),
  )
  const league = config.league.name.trim() || '리그'
  return {
    player,
    team: new Map(teams.map((t) => [t.id, t.shortName])),
    league,
    rules: `${league}/규칙`,
    awards: `${league}/시상`,
    draft: `${league}/드래프트`,
    season: `${league} ${seasonLabel}`,
  }
}

/** Digits as read in Korean (일, 이, 삼…): 1, 7 and 8 end in ㄹ, 3 and 6 in another consonant. */
const DIGIT_END: Record<string, 'none' | 'rieul' | 'other'> = {
  '1': 'rieul',
  '2': 'none',
  '3': 'other',
  '4': 'none',
  '5': 'none',
  '6': 'other',
  '7': 'rieul',
  '8': 'rieul',
  '9': 'none',
}
/** Capital letters read by name (엘, 엠, 엔, 알…): the ones whose name ends in a consonant. */
const LETTER_END: Record<string, 'rieul' | 'other'> = { L: 'rieul', R: 'rieul', M: 'other', N: 'other' }

/**
 * How a word ends when read aloud: no final consonant, ㄹ, or another one.
 * Hangul by its last syllable; digits as Korean numbers (영 and 십, 백, 천
 * end in a consonant, so any number ending in 0 does); capitals by their
 * names (M 엠, L 엘, KBL 케이비엘), but three or more with a vowel as a word
 * (BOB 밥); a word as it's usually written in Hangul (Kim 킴, Paul 폴, Bob
 * 밥, Mark 마크, Kyle 카일, Jane 제인). A bracket at the end (a school after
 * a name), or a closing one left over, doesn't count.
 */
export function finalSound(word: string): 'none' | 'rieul' | 'other' {
  const w = word
    .replace(/\s*\([^()]*\)\s*$/, '')
    .replace(/[\s'"’”」』.,!?)\]]+$/, '')
  const last = w.at(-1) ?? ''
  const code = last.charCodeAt(0)
  if (code >= 0xac00 && code <= 0xd7a3) {
    const end = (code - 0xac00) % 28
    return end === 0 ? 'none' : end === 8 ? 'rieul' : 'other'
  }
  if (/\d/.test(last)) return last === '0' ? 'other' : DIGIT_END[last]!
  const letters = /[A-Za-z]+$/.exec(w)?.[0]
  if (!letters) return 'none'
  if (letters === letters.toUpperCase() && !(letters.length >= 3 && /[AEIOU]/.test(letters))) return LETTER_END[last] ?? 'none'
  return wordEnd(letters.toLowerCase())
}

/** How an English word (lowercase) ends as it's usually written in Hangul. */
function wordEnd(end: string): 'none' | 'rieul' | 'other' {
  if (end.endsWith('l')) return 'rieul'
  if (/(m|n|ng|ck)$/.test(end)) return 'other'
  // A silent e: Kyle 카일, Cole 콜 and Gable 게이블 end in ㄹ; Jane 제인, Wayne 웨인, Jerome 제롬 and Anne 앤
  // in another consonant. After other letters it's its own syllable (Mike 마이크, Kate 케이트).
  if (end.endsWith('le')) return 'rieul'
  if (/([aeiouy]|n)[mn]e$/.test(end)) return 'other'
  // Zach 잭.
  if (/^[^aeiou]+ach$/.test(end)) return 'other'
  // A b, c, k, p or t right after one vowel closes the syllable (밥, 에릭, 팻); after a consonant it's its own (마크, 로버트).
  if (/[^aeiou][aeiou][bckpt]$/.test(end) || /^[aeiou][bckpt]$/.test(end)) return 'other'
  return 'none'
}

/**
 * The particle that follows a word: 은/는, 이/가, 을/를, 과/와… by whether
 * it ends in a consonant when read (finalSound). (으)로 takes 로 after ㄹ too:
 * particle(word, '으로', '로').
 */
export function particle(word: string, withFinal: string, without: string): string {
  const end = finalSound(word)
  if (end === 'none' || (end === 'rieul' && withFinal === '으로')) return without
  return withFinal
}

const bullets = (items: string[]) => items.map((i) => ` * ${i}`).join('\n')

/** A player page's sections that show the app's own text while they're empty (main/wiki.ts writes it, live). */
export const OVERVIEW = '개요'
export const PLAY_STYLE = '플레이 스타일'
export const AUTO_SECTIONS: readonly string[] = [OVERVIEW, PLAY_STYLE]
/** Where [인간관계] lists a player's public ties from lore. */
export const RELATIONS = '인간관계'

/**
 * A player's page as Namuwiki lays one out: 개요, his career (시즌별 활약
 * with its table and a paragraph per season, then 역사's timeline), 플레이
 * 스타일, 인간관계, 별명, 여담. 개요 and 플레이 스타일 start empty: the page
 * shows text the app writes from the league (his school, part and lore; his
 * grades) until an editor or you write there. The macros fill from the league
 * as it is; sections with nothing to show are left out of the article (but
 * stay here, for editors to fill).
 */
function playerPage(titles: WikiTitles, p: PlayerRow, lore: LoreLinks): string {
  const team = titles.team.get(p.teamId) ?? ''
  const rumors = lore.player.get(p.id)?.sections.rumor ?? ''
  return [
    '[목차]',
    `== ${OVERVIEW} ==`,
    '== 시즌별 활약 ==',
    '[기록]',
    '== 역사 ==',
    '[역사]',
    `== ${PLAY_STYLE} ==`,
    `== ${RELATIONS} ==`,
    '[인간관계]',
    '== 별명 ==',
    '== 여담 ==',
    rumors ? bullets(rumors.split('\n').filter((l) => l.trim()).map((l) => `카더라: ${l.trim()}`)) : '',
    '[각주]',
    `[[분류:${team} 선수]]`,
    '[[분류:선수]]',
  ]
    .filter((l) => l !== '')
    .join('\n')
}

/** The layout pages are on now; pages seeded before it are brought up to it once (upgradeWiki). */
const LAYOUT_MARK = 'wiki-layout'
const LAYOUT = '2'

type Section = ReturnType<typeof splitWikiSections>[number]

/** Where a section ends: past its subsections. */
function sectionEnd(sections: readonly Section[], at: number): number {
  let end = at + 1
  while (end < sections.length && sections[end]!.level > sections[at]!.level) end++
  return end
}

/**
 * Puts a new section (heading and text) right after `after` (and its
 * subsections), else, or when that's the page's last section (which holds
 * the closing [각주] and 분류 lines), just before those lines.
 */
function insertSection(body: string, title: string, text: string, after: string): string {
  const sections = splitWikiSections(body)
  const at = sections.findIndex((s) => s.title === after)
  const chunk = `== ${title} ==\n${text ? `${text}\n` : ''}`
  const end = at >= 0 ? sectionEnd(sections, at) : -1
  if (end >= 0 && end < sections.length) {
    sections.splice(end, 0, { title, level: 2, text: chunk })
    return sections.map((s) => s.text).join('')
  }
  const lines = body.replace(/\n+$/, '').split('\n')
  let last = lines.length
  while (last > 0 && (TRAILER_LINE.test(lines[last - 1]!) || lines[last - 1]!.trim() === '')) last--
  return [...lines.slice(0, last), chunk.trimEnd(), ...lines.slice(last)].join('\n')
}

/**
 * Moves sections (with their subsections) to just before the first of
 * `before` there is. The page as it was when none of `before` is there, or
 * when a section to move is the last one (it holds the closing lines).
 */
function moveSections(body: string, titles: readonly string[], before: readonly string[]): string {
  const sections = splitWikiSections(body)
  if (!sections.some((s) => s.title !== null && before.includes(s.title))) return body
  const moved: Section[] = []
  for (const title of titles) {
    const at = sections.findIndex((s) => s.title === title)
    if (at < 0) continue
    const end = sectionEnd(sections, at)
    if (end === sections.length) return body
    moved.push(...sections.splice(at, end - at))
  }
  const to = sections.findIndex((s) => s.title !== null && before.includes(s.title))
  sections.splice(to, 0, ...moved)
  return sections.map((s) => s.text).join('')
}

/**
 * Brings pages seeded before the Korean layout up to it, once per league.
 * - A player's page: what 2K World seeded and nobody changed since goes (the
 *   개요 line, "… 소속 SF 선수다.", and the 플레이 스타일 rating list), so
 *   the page shows the app's live text there instead. An editor's lines in
 *   플레이 스타일 stay (only the seeded ones go); a section you changed last
 *   stays as it is. [인간관계] comes after 플레이 스타일, and both move after
 *   the career sections (시즌별 활약, 역사), as on Namuwiki, while the page
 *   is still in the order it was seeded in.
 * - A school's page: an empty 상세 after 개요 and 향후 전망 before 여담
 *   (left out of the article until someone writes there), and 로스터, as 2K
 *   World seeded it, becomes 선수단.
 * Saved as 2K World ('문서 양식 갱신'), so it's no one's edit, and moving a
 * section changes no one's text in it. Returns how many pages changed.
 */
export function upgradeWiki(db: Db, nowMs: number): number {
  if (storyValue(db, LAYOUT_MARK) === LAYOUT) return 0
  let changed = 0
  for (const { id, kind } of db.prepare("SELECT id, kind FROM wiki_pages WHERE kind IN ('player', 'team') AND current_rev IS NOT NULL ORDER BY id").all() as {
    id: number
    kind: string
  }[]) {
    try {
      if (kind === 'player' ? upgradePlayerPage(db, id, nowMs) : upgradeTeamPage(db, id, nowMs)) changed++
    } catch (e) {
      console.warn(`[wiki] could not bring page ${id} up to the new layout`, e)
    }
  }
  setStoryValue(db, LAYOUT_MARK, LAYOUT)
  return changed
}

/** The titles of a page's sections, in order. */
const titlesOf = (body: string) => splitWikiSections(body).flatMap((s) => (s.title === null ? [] : [s.title]))

function upgradePlayerPage(db: Db, pageId: number, nowMs: number): boolean {
  const page = pageById(db, pageId)
  if (!page || page.currentRev === null) return false
  const body = revisionBody(db, page.id, page.currentRev)!.body
  const first = revisionBody(db, page.id, 1)
  const seeded = first?.authorId === SYSTEM ? sectionKeys(first.body) : new Map<string, string>()
  const authors = sectionAuthors(db, page.id)
  let next = body
  for (const title of AUTO_SECTIONS) {
    const key = `${title}#1`
    const last = authors.get(key)
    if (!last || last.text === '' || last.author === 'me') continue
    if (last.author === SYSTEM) {
      next = setSectionText(next, key, '') ?? next
    } else if (title === PLAY_STYLE) {
      // An editor wrote below the seeded list: the seeded lines go, theirs stay.
      const old = new Set((seeded.get(key) ?? '').split('\n').filter((l) => l.trim() !== ''))
      const lines = last.text.split('\n')
      const kept = lines.filter((l) => !old.has(l))
      if (kept.length < lines.length) next = setSectionText(next, key, kept.join('\n').trim()) ?? next
    }
  }
  if (!sectionKeys(next).has(`${RELATIONS}#1`)) {
    next = titlesOf(next).includes(PLAY_STYLE) ? insertSection(next, RELATIONS, '[인간관계]', PLAY_STYLE) : insertSection(next, RELATIONS, '[인간관계]', '역사')
  }
  // Still in the seeded order (플레이 스타일 before the career): the career comes first now.
  const order = titlesOf(next)
  if (order.indexOf(PLAY_STYLE) >= 0 && order.indexOf(PLAY_STYLE) < order.indexOf('시즌별 활약')) {
    next = moveSections(next, [PLAY_STYLE, RELATIONS], ['별명', '논란 및 사건 사고', '여담'])
  }
  if (next === body) return false
  saveRevision(db, { title: page.title, body: next, authorId: SYSTEM, summary: '문서 양식 갱신', baseRev: page.currentRev }, nowMs)
  return true
}

function upgradeTeamPage(db: Db, pageId: number, nowMs: number): boolean {
  const page = pageById(db, pageId)
  if (!page || page.currentRev === null) return false
  const body = revisionBody(db, page.id, page.currentRev)!.body
  let next = body
  const has = (title: string) => titlesOf(next).includes(title)
  if (!has('상세') && has(OVERVIEW)) next = insertSection(next, '상세', '', OVERVIEW)
  // 로스터 as seeded (its heading over the live table) is Namuwiki's 선수단.
  const roster = sectionAuthors(db, page.id).get('로스터#1')
  if (!has('선수단') && roster?.author === SYSTEM) next = next.replace(/^== 로스터 ==$/m, '== 선수단 ==')
  if (!has('향후 전망') && has('여담')) {
    const sections = splitWikiSections(next)
    const at = sections.findIndex((s) => s.title === '여담')
    sections.splice(at, 0, { title: '향후 전망', level: 2, text: '== 향후 전망 ==\n' })
    next = sections.map((s) => s.text).join('')
  }
  if (next === body) return false
  saveRevision(db, { title: page.title, body: next, authorId: SYSTEM, summary: '문서 양식 갱신', baseRev: page.currentRev }, nowMs)
  return true
}

/** Names that already say they're a conference, or a division. */
const CONFERENCE_WORD = /컨퍼런스|콘퍼런스|conference|리그|지구/i
const DIVISION_WORD = /디비전|division|지구|조$/i

/**
 * A school's conference and division as its pages name them ("동 컨퍼런스",
 * "북 디비전"); a name that already says what it is ("동부 지구") stays as
 * it is. Either is left out when the league has none.
 */
export function schoolPlace(config: LeagueConfig, divisionId: string): string[] {
  const division = config.structure.divisions.find((d) => d.id === divisionId)
  const conference = config.structure.conferences.find((c) => c.id === division?.conferenceId)
  const named = (name: string | undefined, word: RegExp, kind: string) => (!name?.trim() ? '' : word.test(name) ? name.trim() : `${name.trim()} ${kind}`)
  return [named(conference?.name, CONFERENCE_WORD, '컨퍼런스'), named(division?.name, DIVISION_WORD, '디비전')].filter(Boolean)
}

/**
 * A school's page, as Namuwiki lays one out: 개요, 상세 (its standing, its
 * style, its weak spots: for editors to write), 선수단 (the live roster),
 * 시즌별 성적, 최근 경기, 라이벌, 향후 전망, 여담. Empty ones are left out of
 * the article until someone writes there.
 */
function teamPage(config: LeagueConfig, titles: WikiTitles, t: Team, lore: LoreLinks): string {
  const division = config.structure.divisions.find((d) => d.id === t.divisionId)
  const conference = config.structure.conferences.find((c) => c.id === division?.conferenceId)
  const entry = lore.team.get(t.id)
  const rivals = entry?.kind === 'team' ? entry.settings.rivals : []
  const where = schoolPlace(config, t.divisionId).join(' ')
  return [
    '[목차]',
    '== 개요 ==',
    `'''${t.name}'''${t.name === t.shortName ? '' : `(${t.shortName})`}의 농구부. [[${titles.league}]]${where ? ` ${where}` : ''} 소속.`,
    entry?.sections.public ?? '',
    '== 상세 ==',
    '== 선수단 ==',
    '[정보]',
    '== 시즌별 성적 ==',
    '[기록]',
    '== 최근 경기 ==',
    '[최근경기]',
    ...(rivals.length ? ['== 라이벌 ==', bullets(rivals.map((r) => `[[${r}]]`))] : []),
    '== 향후 전망 ==',
    '== 여담 ==',
    '[각주]',
    `[[분류:${conference?.name ?? '학교'}]]`,
    '[[분류:학교]]',
  ]
    .filter((l) => l !== '')
    .join('\n')
}

function leaguePage(config: LeagueConfig, titles: WikiTitles, teams: Team[]): string {
  const lines = ['[목차]', '== 개요 ==', `'''${titles.league}'''${particle(titles.league, '은', '는')} 2K로 치르는 고교 농구 리그다. 학교 ${teams.length}곳이 참가한다.`, '== 구성 ==']
  for (const c of config.structure.conferences) {
    lines.push(`=== ${c.name} ===`)
    for (const d of config.structure.divisions.filter((x) => x.conferenceId === c.id)) {
      const members = teams.filter((t) => t.divisionId === d.id).map((t) => `[[${titles.team.get(t.id) ?? t.shortName}]]`)
      lines.push(` * ${d.name}: ${members.join(', ')}`)
    }
  }
  const noConference = config.structure.divisions.filter((d) => !config.structure.conferences.some((c) => c.id === d.conferenceId))
  for (const d of noConference) lines.push(` * ${d.name}: ${teams.filter((t) => t.divisionId === d.id).map((t) => `[[${titles.team.get(t.id) ?? t.shortName}]]`).join(', ')}`)
  lines.push('== 시즌 ==', ` * [[${titles.season}]]`, '== 관련 문서 ==', bullets([`[[${titles.rules}]]`, `[[${titles.awards}]]`, `[[${titles.draft}]]`]), '[[분류:리그]]')
  return lines.join('\n')
}

function rulesPage(config: LeagueConfig, titles: WikiTitles): string {
  const s = config.season
  const schedule =
    s.schedule.kind === 'round-robin'
      ? `리그 전체 라운드 로빈 ${s.schedule.cycles}회${s.schedule.build === 'played' ? ' (2K 일정대로: 정해진 라운드 없이 경기한 날을 N일차로 묶어서, 학교마다 치른 경기 수가 다를 수 있다)' : ''}`
      : `팀당 ${s.schedule.gamesPerTeam}경기`
  const playoffs = s.playoffs.enabled
    ? `${s.playoffs.bracket === 'conference' ? '컨퍼런스별' : '리그 전체'} 플레이오프${s.playoffs.playIn.enabled ? ', 플레이-인 토너먼트 포함' : ''}`
    : '플레이오프 없음'
  const once = config.trades.oncePerSeason
  const trades = config.trades.enabled
    ? [
        `트레이드 가능${config.trades.equalPlayerCount ? ' (같은 인원끼리)' : ''}. 플레이오프 중에는 모든 선수가 묶인다.`,
        once.enabled ? ` 한 번 트레이드된 선수는 ${once.until === 'draft' ? '드래프트' : '시즌이 끝날 때'}까지 다시 트레이드할 수 없다.` : '',
      ].join('')
    : '트레이드 없음'
  // Only the card swap runs: an old 'standard' setting never held a draft (the season goes straight to the offseason).
  const draft = config.draft.kind === 'card-swap' ? `카드 스왑 드래프트. 자세한 내용은 [[${titles.draft}]] 참고.` : '드래프트는 없다.'
  return [
    '[목차]',
    '== 개요 ==',
    `[[${titles.league}]]의 규칙을 정리한 문서다. 자세한 수치는 리그 설정을 따른다.`,
    '== 정규시즌 ==',
    bullets([`일정: ${schedule}`, `동률 처리: ${s.standings.tiebreakers.length}단계 타이브레이커`]),
    '== 플레이오프 ==',
    playoffs,
    '== 트레이드 ==',
    trades,
    '== 드래프트 ==',
    draft,
    '[[분류:리그]]',
  ].join('\n')
}

function awardsPage(config: LeagueConfig, titles: WikiTitles): string {
  return [
    '[목차]',
    '== 개요 ==',
    `[[${titles.league}]]의 상 목록과 역대 수상자.`,
    '== 시즌 상 ==',
    bullets(config.awards.season.map((a) => a.name)),
    ...(config.awards.periodic.length ? ['== 주간·월간 상 ==', bullets(config.awards.periodic.map((a) => a.name))] : []),
    '== 수상자 ==',
    '[기록]',
    '[[분류:리그]]',
  ].join('\n')
}

function draftPage(config: LeagueConfig, titles: WikiTitles): string {
  const d = config.draft
  const how =
    d.kind === 'card-swap'
      ? [
          '정규시즌 순위에 따라 카드를 받고, 순위가 낮은 팀부터 카드를 써서 다른 팀 선수와 맞바꾼다.',
          bullets([
            d.protection ? '먼저 카드를 써서 자기 선수를 보호할 수 있다.' : '보호 단계는 없다.',
            d.turns === 'one' ? '한 차례에 카드 한 장씩 돌아가며 쓴다.' : '자기 차례에 카드를 모두 쓴다.',
            '한 번 옮긴 선수는 드래프트가 끝날 때까지 보호돼 다시 옮길 수 없다.',
            d.unusedCards === 'expire' ? '쓰지 않은 카드는 사라진다.' : '쓰지 않은 카드는 다음 시즌으로 넘어간다.',
          ]),
        ].join('\n')
      : '드래프트가 없다.'
  return ['[목차]', '== 개요 ==', `[[${titles.league}]]의 드래프트.`, '== 방식 ==', how, '[[분류:리그]]'].join('\n')
}

function seasonPage(titles: WikiTitles, label: string): string {
  return ['[목차]', '== 개요 ==', `[[${titles.league}]]의 ${label}.`, '== 순위 ==', '[기록]', '[[분류:시즌]]'].join('\n')
}

function topicPage(id: string, publicText: string, rumor: string, involves: string[]): string {
  return [
    '[목차]',
    '== 개요 ==',
    publicText || `'''${id}'''에 대한 문서.`,
    ...(involves.length ? ['== 관련 ==', bullets(involves.map((n) => `[[${n}]]`))] : []),
    ...(rumor ? ['== 카더라 ==', bullets(rumor.split('\n').filter((l) => l.trim()).map((l) => l.trim()))] : []),
    '[각주]',
    '[[분류:화제]]',
  ].join('\n')
}

const CATEGORY_LINE = /^\s*\[\[\s*분류\s*:\s*([^\]|]+?)\s*(\|[^\]]*)?\]\]\s*$/
const catName = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * A player's page files them under their current school. After a trade, a
 * draft swap or an undone move, a `[[분류:<old school> 선수]]` line becomes
 * the new school's (and any second old one goes). Only lines that are just a
 * school's category change; the rest of the page stays as written. Saved as
 * 2K World. `playerIds` limits the look (default: everyone). Returns how many
 * pages changed.
 */
export function syncSchoolCategories(db: Db, config: LeagueConfig, nowMs: number, playerIds?: readonly string[]): number {
  const teams = listTeams(db)
  // A school's category is its current name. A renamed school keeps its page's old title, and lines with either name are its.
  const current = wikiTitles(config, currentSeason(db).label, teams, []).team
  const school = new Map([...titlesByRef(db, 'team'), ...current].map(([id, title]) => [catName(`${title} 선수`), id]))
  const wanted = playerIds ? new Set(playerIds) : null
  let changed = 0
  for (const p of listPlayers(db)) {
    if (wanted && !wanted.has(p.id)) continue
    const own = current.get(p.teamId)
    const page = pageByRef(db, 'player', p.id)
    if (!own || !page || page.currentRev === null) continue
    const body = revisionBody(db, page.id, page.currentRev)!.body
    const lines = body.split('\n')
    const want = catName(`${own} 선수`)
    const nameOf = (line: string) => {
      const m = CATEGORY_LINE.exec(line)
      return m ? catName(m[1]!) : null
    }
    // Stale: another school's line, or this school's under an old name.
    const stale = (line: string) => {
      const name = nameOf(line)
      return name !== null && school.has(name) && name !== want
    }
    if (!lines.some(stale)) continue
    let has = lines.some((l) => nameOf(l) === want)
    const next = lines.flatMap((l) => {
      if (!stale(l)) return [l]
      if (has) return []
      has = true
      // A sort key ([[분류:A고 선수|가]]) stays.
      return [`[[분류:${own} 선수${CATEGORY_LINE.exec(l)?.[2] ?? ''}]]`]
    })
    try {
      saveRevision(db, { title: page.title, body: next.join('\n'), authorId: SYSTEM, summary: '소속 분류 갱신', baseRev: page.currentRev }, nowMs)
      changed++
    } catch (e) {
      console.warn(`[wiki] could not update ${page.title}'s school category`, e)
    }
  }
  return changed
}

/** Creates any page that doesn't exist yet. Returns how many were made. */
export function seedWiki(db: Db, config: LeagueConfig, lore: LoreLinks, nowMs: number): number {
  const teams = listTeams(db)
  const players = listPlayers(db)
  const season = currentSeason(db)
  const titles = wikiTitles(config, season.label, teams, players)
  let made = 0
  const make = (kind: Parameters<typeof saveRevision>[1]['kind'], refId: string | null, title: string, body: () => string) => {
    // One bad title (or lore file) must not stop the rest of the wiki.
    try {
      if (refId !== null ? pageByRef(db, kind!, refId) : pageByTitle(db, title)) return
      // A title already taken by another page (e.g. a traded player's twin): skip rather than take it over.
      if (pageByTitle(db, title)) return
      saveRevision(db, { title, kind, refId, body: body(), authorId: SYSTEM, summary: '문서 생성' }, nowMs)
      made++
    } catch (e) {
      console.warn(`[wiki] could not seed ${title}`, e)
    }
  }
  make('league', 'league', titles.league, () => leaguePage(config, titles, teams))
  make('rules', 'rules', titles.rules, () => rulesPage(config, titles))
  make('awards', 'awards', titles.awards, () => awardsPage(config, titles))
  make('draft', 'draft', titles.draft, () => draftPage(config, titles))
  make('season', String(season.id), titles.season, () => seasonPage(titles, season.label))
  for (const t of teams) make('team', t.id, titles.team.get(t.id)!, () => teamPage(config, titles, t, lore))
  for (const p of players) make('player', p.id, titles.player.get(p.id)!, () => playerPage(titles, p, lore))
  for (const w of lore.world) {
    if (w.kind !== 'world') continue
    make('topic', `world:${w.settings.id}`, w.settings.id, () => topicPage(w.settings.id, w.sections.public, w.sections.rumor, w.settings.involves))
  }
  return made
}
