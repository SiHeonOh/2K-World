import { describe, expect, it } from 'vitest'
import { defaultCardSwap } from '@shared/config/defaults'
import { sampleSetup } from '@shared/testing/fixtures'
import { openDb, type Db } from '@data/db'
import { loadConfig, seedLeague, updateConfig } from '@data/league'
import { pageByRef, revisionBody } from '@data/wiki'
import type { LoreLinks } from '@lore/folder'
import { seedWiki } from './wiki'

const noLore: LoreLinks = { team: new Map(), gm: new Map(), player: new Map(), world: [], orphanFiles: [], playersWithout: [], misplaced: [], duplicates: [] }
const body = (db: Db, kind: 'rules' | 'draft') => {
  const page = pageByRef(db, kind, kind)!
  return revisionBody(db, page.id, page.currentRev!)!.body
}

describe('the seeded rules pages', () => {
  it('never describe a draft that doesn’t happen (an old “일반 드래프트” runs none)', () => {
    const db = openDb(':memory:')
    seedLeague(db, sampleSetup())
    const { config } = loadConfig(db)
    updateConfig(db, { ...config, draft: { kind: 'standard', rounds: 2, order: 'reverse-rank' } })
    seedWiki(db, loadConfig(db).config, noLore, Date.now())
    expect(body(db, 'rules')).toContain('드래프트는 없다.')
    expect(body(db, 'rules')).not.toContain('일반 드래프트')
    expect(body(db, 'draft')).toContain('드래프트가 없다.')
    expect(body(db, 'draft')).not.toContain('지명한다')
  })

  it('state the card swap’s rules and the trade locks as the league has them', () => {
    const db = openDb(':memory:')
    const setup = sampleSetup()
    setup.config.draft = defaultCardSwap(8)
    setup.config.trades.oncePerSeason = { enabled: true, until: 'draft' }
    seedLeague(db, setup)
    seedWiki(db, loadConfig(db).config, noLore, Date.now())
    expect(body(db, 'rules')).toContain('카드 스왑 드래프트')
    expect(body(db, 'rules')).toContain('플레이오프 중에는 모든 선수가 묶인다.')
    expect(body(db, 'rules')).toContain('한 번 트레이드된 선수는 드래프트까지 다시 트레이드할 수 없다.')
    expect(body(db, 'draft')).toContain('한 번 옮긴 선수는 드래프트가 끝날 때까지 보호돼 다시 옮길 수 없다.')
  })
})
