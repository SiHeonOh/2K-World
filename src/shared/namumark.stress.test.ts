import { describe, expect, it } from 'vitest'
import { parseInline, parseWiki, plain, splitWikiSections, type Block, type Inline } from './namumark'

// Pages are parsed in the main process on save, so hostile input must neither
// freeze nor crash it. Each case is about 200 KB and takes a few milliseconds;
// the bound is loose so a slow machine doesn't flake.
const LIMIT_MS = 1500

const nest = (open: string, mid: string, close: string, n: number) => open.repeat(n) + mid + close.repeat(n)
const lines = (n: number, line: (k: number) => string) => Array.from({ length: n }, (_, k) => line(k)).join('\n')

const inlineDepth = (nodes: Inline[]): number => Math.max(0, ...nodes.map((n) => ('c' in n ? 1 + inlineDepth(n.c) : 0)))
const blockDepth = (blocks: Block[]): number =>
  Math.max(0, ...blocks.map((b) => (b.t === 'quote' || b.t === 'fold' ? 1 + blockDepth(b.c) : b.t === 'list' ? 1 + Math.max(0, ...b.items.map((it) => blockDepth(it.sub))) : 0)))

const cases: [string, string][] = [
  ['[[ openers with no closer', '[[a '.repeat(50_000)],
  ['[[ openers and one closer at the end', '[[a '.repeat(50_000) + ']]'],
  ['[* openers with no closer', '[*a '.repeat(50_000)],
  ['[* openers and one closer at the end', '[*a '.repeat(50_000) + ']'],
  ['a line of [', '['.repeat(200_000)],
  ['a line of {{{', '{{{'.repeat(66_000)],
  ['{{{ openers and one closer at the end', '{{{a '.repeat(40_000) + '}}}'],
  ['pair openers', "''a".repeat(30_000) + "'''b".repeat(25_000) + '--c'.repeat(10_000)],
  ['a line of dashes', '-'.repeat(200_000) + 'x'],
  ['= and a long run of spaces', '=x' + ' '.repeat(200_000)],
  ['a line of =', '='.repeat(200_000)],
  ['heading with a long title', `== ${'='.repeat(100_000)}a${' '.repeat(100_000)}`],
  ['nested footnotes', nest('[* ', 'x', ']', 50_000)],
  ['nested colours', nest('{{{#red ', 'x', '}}}', 18_000)],
  ['nested sizes', nest('{{{+1 ', 'x', '}}}', 22_000)],
  ['nested link labels', nest('[[a|', 'x', ']]', 33_000)],
  ['nested emphasis and footnotes', nest("'''[* ''[* __[* ~~[* ", 'x', "]~~]__]'']'''", 4_000)],
  ['a line of >', '>'.repeat(200_000) + ' x'],
  ['quotes nesting one level deeper each line', lines(600, (k) => `${'>'.repeat(k + 1)} x`)],
  ['unclosed {{{#!wiki lines', '{{{#!wiki\n'.repeat(20_000)],
  ['nested {{{#!folding blocks', '{{{#!folding a\n'.repeat(7_000) + '}}}\n'.repeat(7_000)],
  ['nested {{{#!wiki and quotes', lines(10_000, () => '> {{{#!wiki')],
  ['list indented one more each line', lines(600, (k) => `${' '.repeat(k + 1)}* x`)],
  ['a table row of empty cells', '||'.repeat(100_000)],
  ['a table cell full of attributes', `||${'<a>'.repeat(66_000)}x||`],
  ['many table rows', lines(20_000, () => '||a||||b||')],
  ['many distinct links', Array.from({ length: 20_000 }, (_, k) => `[[문서${k}]]`).join('')],
  ['many categories', Array.from({ length: 15_000 }, (_, k) => `[[분류:${k}]]`).join('\n')],
  ['a line of [br]', '[br]'.repeat(50_000)],
  ['many rules in one wiki block', `{{{#!wiki\n${'----\n'.repeat(40_000)}}}}`],
  ['many headings', lines(25_000, (k) => `${'='.repeat(1 + (k % 6))} h ${'='.repeat(1 + (k % 6))}`)],
]

describe('namumark on hostile input', () => {
  for (const [name, source] of cases) {
    it(`parses ${name} quickly`, () => {
      const start = performance.now()
      parseWiki(source)
      parseInline(source)
      const sections = splitWikiSections(source)
      const ms = performance.now() - start
      expect(sections.map((s) => s.text).join('')).toBe(source)
      expect(ms).toBeLessThan(LIMIT_MS)
    })
  }
})

describe('namumark nesting limits', () => {
  it('leaves inline markup nested past the limit as text', () => {
    const source = nest('{{{#red ', 'x', '}}}', 30)
    const out = parseInline(source)
    expect(inlineDepth(out)).toBe(21)
    expect(plain(out)).toBe(nest('{{{#red ', 'x', '}}}', 9))
  })

  it('still numbers footnotes nested past the limit, and only those it reads', () => {
    const doc = parseWiki(nest('[* ', 'x', ']', 5_000))
    expect(doc.footnotes.length).toBe(21)
    expect(doc.footnotes.map((f) => f.n)).toEqual(Array.from({ length: 21 }, (_, k) => k + 1))
  })

  it('stops nesting quotes at the limit and shows the rest as text', () => {
    const doc = parseWiki(`${'>'.repeat(12)} 깊다`)
    expect(blockDepth(doc.blocks)).toBe(10)
    let b: Block = doc.blocks[0]!
    while (b.t === 'quote') b = b.c[0]!
    expect(b.t === 'p' && plain(b.c)).toBe('>> 깊다')
  })

  it('stops nesting wiki and folding blocks at the limit', () => {
    const doc = parseWiki('{{{#!folding a\n'.repeat(15) + '본문\n' + '}}}\n'.repeat(15))
    expect(blockDepth(doc.blocks)).toBe(10)
  })

  it('stops nesting lists at the limit and keeps every item', () => {
    const doc = parseWiki(lines(30, (k) => `${' '.repeat(k + 1)}* ${k}`))
    expect(blockDepth(doc.blocks)).toBe(10)
    const items: string[] = []
    const walk = (blocks: Block[]) => {
      for (const b of blocks) if (b.t === 'list') for (const it of b.items) items.push(plain(it.c)), walk(it.sub)
    }
    walk(doc.blocks)
    expect(items).toEqual(Array.from({ length: 30 }, (_, k) => String(k)))
  })
})
