import { describe, expect, it } from 'vitest'
import { defaultCardSwap } from '@shared/config/defaults'
import type { CardSwapDraft, LeagueConfig } from '@shared/config/schema'
import { sampleSetup } from '@shared/testing/fixtures'
import { leagueRules, RACE_PARTS, RULES_HEADING, rulesBlock } from './leagueRules'

/** A league set up like a real card-swap one (made-up schools): tiers by place, a cap on cards given, a frozen school. */
function cardLeague(draft: Partial<CardSwapDraft> = {}, edit: (config: LeagueConfig) => void = () => {}) {
  const setup = sampleSetup()
  const config = setup.config
  config.draft = {
    ...defaultCardSwap(8),
    allocation: [
      { fromRank: 1, toRank: 1, cards: 5 },
      { fromRank: 2, toRank: 4, cards: 4 },
      { fromRank: 5, toRank: 8, cards: 3 },
    ],
    turns: 'all',
    cardTrades: { enabled: true, unbalanced: true, inSeasonCap: 3, capCounts: 'given' },
    ...draft,
  }
  config.trades.phases = ['preseason', 'regular', 'draft', 'offseason']
  config.trades.oncePerSeason = { enabled: true, until: 'draft' }
  config.season.schedule = { kind: 'round-robin', cycles: 1, build: 'played' }
  config.season.playoffs.playIn = { enabled: true, format: 'nba', bestOf: 1 }
  config.gm.tradeWindowEveryRounds = 0
  setup.teams[5]!.control = 'frozen'
  edit(config)
  return { config, teams: setup.teams }
}

describe('the rules digest', () => {
  it('states the sample league’s rules a line each: no draft, so no cards', () => {
    const { config, teams } = sampleSetup()
    const text = rulesBlock(config, teams)
    expect(text.split('\n')[0]).toBe(RULES_HEADING)
    for (const line of [
      '- 학교 8곳, 컨퍼런스 2개(동·서), 디비전 4개.',
      '- 로스터는 학교마다 딱 6명(PG·SG·SF·PF·C·벤치 멤버 한 명씩), 어떤 거래 뒤에도 6명이다.',
      '- 새 학교·새 선수는 없다(FA·신입생·방출 없음): 선수는 트레이드로만 옮긴다.',
      '- 모든 학교와 한 번씩, 팀당 7경기.',
      '- 순위는 승률순, 같으면 상대 전적 → 득실차 → 총 득점 → 추첨.',
      '- 컨퍼런스마다 1~2위가 플레이오프에 간다.',
      '- 시리즈는 7전 4선승, 파이널은 두 컨퍼런스 우승팀끼리 7전 4선승.',
      '- 선수 트레이드는 개막 전·정규시즌에만. 플레이오프 중엔 어떤 선수도 트레이드 없음.',
      '- 두 학교끼리만(삼각 트레이드 없음), 선수는 같은 수끼리(1대1, 2대2…).',
      '- 단장들의 트레이드 창: 정규시즌 5라운드마다.',
      '## 드래프트\n- 드래프트 없음(카드도 없다).',
    ]) {
      expect(text).toContain(line)
    }
    expect(text).not.toContain('## 카드')
    expect(text).not.toContain('동결')
    expect(text).not.toContain('카드를 얹')
    expect(text).not.toContain('다시 트레이드할 수 없다')
  })

  it('states a card-swap league’s whole draft, the trade locks and its frozen school, in about a thousand characters', () => {
    const { config, teams } = cardLeague()
    const text = rulesBlock(config, teams)
    for (const line of [
      '- 새 학교·새 선수는 없다(FA·신입생·방출 없음): 선수는 트레이드와 드래프트로만 옮긴다.',
      '- 동결 학교 바람고: 트레이드도 카드도 드래프트도 없고, 그 선수는 아무도 데려갈 수 없다.',
      '- 모든 학교와 한 번씩, 팀당 7경기(2K 일정대로: 라운드 없이 N일차, 학교마다 치른 경기 수가 다르다).',
      '- 컨퍼런스마다 1~2위 직행, 3~6위는 단판 플레이-인으로 3·4번 시드를 가린다.',
      '- 선수 트레이드는 개막 전·정규시즌·드래프트·비시즌에만. 플레이오프 중엔 선수도 카드도 트레이드 없음.',
      '- 두 학교끼리만(삼각 트레이드 없음), 선수는 같은 수끼리(1대1, 2대2…), 선수 트레이드에 카드를 얹어도 된다.',
      '- 한 번 트레이드된 선수는 드래프트 전까지 다시 트레이드할 수 없다.',
      '- 단장들의 트레이드 창: 사무국이 열 때만.',
      '- 카드(최종 순위): 1위 5장, 2~4위 4장, 5~8위 3장.',
      '- 3장은 개막 때 먼저 받고(시즌 중 트레이드 가능), 나머지는 플레이오프가 끝나면 받는다.',
      '- 카드 트레이드는 플레이오프만 빼고 언제든, 카드끼리는 장수가 달라도 된다.',
      '- 시즌 중(개막 전·정규시즌) 학교마다 내줄 수 있는 카드는 3장까지(드래프트·비시즌은 한도 없음).',
      '- 카드는 원래 학교와 번호로 부르고(가람고 2번), 누가 갖든 원래 학교 차례에 쓴다.',
      '- 지명 순서는 최종 순위 역순(꼴찌가 먼저), 동결 학교는 빠진다.',
      '- 1단계 보호: 카드 한 장에 자기 선수 한 명(가장 늦게 쓸 카드가 나간다). 사무국이 보호를 마감하면 지명 시작.',
      '- 2단계 지명: 차례가 오면 가진 카드를 다 쓴다. 카드 한 장으로 자기 선수 한 명과 다른 학교의 보호 안 된 선수 한 명을 맞바꾼다(상대는 거부 못 함, 데려온 선수는 내준 선수 자리로). 패스해도 카드는 사라진다.',
      '- 드래프트에서 한 번 옮긴 선수(스왑이든 트레이드든)는 끝날 때까지 다시 못 옮긴다.',
      '- 쓰지 않은 카드는 드래프트가 끝나면 사라진다.',
    ]) {
      expect(text).toContain(line)
    }
    // Dense prompt text: a rule a line, about a thousand characters.
    expect(text.length).toBeGreaterThan(600)
    expect(text.length).toBeLessThan(1400)
    expect(leagueRules(config, teams).map((s) => s.title)).toEqual(['구성', '정규시즌', '플레이오프', '트레이드', '카드', '드래프트'])
  })

  it('follows the config: no cap, other ways of counting it, other tiers, card trades off', () => {
    expect(rulesBlock(cardLeague({ cardTrades: { enabled: true, unbalanced: true, inSeasonCap: null, capCounts: 'given' } }).config, sampleSetup().teams)).not.toContain('시즌 중(개막 전·정규시즌)')
    const of = (cardTrades: CardSwapDraft['cardTrades']) => rulesBlock(cardLeague({ cardTrades }).config, sampleSetup().teams)
    expect(of({ enabled: true, unbalanced: false, inSeasonCap: 2, capCounts: 'received' })).toContain('학교마다 받을 수 있는 카드는 2장까지')
    expect(of({ enabled: true, unbalanced: false, inSeasonCap: 2, capCounts: 'received' })).toContain('카드끼리는 같은 장수끼리만.')
    expect(of({ enabled: true, unbalanced: true, inSeasonCap: 4, capCounts: 'trades' })).toContain('학교마다 카드가 낀 트레이드는 4번까지')
    expect(of({ enabled: true, unbalanced: true, inSeasonCap: 0, capCounts: 'given' })).toContain('- 시즌 중(개막 전·정규시즌)에는 카드 트레이드를 할 수 없다.')
    const off = of({ enabled: false, unbalanced: true, inSeasonCap: 3, capCounts: 'given' })
    expect(off).toContain('- 카드는 트레이드할 수 없다.')
    expect(off).toContain('플레이오프 중엔 어떤 선수도 트레이드 없음.')
    expect(off).not.toContain('카드를 얹')
    expect(off).not.toContain('3장까지')
    // One tier for everyone: all of it at the start. Tiers that stop short: the rest get no more.
    const flat = rulesBlock(cardLeague({ allocation: [{ fromRank: 1, toRank: 8, cards: 2 }] }).config, sampleSetup().teams)
    expect(flat).toContain('- 카드(최종 순위): 1~8위 2장.')
    expect(flat).toContain('- 2장 모두 개막 때 받는다(시즌 중 트레이드 가능).')
    expect(rulesBlock(cardLeague({ allocation: [{ fromRank: 1, toRank: 4, cards: 3 }] }).config, sampleSetup().teams)).toContain('- 카드(최종 순위): 1~4위 3장. 5~8위는 더 받지 않는다.')
  })

  it('follows the draft’s own settings, and always keeps a moved player put (an old swappedProtected is ignored)', () => {
    const text = rulesBlock(
      cardLeague({ protection: false, turns: 'one', slotRule: 'same-slot', incomingSlot: 'own', unusedCards: 'carry-over', swappedProtected: false }).config,
      sampleSetup().teams,
    )
    expect(text).toContain('- 보호 단계는 없다.')
    expect(text).toContain('- 지명: 한 바퀴에 학교마다 카드 한 장씩. 카드 한 장으로 자기 선수 한 명과 다른 학교의 보호 안 된 선수 한 명을 맞바꾼다(상대는 거부 못 함, 같은 포지션끼리만, 데려온 선수는 자기 포지션 그대로).')
    expect(text).toContain('- 드래프트에서 한 번 옮긴 선수(스왑이든 트레이드든)는 끝날 때까지 다시 못 옮긴다.')
    expect(text).toContain('- 쓰지 않은 카드는 다음 시즌으로 넘어간다.')
    // No frozen school: none is named, and nobody sits the draft out.
    expect(text).not.toContain('동결')
  })

  it('names trades in other phases, never the playoffs, and no trades at all', () => {
    const only = (phases: LeagueConfig['trades']['phases']) => rulesBlock(cardLeague({}, (c) => (c.trades.phases = phases)).config, sampleSetup().teams)
    expect(only(['regular'])).toContain('- 선수 트레이드는 정규시즌에만.')
    // Ticking the playoffs changes nothing: every player is locked then.
    expect(only(['regular', 'playoffs', 'offseason'])).toContain('- 선수 트레이드는 정규시즌·비시즌에만.')
    const none = rulesBlock(cardLeague({}, (c) => (c.trades.enabled = false)).config, sampleSetup().teams)
    expect(none).toContain('- 선수 트레이드 없음.')
    expect(none).toContain('선수는 드래프트로만 옮긴다.')
    expect(none).not.toContain('다시 트레이드할 수 없다')
    const { config, teams } = sampleSetup()
    config.trades.enabled = false
    expect(rulesBlock(config, teams)).toContain('- 새 학교·새 선수는 없고, 선수가 학교를 옮기는 일도 없다.')
  })

  it('states the playoffs as set: none, a league-wide bracket, conferences with no final', () => {
    const playoffs = (edit: (p: LeagueConfig['season']['playoffs']) => void) => {
      const { config, teams } = sampleSetup()
      edit(config.season.playoffs)
      return rulesBlock(config, teams, ['playoffs'])
    }
    expect(playoffs((p) => (p.enabled = false))).toContain('- 플레이오프 없음: 정규시즌 순위가 최종 순위다.')
    const league = playoffs((p) => {
      p.bracket = 'league'
      p.directSeeds = 6
      p.playIn.enabled = true
      p.finals.bestOf = 5
    })
    expect(league).toContain('- 리그 전체 1~6위 직행, 7~10위는 단판 플레이-인으로 7·8번 시드를 가린다.')
    expect(league).toContain('- 시리즈는 7전 4선승, 마지막 라운드인 결승은 5전 3선승.')
    expect(playoffs((p) => (p.finals.kind = 'none'))).toContain('- 시리즈는 7전 4선승. 통합 결승 없이 컨퍼런스마다 우승팀이 나온다.')
  })

  it('has a short form for the standings race: how ties break and who reaches the playoffs', () => {
    const { config, teams } = cardLeague()
    const race = rulesBlock(config, teams, RACE_PARTS)
    expect(race.split('\n').filter((l) => l.startsWith('## '))).toEqual(['## 정규시즌', '## 플레이오프'])
    expect(race).not.toContain('카드')
    expect(race.length).toBeLessThan(400)
  })
})
