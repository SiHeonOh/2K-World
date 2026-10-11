import { describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
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
