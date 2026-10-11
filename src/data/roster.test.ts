import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { ko } from '../renderer/i18n/ko'
import { openDb, type Db } from './db'
import { listEvents, listPlayers, listTeams, seedLeague } from './league'
import { updatePlayers } from './roster'
import { RuleError } from './rules'

function league(): Db {
  const db = openDb(':memory:')
  seedLeague(db, sampleSetup())
  return db
}

const refusal = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    if (e instanceof RuleError) return e.issues.map((i) => i.code)
    throw e
  }
  return []
}

describe('roster edits', () => {
  it('changes only the named fields, records what changed, and clears a rating with null', () => {
    const db = league()
    const [a] = listPlayers(db)
    const changes = updatePlayers(db, [
      { playerId: a!.id, height: '6\'8"', nicknames: [' 청룡 ', '', '용'], notes: '왼손잡이.', ratings: { ovr: 91, shoot: 'A+' } },
    ])
    expect(changes).toEqual([{ playerId: a!.id, teamId: a!.teamId, fields: ['height', 'nicknames', 'notes', 'ratings.ovr', 'ratings.shoot'], renamedFrom: null }])
    const after = listPlayers(db).find((p) => p.id === a!.id)!
    expect(after).toMatchObject({ name: a!.name, height: '6\'8"', nicknames: ['청룡', '용'], notes: '왼손잡이.', ratings: { ovr: 91, shoot: 'A+' } })
    expect(after.heightCm).toBeCloseTo(203.2, 0)
    expect(listEvents(db, 'player_edited')).toHaveLength(1)

    updatePlayers(db, [{ playerId: a!.id, ratings: { shoot: null } }])
    expect(listPlayers(db).find((p) => p.id === a!.id)!.ratings.shoot).toBeUndefined()
    // Nothing different: nothing written.
    expect(updatePlayers(db, [{ playerId: a!.id, notes: '왼손잡이.' }])).toEqual([])
  })

  it('checks everything first and refuses all of it if anything is wrong', () => {
    const db = league()
    const [a, b] = listPlayers(db)
    const before = JSON.stringify(listPlayers(db))
    expect(
      refusal(() =>
        updatePlayers(db, [
          { playerId: a!.id, ratings: { ovr: 120 } },
          { playerId: b!.id, ratings: { shoot: 'Z' } },
          { playerId: b!.id, name: '  ' },
          { playerId: 'nobody', notes: 'x' },
        ]),
      ),
    ).toEqual(['roster-duplicate-edit', 'roster-rating-range', 'roster-rating-grade', 'roster-name-empty', 'roster-unknown-player'])
    expect(JSON.stringify(listPlayers(db))).toBe(before)
  })

  it('lets you edit players an import left with one name on one team', () => {
    const db = league()
    const players = listPlayers(db)
    const [a, b] = players.filter((p) => p.teamId === players[0]!.teamId)
    db.prepare('UPDATE players SET name = ? WHERE id = ?').run(a!.name, b!.id)
    expect(updatePlayers(db, [{ playerId: b!.id, ratings: { ovr: 80 } }])).toHaveLength(1)
    // Renaming one of them away from the clash is fine too.
    expect(updatePlayers(db, [{ playerId: b!.id, name: '다른이름' }])[0]!.renamedFrom).toBe(a!.name)
  })

  it('renames, but never into a name a teammate has, or one a file can’t carry', () => {
    const db = league()
    const players = listPlayers(db)
    const [a, b] = players.filter((p) => p.teamId === players[0]!.teamId)
    expect(refusal(() => updatePlayers(db, [{ playerId: a!.id, name: b!.name }]))).toEqual(['roster-name-taken'])
    for (const bad of ['김/하람', '김하람(가람고)', 'con', 'x'.repeat(81), '_x', '.x']) expect(refusal(() => updatePlayers(db, [{ playerId: a!.id, name: bad }]))).toEqual(['roster-name-bad'])
    // A school's name, or its GM file's, would take that file's place.
    const school = listTeams(db)[0]!.shortName
    for (const taken of [school, `${school} 단장`]) expect(refusal(() => updatePlayers(db, [{ playerId: a!.id, name: taken }]))).toEqual(['roster-name-reserved'])
    expect(refusal(() => updatePlayers(db, [{ playerId: a!.id, notes: 'x' }, { playerId: a!.id, height: '6\'0"' }]))).toEqual(['roster-duplicate-edit'])
    // Swapping two teammates' names in one save is fine.
    updatePlayers(db, [
      { playerId: a!.id, name: b!.name },
      { playerId: b!.id, name: a!.name },
    ])
    expect(listPlayers(db).find((p) => p.id === a!.id)!.name).toBe(b!.name)
    // A name another school's player has is fine (a 동명이인).
    const other = players.find((p) => p.teamId !== a!.teamId)!
    expect(updatePlayers(db, [{ playerId: a!.id, name: other.name }])[0]).toMatchObject({ fields: ['name'], renamedFrom: b!.name })
  })
})

// The sample league: 가람고 (t1) is p1 PG, p2 SG, p3 SF, p4 PF, p5 C (starters) and p6 Bench; 나람고 (t2) is p7…p12.
describe('slot changes', () => {
  const slots = (db: Db, teamId: string) => Object.fromEntries(listPlayers(db).filter((p) => p.teamId === teamId).map((p) => [p.id, p.slotId]))
  const issuesOf = (fn: () => unknown) => {
    try {
      fn()
    } catch (e) {
      if (e instanceof RuleError) return e.issues
      throw e
    }
    return []
  }

  it('swaps two teammates in one save, with the other edits, and writes one event per team', () => {
    const db = league()
    const changes = updatePlayers(db, [
      { playerId: 'p5', slotId: 'bench', notes: '식스맨으로.' },
      { playerId: 'p6', slotId: 'c' },
    ])
    expect(changes).toEqual([
      { playerId: 'p5', teamId: 't1', fields: ['notes', 'slot'], renamedFrom: null },
      { playerId: 'p6', teamId: 't1', fields: ['slot'], renamedFrom: null },
    ])
    expect(slots(db, 't1')).toEqual({ p1: 'pg', p2: 'sg', p3: 'sf', p4: 'pf', p5: 'bench', p6: 'c' })
    expect(listPlayers(db).find((p) => p.id === 'p5')!.notes).toBe('식스맨으로.')
    // A starter went to the bench: a rotation change.
    expect(listEvents(db, 'slots_changed').map((e) => e.payload)).toEqual([
      {
        teamId: 't1',
        changes: [
          { playerId: 'p5', from: 'c', to: 'bench' },
          { playerId: 'p6', from: 'bench', to: 'c' },
        ],
        rotation: true,
      },
    ])
    // The slot has its own event: player_edited names only his other facts.
    expect(listEvents(db, 'player_edited').map((e) => e.payload)).toEqual([{ playerId: 'p5', teamId: 't1', fields: ['notes'] }])

    // The PG and the SG trading places changes nobody's role; two schools in one save get an event each.
    updatePlayers(db, [
      { playerId: 'p1', slotId: 'sg' },
      { playerId: 'p2', slotId: 'pg' },
      { playerId: 'p7', slotId: 'sf' },
      { playerId: 'p9', slotId: 'pg' },
    ])
    expect(listEvents(db, 'slots_changed').slice(1).map((e) => e.payload)).toMatchObject([
      { teamId: 't1', rotation: false },
      { teamId: 't2', rotation: false },
    ])
    expect(slots(db, 't2')).toMatchObject({ p7: 'sf', p9: 'pg' })
    // A slot sent unchanged isn't a change.
    expect(updatePlayers(db, [{ playerId: 'p1', slotId: 'sg' }])).toEqual([])
  })

  it('refuses a half-made swap, naming the school and the slot left empty or doubled, and changes nothing', () => {
    const db = league()
    const before = JSON.stringify(listPlayers(db))
    const issues = issuesOf(() => updatePlayers(db, [{ playerId: 'p5', slotId: 'bench' }]))
    expect(issues).toEqual([
      { code: 'roster-slot-empty', params: { team: '가람고', slot: 'C', count: 0 } },
      { code: 'roster-slot-doubled', params: { team: '가람고', slot: 'Bench', count: 2 } },
    ])
    expect(ko.rules['roster-slot-empty']!(issues[0]!.params)).toContain('가람고: C 자리가 비어요')
    expect(ko.rules['roster-slot-doubled']!(issues[1]!.params)).toContain('가람고: Bench 자리에 2명')
    // Leaving him without a slot leaves his slot empty too.
    expect(refusal(() => updatePlayers(db, [{ playerId: 'p5', slotId: null }]))).toEqual(['roster-slot-empty'])
    // A slot the league doesn't have.
    expect(refusal(() => updatePlayers(db, [{ playerId: 'p5', slotId: 'center' }]))).toEqual(['roster-slot-unknown'])
    // Each school is checked on its own: the other half of a swap on another team doesn't fix it.
    expect(issuesOf(() => updatePlayers(db, [{ playerId: 'p5', slotId: 'bench' }, { playerId: 'p12', slotId: 'c' }])).map((i) => `${i.params.team} ${i.code}`)).toEqual([
      '가람고 roster-slot-empty',
      '가람고 roster-slot-doubled',
      '나람고 roster-slot-doubled',
      '나람고 roster-slot-empty',
    ])
    expect(JSON.stringify(listPlayers(db))).toBe(before)
    expect(listEvents(db, 'slots_changed')).toHaveLength(0)
  })

  it('waits for the draft to end, but a frozen school may still change its own lineup', () => {
    const db = league()
    const swap = [
      { playerId: 'p5', slotId: 'bench' },
      { playerId: 'p6', slotId: 'c' },
    ]
    // Frozen means no trades and no draft, not no lineup.
    db.prepare("UPDATE teams SET control = 'frozen' WHERE id = 't1'").run()
    expect(updatePlayers(db, swap)).toHaveLength(2)
    db.prepare("UPDATE seasons SET phase = 'draft'").run()
    expect(refusal(() => updatePlayers(db, [{ playerId: 'p5', slotId: 'c' }, { playerId: 'p6', slotId: 'bench' }]))).toEqual(['roster-slot-draft'])
    expect(slots(db, 't1')).toMatchObject({ p5: 'bench', p6: 'c' })
    // His other facts still change, his own slot sent along with them too.
    expect(updatePlayers(db, [{ playerId: 'p5', slotId: 'bench', notes: '드래프트 중.' }])).toEqual([{ playerId: 'p5', teamId: 't1', fields: ['notes'], renamedFrom: null }])
  })

  it('explains every refusal a roster edit can give', () => {
    const codes = ['roster.ts', '../main/roster.ts'].flatMap((f) => [...readFileSync(join(__dirname, f), 'utf8').matchAll(/'(roster-[a-z0-9-]+)'/g)].map((m) => m[1]!))
    expect(codes).toEqual(expect.arrayContaining(['roster-slot-draft', 'roster-slot-empty', 'roster-slot-doubled', 'roster-slot-unknown', 'roster-lore-taken']))
    for (const code of codes) expect((ko.rules as Record<string, unknown>)[code], code).toBeDefined()
  })
})
