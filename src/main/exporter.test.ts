import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { defaultCardSwap } from '@shared/config/defaults'
import { sampleSetup } from '@shared/testing/fixtures'
import { openDb, type Db } from '@data/db'
import { currentSeason, loadConfig, seedLeague, updateConfig } from '@data/league'
import { applyTrade, closeProtection, draftMove, finishDraft, giveAward, listCards, startNextSeason } from '@data/moves'
import { finishPlayoffs, listGames, recordScore, startPlayoffs, startSeason } from '@data/season'
import { exportLeague, localDate } from './exporter'

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), '2kw-export-'))
  db = openDb(join(dir, 'league.sqlite'))
  const setup = sampleSetup()
  setup.config.draft = {
    ...defaultCardSwap(8),
    allocation: [
      { fromRank: 1, toRank: 4, cards: 2 },
      { fromRank: 5, toRank: 8, cards: 3 },
    ],
    unusedCards: 'carry-over',
    cardTrades: { enabled: true, unbalanced: true, inSeasonCap: 3, capCounts: 'given' },
  }
  seedLeague(db, setup)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Lower team number always wins, by 10. */
function playOut(stage: 'regular' | 'playoffs') {
  for (;;) {
    const open = listGames(db, currentSeason(db).id).filter((g) => g.status === 'scheduled' && (g.stage === 'regular') === (stage === 'regular'))
    if (open.length === 0) return
    for (const g of open) {
      const homeWins = Number(g.home.slice(1)) < Number(g.away.slice(1))
      recordScore(db, { gameId: g.id, homeScore: homeWins ? 100 : 90, awayScore: homeWins ? 90 : 100, lines: null })
    }
  }
}

const LABELS = {
  season: '시즌',
  cards: '카드',
  draft: '드래프트',
  trades: '트레이드',
  card: '카드',
  team: '팀',
  protect: '보호',
  used: '사용',
  held: '보유',
  carried: '이월',
}

const sheets = (path: string) => {
  const wb = XLSX.read(readFileSync(path), { type: 'buffer' })
  return (name: string) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name]!, { header: 1 })
}

describe('the Excel export, every season', () => {
  it('puts each season’s cards, draft log and trades on one sheet each, season first', () => {
    // Season 1: t1 trades a card away, t1 protects a player, the draft closes and the card carries over.
    startSeason(db)
    const card = listCards(db, currentSeason(db).id).find((c) => c.ownerTeamId === 't1')!
    applyTrade(db, [{ kind: 'card', cardId: card.id, from: 't1', to: 't2' }])
    playOut('regular')
    startPlayoffs(db)
    playOut('playoffs')
    finishPlayoffs(db)
    draftMove(db, { kind: 'protect', teamId: 't1', playerId: 'p1' })
    closeProtection(db)
    finishDraft(db)
    startNextSeason(db, '시즌 2')
    startSeason(db)
    // Season 2: the carried card changes hands again.
    applyTrade(db, [{ kind: 'card', cardId: card.id, from: 't2', to: 't3' }])

    const sheet = sheets(exportLeague(db, dir, 'demo', LABELS, 'all'))
    const cards = sheet('카드')
    expect(cards[0]).toEqual(['시즌', '카드', 'owner', 'status'])
    // Season 1 keeps every card it had: the one t1 played, and the unplayed ones that carried over (as held then).
    const first = cards.filter((r) => r[0] === '시즌 1')
    expect(first.filter((r) => r[3] === '사용')).toEqual([['시즌 1', '가람고 #2', '가람고', '사용']])
    expect(first).toContainEqual(['시즌 1', `가람고 #${card.number}`, '나람고', '이월 → 시즌 2'])
    expect(first.every((r) => r[3] === '사용' || r[3] === '이월 → 시즌 2')).toBe(true)
    // Season 2 names the carried card with its season, apart from its own 가람고 #1.
    const second = cards.filter((r) => r[0] === '시즌 2')
    expect(second).toContainEqual(['시즌 2', `가람고 #${card.number} (시즌 1)`, '다람고', '보유'])
    expect(second).toContainEqual(['시즌 2', '가람고 #1', '가람고', '보유'])
    expect(sheet('드래프트').slice(1)).toEqual([['시즌 1', 1, '가람고', '보호', '가람고 #2', '가가가', '']])
    // Each trade names its card as its season knew it.
    expect(sheet('트레이드').slice(1).map((r) => [r[0], r[r.length - 1]])).toEqual([
      ['시즌 1', `가람고 #${card.number}`],
      ['시즌 2', `가람고 #${card.number} (시즌 1)`],
    ])
  })

  it('dates trades and names the file by this PC’s calendar, not UTC', () => {
    const tz = process.env.TZ
    process.env.TZ = 'Asia/Seoul'
    // 05:30 in Korea on the 11th is still the 10th in UTC.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-10T20:30:00Z'))
    try {
      startSeason(db)
      const card = listCards(db, currentSeason(db).id).find((c) => c.ownerTeamId === 't1')!
      applyTrade(db, [{ kind: 'card', cardId: card.id, from: 't1', to: 't2' }])
      const path = exportLeague(db, dir, 'demo', LABELS)
      expect(basename(path)).toBe('demo-2026-10-11-05-30-00.xlsx')
      expect(sheets(path)('트레이드').slice(1).map((r) => r[0])).toEqual(['2026-10-11'])
      expect(localDate('2026-10-10T14:59:59Z')).toBe('2026-10-10')
      expect(localDate('2026-10-10T15:00:00Z')).toBe('2026-10-11')
    } finally {
      vi.useRealTimers()
      if (tz === undefined) delete process.env.TZ
      else process.env.TZ = tz
    }
  })

  it('names each award with its group, and its period as the screens say it (3주차, 11월), never its code', () => {
    const { config } = loadConfig(db)
    config.awards.periodic[0]!.scope = 'conference'
    updateConfig(db, config)
    startSeason(db)
    // p13 plays for t3 (서), p1 for t1, p7 for t2; 이달의 선수 stays league-wide.
    giveAward(db, { awardId: 'potw', period: 'w3', teamRank: 1, playerId: 'p13' })
    giveAward(db, { awardId: 'potm', period: 'm2', teamRank: 1, playerId: 'p1' })
    giveAward(db, { awardId: 'all-league', period: '', teamRank: 2, playerId: 'p7' })
    const awards = sheets(exportLeague(db, dir, 'demo', LABELS))('awards')
    expect(awards).toEqual([
      ['award', 'period', 'teamRank', 'player', '팀'],
      ['올-리그 팀', '', 2, '나가나', '나람고'],
      ['이달의 선수', '11월', 1, '가가가', '가람고'],
      ['서 이주의 선수', '3주차', 1, '다가다', '다람고'],
    ])
  })

  it('names a season-1 card with its season in a current-season export too', () => {
    startSeason(db)
    const card = listCards(db, currentSeason(db).id).find((c) => c.ownerTeamId === 't1')!
    playOut('regular')
    startPlayoffs(db)
    playOut('playoffs')
    finishPlayoffs(db)
    closeProtection(db)
    finishDraft(db)
    startNextSeason(db, '시즌 2')

    const cards = sheets(exportLeague(db, dir, 'demo', LABELS))('카드')
    expect(cards[0]).toEqual(['카드', 'owner', 'status'])
    expect(cards).toContainEqual([`가람고 #${card.number} (시즌 1)`, '가람고', '보유'])
  })
})
