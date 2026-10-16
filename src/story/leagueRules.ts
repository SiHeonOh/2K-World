import { winsNeeded } from '@core/playoffs'
import { phaseSchema, type LeagueConfig, type Phase, type TeamControl, type Tiebreaker } from '@shared/config/schema'
import { positionAbbr, positionName } from '@shared/labels'
import { playedMode } from '@shared/played'
import { guaranteedCards } from '@data/season'

/**
 * The league's rules as writers read them, and as the wiki's 규칙 and 드래프트
 * pages state them: a compact Korean digest made from the config, a rule a
 * line. Fans and reporters argue inside these rules instead of inventing
 * 2-for-1 trades, signings, trades in the playoffs or a frozen school
 * trading. Everything comes from the config and the schools (frozen ones by
 * name), so it holds for any league: no draft, other tiers, no cap, trades
 * in other phases. A player moved within the draft is protected for the rest
 * of it whatever an old config's `swappedProtected` says (it's a rule).
 */

export type RulePart = 'league' | 'season' | 'playoffs' | 'trades' | 'cards' | 'draft'

export interface RuleSection {
  part: RulePart
  title: string
  lines: string[]
}

/** What the digest needs of each school: its name, and whether it's frozen. */
export type RuleSchool = { shortName: string; control: TeamControl }

const PHASE_KO: Record<Phase, string> = { preseason: '개막 전', regular: '정규시즌', playoffs: '플레이오프', draft: '드래프트', offseason: '비시즌' }
const TIEBREAK_KO: Record<Tiebreaker, string> = {
  'head-to-head': '상대 전적',
  'division-record': '디비전 승률',
  'conference-record': '컨퍼런스 승률',
  'point-diff': '득실차',
  'points-for': '총 득점',
  random: '추첨',
}

/** A series' length as fans say it: 단판, 3전 2선승, 7전 4선승. */
export const bestOfText = (n: number) => (n === 1 ? '단판' : `${n}전 ${winsNeeded(n)}선승`)

/** The rules by section (구성, 정규시즌, 플레이오프, 트레이드, 카드, 드래프트); a section with nothing to say is left out. */
export function leagueRules(config: LeagueConfig, schools: readonly RuleSchool[]): RuleSection[] {
  const n = schools.length
  const frozen = schools.filter((s) => s.control === 'frozen').map((s) => s.shortName)
  const draft = config.draft.kind === 'card-swap' ? config.draft : null
  const trades = config.trades
  const cardTrades = draft?.cardTrades.enabled ?? false
  const { conferences, divisions } = config.structure
  const sections: RuleSection[] = []
  const add = (part: RulePart, title: string, lines: (string | false | null)[]) => {
    const kept = lines.filter((l): l is string => Boolean(l))
    if (kept.length) sections.push({ part, title, lines: kept })
  }

  // 구성: the schools, the rosters, how players move (nobody new ever comes), frozen schools.
  const roster = config.roster
  const slots = roster.slots.map((s) => positionAbbr(s.name) ?? positionName(s.name)).join('·')
  const size = roster.slotMode === 'one-per-slot' ? roster.slots.length : null
  const ways = [trades.enabled ? '트레이드' : '', draft ? '드래프트' : ''].filter(Boolean)
  add('league', '구성', [
    [`학교 ${n}곳`, conferences.length ? `컨퍼런스 ${conferences.length}개(${conferences.map((c) => c.name).join('·')})` : '', divisions.length > 1 ? `디비전 ${divisions.length}개` : '']
      .filter(Boolean)
      .join(', ') + '.',
    size !== null
      ? `로스터는 학교마다 딱 ${size}명(${slots} 한 명씩), 어떤 거래 뒤에도 ${size}명이다.`
      : `로스터는 학교마다 ${roster.minPlayers === roster.maxPlayers ? roster.minPlayers : `${roster.minPlayers}~${roster.maxPlayers}`}명(포지션 ${slots}).`,
    ways.length
      ? `새 학교·새 선수는 없다(FA·신입생·방출 없음): 선수는 ${ways.join('와 ')}로만 옮긴다.`
      : '새 학교·새 선수는 없고, 선수가 학교를 옮기는 일도 없다.',
    frozen.length > 0 && `동결 학교 ${frozen.join(', ')}: 트레이드${draft ? '도 카드도 드래프트도' : '도'} 없고, 그 선수는 아무도 데려갈 수 없다.`,
  ])

  // 정규시즌: who meets whom and how often, how the table breaks ties.
  const schedule = config.season.schedule
  const breaks = [...config.season.standings.tiebreakers.filter((t) => t !== 'random').map((t) => TIEBREAK_KO[t]), TIEBREAK_KO.random]
  add('season', '정규시즌', [
    schedule.kind === 'round-robin'
      ? `모든 학교와 ${schedule.cycles === 1 ? '한 번씩' : `${schedule.cycles}번씩`}, 팀당 ${(n - 1) * schedule.cycles}경기${
          playedMode(config) ? '(2K 일정대로: 라운드 없이 N일차, 학교마다 치른 경기 수가 다르다)' : schedule.build === 'manual' ? '(대진은 라운드마다 사무국이 짠다)' : ''
        }.`
      : `팀당 ${schedule.gamesPerTeam}경기.`,
    `순위는 승률순, 같으면 ${breaks.join(' → ')}.`,
  ])

  // 플레이오프: who goes, the play-in, series lengths, the final.
  const p = config.season.playoffs
  if (!p.enabled) add('playoffs', '플레이오프', ['플레이오프 없음: 정규시즌 순위가 최종 순위다.'])
  else {
    const where = p.bracket === 'conference' ? '컨퍼런스마다' : '리그 전체'
    const d = p.directSeeds
    const series = bestOfText(p.seriesBestOf)
    const finals = bestOfText(p.finals.bestOf)
    let last: string
    if (p.bracket === 'league') last = p.finals.bestOf === p.seriesBestOf ? `시리즈는 결승까지 모두 ${series}.` : `시리즈는 ${series}, 마지막 라운드인 결승은 ${finals}.`
    else if (p.finals.kind === 'conference-champions' && conferences.length === 2) last = `시리즈는 ${series}, 파이널은 두 컨퍼런스 우승팀끼리 ${finals}.`
    else if (conferences.length <= 1) last = `시리즈는 ${series}, 마지막 라운드 승자가 우승.`
    else last = `시리즈는 ${series}. 통합 결승 없이 컨퍼런스마다 우승팀이 나온다.`
    add('playoffs', '플레이오프', [
      p.playIn.enabled
        ? `${where} 1~${d}위 직행, ${d + 1}~${d + 4}위는 ${bestOfText(p.playIn.bestOf)} 플레이-인으로 ${d + 1}·${d + 2}번 시드를 가린다.`
        : `${where} 1~${d}위가 플레이오프에 간다.`,
      last,
    ])
  }

  // 트레이드: when, the shape of a deal, the once-a-season lock, the GMs' windows.
  const phases = phaseSchema.options.filter((ph) => ph !== 'playoffs' && trades.phases.includes(ph))
  const open = trades.enabled && phases.length > 0
  const every = config.gm.tradeWindowEveryRounds
  add('trades', '트레이드', [
    !trades.enabled
      ? '선수 트레이드 없음.'
      : open
        ? `선수 트레이드는 ${phases.map((ph) => PHASE_KO[ph]).join('·')}에만. 플레이오프 중엔 ${cardTrades ? '선수도 카드도' : '어떤 선수도'} 트레이드 없음.`
        : '선수 트레이드를 하는 시기가 없다.',
    open &&
      `두 학교끼리만(삼각 트레이드 없음), ${trades.equalPlayerCount ? '선수는 같은 수끼리(1대1, 2대2…)' : '선수 수는 달라도 로스터 규칙은 지킨다'}${
        cardTrades ? (trades.cardsWithPlayers ? ', 선수 트레이드에 카드를 얹어도 된다' : ', 선수와 카드는 한 트레이드에 섞지 않는다') : ''
      }.`,
    open && trades.oncePerSeason.enabled && `한 번 트레이드된 선수는 ${trades.oncePerSeason.until === 'draft' ? '드래프트 전까지' : '그 시즌이 끝날 때까지'} 다시 트레이드할 수 없다.`,
    open && schools.some((s) => s.control === 'ai') && `단장들의 트레이드 창: ${every > 0 ? `정규시즌 ${every}${playedMode(config) ? '일차' : '라운드'}마다` : '사무국이 열 때만'}.`,
  ])

  if (!draft) {
    add('draft', '드래프트', ['드래프트 없음(카드도 없다).'])
    return sections
  }

  // 카드: how many by place, what comes when, trading them, whose turn a card is.
  const tiers = [...draft.allocation].filter((t) => t.fromRank <= n).sort((a, b) => a.fromRank - b.fromRank)
  const covered = Math.max(0, ...tiers.map((t) => Math.min(t.toRank, n)))
  const place = (from: number, to: number) => (from === to ? `${from}위` : `${from}~${to}위`)
  const lowest = guaranteedCards(config, n)
  const cap = draft.cardTrades.inSeasonCap
  const counted = draft.cardTrades.capCounts === 'given' ? `내줄 수 있는 카드는 ${cap}장` : draft.cardTrades.capCounts === 'received' ? `받을 수 있는 카드는 ${cap}장` : `카드가 낀 트레이드는 ${cap}번`
  const example = schools.find((s) => s.control !== 'frozen')?.shortName ?? '○○고'
  add('cards', '카드', [
    `카드(최종 순위): ${tiers.map((t) => `${place(t.fromRank, Math.min(t.toRank, n))} ${t.cards}장`).join(', ')}.${covered < n ? ` ${place(covered + 1, n)}는 더 받지 않는다.` : ''}`,
    lowest === 0
      ? '카드는 플레이오프가 끝나면 받는다.'
      : tiers.every((t) => t.cards === lowest)
        ? `${lowest}장 모두 개막 때 받는다(시즌 중 트레이드 가능).`
        : `${lowest}장은 개막 때 먼저 받고(시즌 중 트레이드 가능), 나머지는 플레이오프가 끝나면 받는다.`,
    cardTrades
      ? `카드 트레이드는 플레이오프만 빼고 언제든, 카드끼리는 ${draft.cardTrades.unbalanced ? '장수가 달라도 된다' : '같은 장수끼리만'}.`
      : '카드는 트레이드할 수 없다.',
    cardTrades &&
      cap !== null &&
      (cap === 0 ? '시즌 중(개막 전·정규시즌)에는 카드 트레이드를 할 수 없다.' : `시즌 중(개막 전·정규시즌) 학교마다 ${counted}까지(드래프트·비시즌은 한도 없음).`),
    `카드는 원래 학교와 번호로 부르고(${example} 2번), 누가 갖든 원래 학교 차례에 쓴다.`,
  ])

  // 드래프트: the order, protecting, swapping, the moved-player rule, what's left over.
  add('draft', '드래프트', [
    `지명 순서는 최종 순위 역순(꼴찌가 먼저)${frozen.length ? ', 동결 학교는 빠진다' : ''}.`,
    draft.protection ? '1단계 보호: 카드 한 장에 자기 선수 한 명(가장 늦게 쓸 카드가 나간다). 사무국이 보호를 마감하면 지명 시작.' : '보호 단계는 없다.',
    `${draft.protection ? '2단계 ' : ''}지명: ${draft.turns === 'all' ? '차례가 오면 가진 카드를 다 쓴다' : '한 바퀴에 학교마다 카드 한 장씩'}. 카드 한 장으로 자기 선수 한 명과 다른 학교의 보호 안 된 선수 한 명을 맞바꾼다(상대는 거부 못 함${
      draft.slotRule === 'same-slot' ? ', 같은 포지션끼리만' : ''
    }, 데려온 선수는 ${draft.incomingSlot === 'replaced' ? '내준 선수 자리로' : '자기 포지션 그대로'}). 패스해도 카드는 사라진다.`,
    '드래프트에서 한 번 옮긴 선수(스왑이든 트레이드든)는 끝날 때까지 다시 못 옮긴다.',
    draft.unusedCards === 'expire' ? '쓰지 않은 카드는 드래프트가 끝나면 사라진다.' : '쓰지 않은 카드는 다음 시즌으로 넘어간다.',
  ])
  return sections
}

/** The rules' heading writers read: these are the real rules, and nothing outside them exists. */
export const RULES_HEADING = '# 리그 규칙 (이 밖의 거래·영입·제도는 없다)'

/**
 * The digest as prompt text: the heading, then each section (all of them,
 * or only `parts`) as "## 제목" and its rules a line each. '' when the
 * parts asked for have nothing to say.
 */
export function rulesBlock(config: LeagueConfig, schools: readonly RuleSchool[], parts?: readonly RulePart[]): string {
  const sections = leagueRules(config, schools).filter((s) => !parts || parts.includes(s.part))
  if (sections.length === 0) return ''
  return [RULES_HEADING, ...sections.flatMap((s) => [`## ${s.title}`, ...s.lines.map((l) => `- ${l}`)])].join('\n')
}

/** The short form for writing about the standings race: how the table breaks ties and who reaches the playoffs. */
export const RACE_PARTS: readonly RulePart[] = ['season', 'playoffs']
