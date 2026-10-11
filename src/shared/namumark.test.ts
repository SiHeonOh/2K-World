import { describe, expect, it } from 'vitest'
import { parseInline, parseWiki, plain, splitWikiSections } from './namumark'

describe('namumark inline', () => {
  it('reads emphasis, links, colours and sizes', () => {
    expect(parseInline("'''굵게''' ''기울임'' __밑줄__ ~~취소~~")).toEqual([
      { t: 'b', c: [{ t: 'text', v: '굵게' }] },
      { t: 'text', v: ' ' },
      { t: 'i', c: [{ t: 'text', v: '기울임' }] },
      { t: 'text', v: ' ' },
      { t: 'u', c: [{ t: 'text', v: '밑줄' }] },
      { t: 'text', v: ' ' },
      { t: 's', c: [{ t: 'text', v: '취소' }] },
    ])
    expect(parseInline('[[가람고]]와 [[누리고|라이벌]], [[허다솜#s-2]]')).toEqual([
      { t: 'link', page: '가람고', anchor: null, c: [{ t: 'text', v: '가람고' }] },
      { t: 'text', v: '와 ' },
      { t: 'link', page: '누리고', anchor: null, c: [{ t: 'text', v: '라이벌' }] },
      { t: 'text', v: ', ' },
      { t: 'link', page: '허다솜', anchor: 's-2', c: [{ t: 'text', v: '허다솜#s-2' }] },
    ])
    expect(parseInline("{{{#red 빨강}}} {{{#ff8800 주황}}} {{{+2 크게}}} {{{그대로 '''둠'''}}}")).toEqual([
      { t: 'color', color: 'red', c: [{ t: 'text', v: '빨강' }] },
      { t: 'text', v: ' ' },
      { t: 'color', color: '#ff8800', c: [{ t: 'text', v: '주황' }] },
      { t: 'text', v: ' ' },
      { t: 'size', step: 2, c: [{ t: 'text', v: '크게' }] },
      { t: 'text', v: ' ' },
      { t: 'code', v: "그대로 '''둠'''" },
    ])
  })

  it('numbers footnotes, allows nesting, and leaves stray markers alone', () => {
    const ctx = { footnotes: [], categories: [], links: [] }
    const out = parseInline('본문[* 첫 [[링크]] 각주]과 둘째[*둘]', ctx)
    expect(out.filter((n) => n.t === 'fn').map((n) => (n as { n: number }).n)).toEqual([1, 2])
    expect(ctx.links).toEqual(['링크'])
    expect(plain(parseInline("it's a '' lone mark [[ open"))).toBe("it's a '' lone mark [[ open")
  })
})

describe('namumark blocks', () => {
  const doc = parseWiki(`[목차]
== 개요 ==
'''허다솜'''은 [[가람고]]의 슈터다.[* 2학년.]
=== 플레이 스타일 ===
 * 3점슛
  * 캐치 앤 슛
 * 수비
==# 여담 #==
|| 시즌 || 득점 ||
|| 1 || 20.5 ||
> 인용문
----
{{{#!folding 펼치기
접힌 내용 [[누리고]]
}}}
[기록]
[[분류:가람고 선수]]
[각주]`)

  it('numbers headings and records folding', () => {
    expect(doc.headings).toEqual([
      { level: 2, num: '1', id: 's-1', title: '개요' },
      { level: 3, num: '1.1', id: 's-1.1', title: '플레이 스타일' },
      { level: 2, num: '2', id: 's-2', title: '여담' },
    ])
    expect(doc.blocks.find((b) => b.t === 'h' && b.num === '2')).toMatchObject({ folded: true })
  })

  it('builds lists, tables, quotes, folds and macros, and collects links and categories', () => {
    const kinds = doc.blocks.map((b) => b.t)
    expect(kinds).toEqual(['macro', 'h', 'p', 'h', 'list', 'h', 'table', 'quote', 'hr', 'fold', 'macro', 'macro'])
    const list = doc.blocks.find((b) => b.t === 'list')!
    expect(list.t === 'list' && list.items.length).toBe(2)
    expect(list.t === 'list' && list.items[0]!.sub[0]!.t).toBe('list')
    const table = doc.blocks.find((b) => b.t === 'table')!
    expect(table.t === 'table' && table.rows.map((r) => r.map(plain))).toEqual([
      ['시즌', '득점'],
      ['1', '20.5'],
    ])
    expect(doc.links).toEqual(['가람고', '누리고'])
    expect(doc.categories).toEqual(['가람고 선수'])
    expect(doc.footnotes).toHaveLength(1)
    expect(doc.blocks.filter((b) => b.t === 'macro').map((b) => (b as { name: string }).name)).toEqual(['목차', '기록', '각주'])
  })

  it('splits a page into sections for section edits', () => {
    const sections = splitWikiSections('[목차]\n== 개요 ==\n가\n=== 세부 ===\n나\n== 여담 ==\n다\n')
    expect(sections.map((s) => s.title)).toEqual([null, '개요', '세부', '여담'])
    expect(sections.map((s) => s.text).join('')).toBe('[목차]\n== 개요 ==\n가\n=== 세부 ===\n나\n== 여담 ==\n다\n')
  })
})

describe('namumark sections', () => {
  const join = (source: string) =>
    splitWikiSections(source)
      .map((s) => s.text)
      .join('')

  it('gives back the source exactly', () => {
    const sources = [
      '',
      '\n',
      '\n\n  \n',
      '본문만 있는 문서',
      '본문만\n여러 줄\n',
      '== 개요 ==\n가\n== 여담 ==\n나',
      '== 개요 ==\n가\n== 여담 ==\n나\n',
      '== 개요 ==\n가\n== 여담 ==\n나\n\n\n',
      '[목차]\r\n== 개요 ==\r\n가\r\n=== 세부 ===\r\n나\r\n',
      '[목차]\r\n== 개요 ==\r\n가\r\n== 여담 ==\r\n나',
      '앞\r== 옛 맥 ==\r가\n== 섞임 ==\r\n나\r',
      '\n\n== 빈 줄 뒤 ==\n가',
      '== 하나 ==',
      '== 하나 ==\n== 둘 ==\n',
    ]
    for (const s of sources) expect(join(s)).toBe(s)
  })

  it('keeps the text before the first heading only when there is some', () => {
    expect(splitWikiSections('')).toEqual([])
    expect(splitWikiSections('== 개요 ==\n가')).toEqual([{ title: '개요', level: 2, text: '== 개요 ==\n가' }])
    expect(splitWikiSections('\n== 개요 ==\n가')).toEqual([
      { title: null, level: 0, text: '\n' },
      { title: '개요', level: 2, text: '== 개요 ==\n가' },
    ])
    expect(splitWikiSections('제목 없는 글\n')).toEqual([{ title: null, level: 0, text: '제목 없는 글\n' }])
  })

  it('finds headings in CRLF text and keeps the line endings', () => {
    const sections = splitWikiSections('== 개요 ==\r\n가\r\n==# 여담 #==  \r\n나\r\n')
    expect(sections).toEqual([
      { title: '개요', level: 2, text: '== 개요 ==\r\n가\r\n' },
      { title: '여담', level: 2, text: '==# 여담 #==  \r\n나\r\n' },
    ])
  })

  it('splits on exactly the lines parseWiki reads as headings', () => {
    const source = ['== 가 ==', '=== 나 ===', '==다==', '=== 짝 안 맞음 ==', '=x   ', '======= 일곱 =======', '== ==', '==# 반쪽 ==', '앞 == 중간 ==']
      .map((l) => `${l}\n본문`)
      .join('\n')
    const titles = splitWikiSections(source)
      .filter((s) => s.title !== null)
      .map((s) => s.title)
    expect(titles).toEqual(['가', '나', '다'])
    expect(parseWiki(source).headings.map((h) => h.title)).toEqual(titles)
  })
})

describe('namumark heading numbers', () => {
  const nums = (source: string) => parseWiki(source).headings.map((h) => h.num)

  it('counts from the shallowest level on the page', () => {
    expect(nums('=== 가 ===\n== 나 ==')).toEqual(['1.1', '2'])
    expect(nums('=== 가 ===\n=== 나 ===')).toEqual(['1', '2'])
    expect(nums('= 가 =\n== 나 ==\n= 다 =')).toEqual(['1', '1.1', '2'])
  })

  it('keeps a skipped level at 1 for the headings after it', () => {
    expect(nums('== A ==\n==== B ====\n=== C ===\n==== D ====')).toEqual(['1', '1.1.1', '1.2', '1.2.1'])
    expect(nums('==== A ====\n== B ==\n==== C ====\n=== D ===')).toEqual(['1.1.1', '2', '2.1.1', '2.2'])
  })

  it('never repeats an id, and blocks carry the same numbers as the table of contents', () => {
    let seed = 7
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const lines = Array.from({ length: 600 }, (_, k) => {
      const level = 1 + Math.floor(rand() * 6)
      return `${'='.repeat(level)} 제목${k} ${'='.repeat(level)}`
    })
    const doc = parseWiki(lines.join('\n'))
    const ids = doc.headings.map((h) => h.id)
    expect(doc.headings).toHaveLength(600)
    expect(new Set(ids).size).toBe(600)
    expect(new Set(doc.headings.map((h) => h.num)).size).toBe(600)
    const blocks = doc.blocks.filter((b) => b.t === 'h')
    expect(blocks.map((b) => b.id)).toEqual(ids)
    expect(blocks.map((b) => b.num)).toEqual(doc.headings.map((h) => h.num))
  })

  it('counts headings inside folds and quotes in page order', () => {
    const doc = parseWiki('== 가 ==\n{{{#!folding 더보기\n=== 나 ===\n}}}\n> === 다 ===\n== 라 ==')
    expect(doc.headings.map((h) => [h.title, h.num, h.id])).toEqual([
      ['가', '1', 's-1'],
      ['나', '1.1', 's-1.1'],
      ['다', '1.2', 's-1.2'],
      ['라', '2', 's-2'],
    ])
  })
})

describe('namumark footnotes', () => {
  it('numbers an outer footnote before the ones inside it', () => {
    const ctx: NonNullable<Parameters<typeof parseInline>[1]> = { footnotes: [], categories: [], links: [] }
    const out = parseInline('가[* 바깥[* 안쪽]] 나[* 다음]', ctx)
    const fn = out.filter((n) => n.t === 'fn') as { n: number; c: { t: string; n?: number }[] }[]
    expect(fn.map((n) => n.n)).toEqual([1, 3])
    expect(fn[0]!.c.find((n) => n.t === 'fn')).toMatchObject({ n: 2 })
    expect(ctx.footnotes.map((f) => f.n)).toEqual([1, 2, 3])
  })

  it('keeps numbers unique however deep notes nest', () => {
    const doc = parseWiki('[* 하나[* 둘[* 셋]]] [* 넷]')
    expect(doc.footnotes.map((f) => f.n)).toEqual([1, 2, 3, 4])
    expect(doc.footnotes.map((f) => plain(f.c))).toEqual(['하나', '둘', '셋', '넷'])
  })
})

describe('namumark tables', () => {
  const table = (source: string) => {
    const t = parseWiki(source).blocks.find((b) => b.t === 'table')
    if (!t || t.t !== 'table') throw new Error('no table')
    return { cells: t.rows.map((r) => r.map(plain)), spans: t.spans }
  }

  it('reads an empty cell between separators as a column span', () => {
    expect(table('||||가||나||\n||다||||라||\n||마||바||사||')).toEqual({
      cells: [['가', '나'], ['다', '라'], ['마', '바', '사']],
      spans: [
        [2, 1],
        [1, 2],
        [1, 1, 1],
      ],
    })
    expect(table('||||||셋||')).toEqual({ cells: [['셋']], spans: [[3]] })
  })

  it('keeps a cell holding only spaces as an empty cell', () => {
    expect(table('|| 가 || ||')).toEqual({ cells: [['가', '']], spans: undefined })
  })

  it('strips every leading cell attribute and spans by <-N>', () => {
    expect(table('|| <bgcolor=#fff><-2> 가 || 나 ||\n||<:><width=50%>다||<-3>라||<#f00> <-1> 마 ||')).toEqual({
      cells: [
        ['가', '나'],
        ['다', '라', '마'],
      ],
      spans: [
        [2, 1],
        [1, 3, 1],
      ],
    })
    expect(table('|| <:> 가 <b> || 나 ||')).toEqual({ cells: [['가 <b>', '나']], spans: undefined })
  })

  it('leaves out spans when no cell spans more than one column', () => {
    const t = parseWiki('|| 가 || 나 ||').blocks[0]!
    expect(t).toEqual({
      t: 'table',
      rows: [[[{ t: 'text', v: '가' }], [{ t: 'text', v: '나' }]]],
    })
  })
})
