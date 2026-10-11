import { describe, expect, it } from 'vitest'
import { sampleSetup } from '@shared/testing/fixtures'
import { openDb } from './db'
import { seedLeague } from './league'
import { learnedNames, learnNames } from './namemap'

describe('name map storage', () => {
  it('learns, corrects and keeps same-name pairs by row order', () => {
    const db = openDb(':memory:')
    seedLeague(db, sampleSetup())
    learnNames(db, [
      { teamId: 't1', source: 'A. Kim', playerId: 'p1', row: 0 },
      { teamId: 't1', source: 'B. Lee', playerId: 'p2', row: 1 },
    ])
    expect(learnedNames(db, 't1')).toEqual([
      { source: 'a. kim', playerId: 'p1', rowOrder: 0 },
      { source: 'b. lee', playerId: 'p2', rowOrder: 1 },
    ])
    // A correction: "A. Kim" was really p3; p1 is "C. Park".
    learnNames(db, [
      { teamId: 't1', source: 'A. Kim', playerId: 'p3', row: 0 },
      { teamId: 't1', source: 'C. Park', playerId: 'p1', row: 2 },
    ])
    expect(learnedNames(db, 't1').map((l) => [l.source, l.playerId])).toEqual([
      ['a. kim', 'p3'],
      ['b. lee', 'p2'],
      ['c. park', 'p1'],
    ])
    // A same-name pair.
    learnNames(db, [
      { teamId: 't1', source: 'N. Kim', playerId: 'p4', row: 3 },
      { teamId: 't1', source: 'N. Kim', playerId: 'p5', row: 4 },
    ])
    expect(learnedNames(db, 't1').filter((l) => l.source === 'n. kim').map((l) => [l.playerId, l.rowOrder])).toEqual([
      ['p4', 3],
      ['p5', 4],
    ])
    db.close()
  })

  it('keeps the other half of a same-name pair when only one of them played', () => {
    const db = openDb(':memory:')
    seedLeague(db, sampleSetup())
    learnNames(db, [
      { teamId: 't1', source: 'N. Kim', playerId: 'p4', row: 3 },
      { teamId: 't1', source: 'N. Kim', playerId: 'p5', row: 4 },
    ])
    // Next game only p5 played, on another row.
    learnNames(db, [{ teamId: 't1', source: 'N. Kim', playerId: 'p5', row: 2 }])
    expect(learnedNames(db, 't1').map((l) => [l.source, l.playerId, l.rowOrder])).toEqual([
      ['n. kim', 'p5', 2],
      ['n. kim', 'p4', 3],
    ])
    // p4 turns out to be "N. Kimm" in 2K: his old entry goes, p5 keeps the name.
    learnNames(db, [{ teamId: 't1', source: 'N. Kimm', playerId: 'p4', row: 0 }])
    expect(learnedNames(db, 't1').map((l) => [l.source, l.playerId])).toEqual([
      ['n. kimm', 'p4'],
      ['n. kim', 'p5'],
    ])
    // Other teams are untouched.
    learnNames(db, [{ teamId: 't2', source: 'N. Kim', playerId: 'p7', row: 0 }])
    expect(learnedNames(db, 't1')).toHaveLength(2)
    db.close()
  })
})
