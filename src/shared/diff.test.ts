import { describe, expect, it } from 'vitest'
import { diffSeq, diffText, type DiffOp } from './diff'

/** Replays a script: what it keeps and adds must be b, what it keeps and deletes must be a. */
function replay<T>(a: T[], b: T[], ops: DiffOp[]): { a: T[]; b: T[] } {
  const outA: T[] = []
  const outB: T[] = []
  let i = 0
  let j = 0
  for (const op of ops) {
    if (op === 'same') {
      expect(a[i]).toBe(b[j])
      outA.push(a[i++]!)
      outB.push(b[j++]!)
    } else if (op === 'del') outA.push(a[i++]!)
    else outB.push(b[j++]!)
  }
  return { a: outA, b: outB }
}

/** The fewest changes, by brute force (longest common subsequence). */
function fewest(a: string[], b: string[]): number {
  const t = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!)
  return a.length + b.length - 2 * t[0]![0]!
}

describe('diffSeq', () => {
  it('finds the shortest script, every time', () => {
    let seed = 7
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    for (let n = 0; n < 400; n++) {
      const word = () => Array.from({ length: Math.floor(random() * 9) }, () => 'abc'[Math.floor(random() * 3)]!)
      const a = word()
      const b = word()
      const ops = diffSeq(a, b)
      expect(replay(a, b, ops)).toEqual({ a, b })
      expect(ops.filter((o) => o !== 'same').length).toBe(fewest(a, b))
    }
  })

  it('gives up past its limit and calls it all replaced', () => {
    const ops = diffSeq(['a', 'b', 'c', 'd'], ['w', 'x', 'y', 'z'], 2)
    expect(ops).toEqual(['del', 'del', 'del', 'del', 'add', 'add', 'add', 'add'])
    expect(diffSeq([], ['a'])).toEqual(['add'])
    expect(diffSeq(['a'], [])).toEqual(['del'])
  })
})

describe('diffText', () => {
  it('marks the words that changed in a rewritten line, and counts lines', () => {
    const d = diffText('== 개요 ==\n팀은 3연승을 달렸다.\n끝', '== 개요 ==\n팀은 4연승을 달렸다.\n끝')
    expect(d).toMatchObject({ added: 1, removed: 1 })
    expect(d.rows.map((r) => r.kind)).toEqual(['same', 'del', 'add', 'same'])
    const [, del, add] = d.rows as Extract<(typeof d.rows)[number], { pieces: unknown }>[]
    expect(del!.pieces).toEqual([
      { text: '팀은 ', changed: false },
      { text: '3', changed: true },
      { text: '연승을 달렸다.', changed: false },
    ])
    expect(add!.pieces.find((p) => p.changed)?.text).toBe('4')
    expect([del!.old, del!.new, add!.old, add!.new]).toEqual([2, null, null, 2])
  })

  it("doesn't mark words in a line that was rewritten outright", () => {
    const d = diffText('완전히 다른 문장이다.', '전혀 새로 쓴 글.')
    expect(d.rows.every((r) => r.kind === 'skip' || r.pieces.every((p) => !p.changed))).toBe(true)
  })

  it('folds long unchanged stretches, keeping context around each change', () => {
    const before = Array.from({ length: 30 }, (_, i) => `줄 ${i + 1}`)
    const after = [...before]
    after[14] = '바뀐 줄'
    after.push('새 줄')
    const d = diffText(before.join('\n'), after.join('\n'), 2)
    expect(d.rows.map((r) => (r.kind === 'skip' ? `skip ${r.lines}` : r.kind))).toEqual([
      'skip 12',
      'same',
      'same',
      'del',
      'add',
      'same',
      'same',
      'skip 11',
      'same',
      'same',
      'add',
    ])
    expect(diffText('같다\n같다', '같다\n같다').rows).toEqual([{ kind: 'skip', lines: 2 }])
    expect(diffText('같다', '같다').rows).toEqual([{ kind: 'same', old: 1, new: 1, pieces: [{ text: '같다', changed: false }] }])
  })
})
