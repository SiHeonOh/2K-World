import { describe, expect, it } from 'vitest'
import { defaultCardSwap } from '@shared/config/defaults'
import { sampleSetup } from '@shared/testing/fixtures'
import { openDb, type Db } from '@data/db'
import { listTeams, loadConfig, seedLeague, updateConfig } from '@data/league'
import { pageByRef, pageHistory, revisionBody, saveRevision, SYSTEM } from '@data/wiki'
import type { LoreLinks } from '@lore/folder'
import { leagueRules } from './leagueRules'
import { seedWiki } from './wiki'

const noLore: LoreLinks = { team: new Map(), gm: new Map(), player: new Map(), world: [], orphanFiles: [], playersWithout: [], misplaced: [], duplicates: [] }
const body = (db: Db, kind: 'rules' | 'draft') => {
  const page = pageByRef(db, kind, kind)!
  return revisionBody(db, page.id, page.currentRev!)!.body
}
const seed = (db: Db) => seedWiki(db, loadConfig(db).config, noLore, Date.now())

/** A card-swap league of the made-up schools, with the once-a-season lock on. */
function cardLeague(): Db {
  const db = openDb(':memory:')
  const setup = sampleSetup()
  setup.config.draft = defaultCardSwap(8)
  setup.config.trades.oncePerSeason = { enabled: true, until: 'draft' }
  seedLeague(db, setup)
  return db
}

describe('the seeded rules pages', () => {
  it('never describe a draft that doesn’t happen (an old “일반 드래프트” runs none)', () => {
    const db = openDb(':memory:')
    seedLeague(db, sampleSetup())
    const { config } = loadConfig(db)
    updateConfig(db, { ...config, draft: { kind: 'standard', rounds: 2, order: 'reverse-rank' } })
    seed(db)
    expect(body(db, 'rules')).toContain('== 드래프트 ==\n드래프트는 없다.')
    expect(body(db, 'rules')).not.toContain('일반 드래프트')
    expect(body(db, 'rules')).not.toContain('카드')
    expect(body(db, 'draft')).toContain('드래프트가 없다.')
    expect(body(db, 'draft')).not.toContain('지명')
  })

  it('carry the writers’ rules digest as wiki sections: the rules page the league and trades, the draft page the cards and the draft', () => {
    const db = cardLeague()
    seed(db)
    const { config } = loadConfig(db)
    const rules = leagueRules(config, listTeams(db))
    const of = (part: string) => rules.find((s) => s.part === part)!
    const page = body(db, 'rules')
    for (const part of ['league', 'season', 'playoffs', 'trades']) {
      expect(page).toContain(`== ${of(part).title} ==\n${of(part).lines.map((l) => ` * ${l}`).join('\n')}`)
    }
    expect(page).toContain(' * 한 번 트레이드된 선수는 드래프트 전까지 다시 트레이드할 수 없다.')
    expect(page).toContain('== 드래프트 ==\n카드 스왑 드래프트. 카드와 지명 규칙은 [[테스트 리그/드래프트]] 참고.')
    expect(page).not.toContain('== 카드 ==')
    const draft = body(db, 'draft')
    for (const part of ['cards', 'draft']) expect(draft).toContain(`== ${of(part).title} ==\n${of(part).lines.map((l) => ` * ${l}`).join('\n')}`)
    expect(draft).toContain(' * 드래프트에서 한 번 옮긴 선수(스왑이든 트레이드든)는 끝날 때까지 다시 못 옮긴다.')
    expect(draft).toContain('트레이드 규칙은 [[테스트 리그/규칙]] 참고.')
  })

  it('follow the rules while only 2K World wrote them: older seeded text and a rule change are written again', () => {
    const db = cardLeague()
    // A league seeded before the digest: its pages as they were seeded then.
    const rulesId = saveRevision(db, { title: '테스트 리그/규칙', kind: 'rules', refId: 'rules', body: '[목차]\n== 개요 ==\n옛 규칙 문서.', authorId: SYSTEM, summary: '문서 생성' }, 1).pageId
    seed(db)
    expect(body(db, 'rules')).toContain('== 트레이드 ==')
    expect(pageHistory(db, rulesId)[0]).toMatchObject({ rev: 2, summary: '규칙 갱신', author: { kind: 'system' } })
    // Nothing changed: no new revision.
    seed(db)
    expect(pageByRef(db, 'rules', 'rules')!.currentRev).toBe(2)
    // A school frozen in 리그 설정: both pages say so.
    db.prepare("UPDATE teams SET control = 'frozen' WHERE id = 't6'").run()
    seed(db)
    expect(body(db, 'rules')).toContain(' * 동결 학교 바람고: 트레이드도 카드도 드래프트도 없고, 그 선수는 아무도 데려갈 수 없다.')
    expect(body(db, 'draft')).toContain('동결 학교는 빠진다')
  })

  it('stay as they are once anyone else edited them', () => {
    const db = cardLeague()
    seed(db)
    const page = pageByRef(db, 'rules', 'rules')!
    const mine = `${body(db, 'rules')}\n내가 덧붙인 줄.`
    saveRevision(db, { title: page.title, body: mine, authorId: 'me', summary: '', baseRev: page.currentRev }, Date.now())
    const draft = pageByRef(db, 'draft', 'draft')!
    saveRevision(db, { title: draft.title, body: `${body(db, 'draft')}\n편집자 줄.`, authorId: 'f001', summary: '', baseRev: draft.currentRev }, Date.now())
    db.prepare("UPDATE teams SET control = 'frozen' WHERE id = 't6'").run()
    seed(db)
    expect(body(db, 'rules')).toBe(mine)
    expect(body(db, 'rules')).not.toContain('동결')
    expect(body(db, 'draft')).toContain('편집자 줄.')
    expect(body(db, 'draft')).not.toContain('동결')
  })
})
