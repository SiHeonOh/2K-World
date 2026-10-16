import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultCardSwap } from '@shared/config/defaults'
import { sampleSetup } from '@shared/testing/fixtures'
import { openDb, type Db } from '@data/db'
import { currentSeason, seedLeague } from '@data/league'
import { applyTrade, closeProtection, draftMove, draftView, finishDraft, listCards } from '@data/moves'
import { finishPlayoffs, listGames, recordScore, startPlayoffs, startSeason } from '@data/season'
import { readDraftOutlook } from '@data/draftOutlook'
import { readLeague } from './context'
import { cardsBlock, schoolCards } from './draftCards'

let dir: string
let db: Db

/**
 * The made-up schools (가람고 t1 … 아람고 t8) in a card-swap league: 5 cards
 * for 1st, 4 for 2nd to 4th, 3 for the rest, a cap of 3 cards given in
 * season, 바람고 (t6) frozen, each school's PG its star.
 */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), '2kw-cards-'))
  db = openDb(join(dir, 'league.db'))
  const setup = sampleSetup()
  setup.config.draft = {
    ...defaultCardSwap(8),
    allocation: [
      { fromRank: 1, toRank: 1, cards: 5 },
      { fromRank: 2, toRank: 4, cards: 4 },
      { fromRank: 5, toRank: 8, cards: 3 },
    ],
    cardTrades: { enabled: true, unbalanced: true, inSeasonCap: 3, capCounts: 'given' },
  }
  setup.teams[5]!.control = 'frozen'
  for (const p of setup.players) p.ratings = { ovr: p.slotId === 'pg' ? 90 : 60, shoot: 'B' }
  seedLeague(db, setup)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** Plays every scheduled game of these stages, again and again: the lower-numbered school wins. */
function playAll(stages: (stage: string) => boolean): void {
  for (;;) {
    const open = listGames(db, currentSeason(db).id).filter((g) => g.status === 'scheduled' && stages(g.stage))
    if (open.length === 0) return
    for (const g of open) {
      const homeWins = Number(g.home.slice(1)) < Number(g.away.slice(1))
      recordScore(db, { gameId: g.id, homeScore: homeWins ? 100 : 90, awayScore: homeWins ? 90 : 100, lines: null })
    }
  }
}

function sellCards(from: string, to: string, numbers: number[]): void {
  const cards = listCards(db, currentSeason(db).id).filter((c) => c.originalTeamId === from && numbers.includes(c.number))
  applyTrade(db, cards.map((c) => ({ kind: 'card' as const, cardId: c.id, from, to })))
}

const lines = (text: string) => text.split('\n')

describe('the card table', () => {
  it('gives every school a line in season: cards by name, cards sent, the cap used, what it’s on track to have, its best two', () => {
    startSeason(db)
    playAll((s) => s === 'regular')
    sellCards('t8', 't1', [1, 2, 3])
    sellCards('t7', 't2', [1])
    const league = readLeague(db, dir)
    const text = cardsBlock(league, 'all')
    expect(lines(text)[0]).toBe('# 학교별 드래프트 카드 (예상은 지금 순위 그대로 끝날 때, (+n)은 그 순위로 더 받는 카드. 숫자는 여기 적힌 그대로)')
    expect(lines(text)[1]).toBe('시즌 중 카드 트레이드 한도: 학교마다 내준 카드 3장까지')
    expect(text).toContain('- 가람고 1위: 카드 6장(자기 1·2·3번, 아람고 1·2·3번) · 드래프트 예상 8장(+2) · 핵심 가가가(OVR 90), 가나나(OVR 60)')
    expect(text).toContain('- 나람고 2위: 카드 4장(자기 1·2·3번, 사람고 1번) · 드래프트 예상 5장(+1)')
    expect(text).toContain('- 사람고 7위: 카드 2장(자기 2·3번) · 내준 카드 자기 1번→나람고 · 시즌 중 내준 카드 1장(한도까지 2장 남음) · 드래프트 예상 2장 · 핵심')
    expect(text).toContain('- 아람고 8위: 카드 0장 · 내준 카드 자기 1·2·3번→가람고 · 시즌 중 내준 카드 3장(한도 다 씀) · 드래프트 예상 0장 · 핵심')
    expect(text).toContain('- 바람고 6위: 동결 학교, 카드 없음, 드래프트 불참')
    // A line a school, by place.
    expect(lines(text).filter((l) => l.startsWith('- '))).toHaveLength(8)
    // The short form: only the schools named, same lines.
    const short = cardsBlock(league, ['t8', 't1'])
    expect(lines(short).filter((l) => l.startsWith('- ')).map((l) => l.split(' ')[1])).toEqual(['가람고', '아람고'])
    expect(short).toContain(lines(text).find((l) => l.startsWith('- 아람고'))!)
    expect(cardsBlock(league, [])).toBe('')
    expect(schoolCards(league, readDraftOutlook(db), 't8')).toBe(lines(text).find((l) => l.startsWith('- 아람고'))!.slice(2))
  })

  it('names no place before a game, and says the cards come at the season start', () => {
    const text = cardsBlock(readLeague(db, dir), 'all')
    expect(lines(text)[0]).toBe('# 학교별 드래프트 카드 (개막 전이라 순위는 아직 없다. 개막 때 학교마다 3장씩 받는다. 숫자는 여기 적힌 그대로)')
    expect(text).toContain('- 가람고: 핵심 가가가(OVR 90), 가나나(OVR 60)')
    expect(text).not.toContain('카드 0장')
    expect(text).not.toMatch(/\d위/)
    expect(text).not.toContain('예상')
  })

  it('counts the final ranking in the playoffs, then shows the draft room: order, the card on the clock, moves, each school’s', () => {
    startSeason(db)
    playAll((s) => s === 'regular')
    sellCards('t8', 't1', [1])
    startPlayoffs(db)
    const playoffs = cardsBlock(readLeague(db, dir), 'all')
    expect(lines(playoffs)[0]).toContain('최종 순위 확정')
    expect(playoffs).toContain('- 가람고 1위: 카드 4장(자기 1·2·3번, 아람고 1번) · 드래프트 때 6장(+2)')
    // Nothing is traded in the playoffs: no cap line.
    expect(playoffs).not.toContain('한도')
    playAll((s) => s !== 'regular')
    finishPlayoffs(db)
    draftMove(db, { kind: 'protect', teamId: 't3', playerId: 'p13' })
    closeProtection(db)
    // 아람고's slot plays first, with the card 가람고 holds: 가람고 sends a bench player for 라람고's star.
    const next = draftView(db).next!
    draftMove(db, { kind: 'swap', teamId: next.ownerTeamId, cardId: next.id, playerId: 'p6', targetPlayerId: 'p19' })
    const room = cardsBlock(readLeague(db, dir), 'all')
    expect(lines(room)[0]).toBe('# 드래프트 현황 (지명 진행 중. 숫자는 여기 적힌 그대로)')
    expect(room).toContain('지명 순서: 아람고 → 사람고 → 마람고 → 라람고 → 다람고 → 나람고 → 가람고')
    expect(room).toContain('다음 차례: 사람고 1번 카드(사람고가 쓴다)')
    expect(room).toContain(`지금까지 지명과 패스 1번, 최근: 가람고: 가바바 주고 라람고 라가라 데려옴`)
    expect(room).toContain('- 가람고(지명 7번째): 남은 카드 5장(자기 1·2·3·4·5번) · 데려옴 라가라(라람고에서) · 내줌 가바바(→라람고)')
    // 다람고 protected its star with its latest card (its 4th).
    expect(room).toContain('- 다람고(지명 5번째): 남은 카드 3장(자기 1·2·3번) · 보호 다가다')
    expect(room).toContain('- 바람고: 동결 학교, 드래프트 불참')
    // Named schools only: no order or move list, their lines.
    const short = cardsBlock(readLeague(db, dir), ['t4'])
    expect(short).not.toContain('지명 순서')
    expect(short).toContain('- 라람고(지명 4번째): 남은 카드 4장(자기 1·2·3·4번) · 데려옴 가바바(가람고에서) · 내줌 라가라(→가람고)')
  })

  it('says the cards are gone once the draft is over, and is empty without the card-swap draft', () => {
    startSeason(db)
    playAll((s) => s === 'regular')
    startPlayoffs(db)
    playAll((s) => s !== 'regular')
    finishPlayoffs(db)
    closeProtection(db)
    finishDraft(db)
    expect(cardsBlock(readLeague(db, dir), 'all')).toBe('# 드래프트 카드 (비시즌: 이번 드래프트는 끝났다)\n- 쓰지 않은 카드는 남아 있지 않다. 다음 시즌 개막 때 학교마다 3장씩 새로 받는다.')
    const plain = openDb(':memory:')
    seedLeague(plain, sampleSetup())
    expect(cardsBlock({ ...readLeague(db, dir), db: plain }, 'all')).toBe('')
  })
})
