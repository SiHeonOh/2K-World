import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { parseInline, parseWiki, plain, shownPage, type Block, type Inline, type WikiDoc } from '@shared/namumark'
import { macroFilled, type WikiData, type WikiTable } from '@shared/wiki'
import { GradeBadge } from '../../../components/ui'
import { t } from '../../../i18n'

const tw = t.wiki

/** Black or white, whichever reads better on a colour (#rrggbb). */
export function textOn(color: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color)
  if (!m) return '#ffffff'
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((h) => parseInt(h, 16) / 255)
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.6 ? '#1b1b1b' : '#ffffff'
}

/** A school's colours as a header's style: the first as the background, the second (or black or white) as the text. */
export const colorStyle = (colors: readonly string[] | undefined): CSSProperties | undefined =>
  colors?.[0] ? { background: colors[0], color: colors[1] ?? textOn(colors[0]) } : undefined

/** A line of namumark outside the page's text (an infobox value): bold, italics and links, red when the page is missing. */
export function WikiInline({ text, existing, onLink }: { text: string; existing: Set<string>; onLink: (title: string) => void }) {
  const nodes = useMemo(() => parseInline(text), [text])
  const draw = (list: Inline[], key: string): ReactNode[] =>
    list.map((n, i) => {
      const k = `${key}.${i}`
      switch (n.t) {
        case 'text':
        case 'code':
          return n.v
        case 'br':
          return <br key={k} />
        case 'b':
          return <strong key={k}>{draw(n.c, k)}</strong>
        case 'i':
          return <em key={k}>{draw(n.c, k)}</em>
        case 'link':
          return (
            <a key={k} href="#" className={existing.has(n.page) ? 'wk-link' : 'wk-link missing'} onClick={(e) => (e.preventDefault(), onLink(n.page))}>
              {draw(n.c, k)}
            </a>
          )
        default:
          return <span key={k}>{draw(n.c, k)}</span>
      }
    })
  return <>{draw(nodes, 'v')}</>
}

interface Props {
  doc: WikiDoc
  data: WikiData
  existing: Set<string>
  onLink: (title: string, anchor: string | null) => void
  /** The league's grade scale, best first: grade cells are coloured by it. */
  grades?: string[]
}

/** A heading with everything under it until the next heading of the same or a higher level. */
interface Section {
  heading: Extract<Block, { t: 'h' }>
  children: Node[]
}
type Node = Block | Section

function nest(blocks: Block[]): Node[] {
  const root: Node[] = []
  const stack: Section[] = []
  for (const b of blocks) {
    if (b.t === 'h') {
      while (stack.length && stack.at(-1)!.heading.level >= b.level) stack.pop()
      const s: Section = { heading: b, children: [] }
      ;(stack.length ? stack.at(-1)!.children : root).push(s)
      stack.push(s)
    } else {
      ;(stack.length ? stack.at(-1)!.children : root).push(b)
    }
  }
  return root
}

const isSection = (n: Node): n is Section => 'heading' in n

/**
 * Renders a parsed wiki page: headings fold, footnotes pop up, links go red
 * when the page is missing. Sections with nothing to show are left out (and
 * the 목차 numbered without them); a player's empty 개요 and 플레이 스타일
 * show the app's own text.
 */
export function WikiRender({ doc, data, existing, onLink, grades = [] }: Props) {
  const view = useMemo(() => shownPage(doc, (name) => macroFilled(data, name), (title) => Boolean(data.auto[title])), [doc, data])
  const autoDocs = useMemo(() => new Map(Object.entries(data.auto).map(([title, text]) => [title, parseWiki(text)])), [data.auto])
  const [folded, setFolded] = useState<Set<string>>(
    () => new Set(view.blocks.filter((b): b is Extract<Block, { t: 'h' }> => b.t === 'h' && b.folded).map((b) => b.id)),
  )
  const toggle = (id: string) =>
    setFolded((f) => {
      const next = new Set(f)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  let footnotesShown = false
  // The 목차 indents from the page's shallowest heading, as the numbering does.
  const topLevel = view.headings.reduce((m, h) => Math.min(m, h.level), 6)

  const inline = (nodes: Inline[], key = ''): ReactNode[] =>
    nodes.map((n, i) => {
      const k = `${key}.${i}`
      switch (n.t) {
        case 'text':
          return n.v
        case 'b':
          return <strong key={k}>{inline(n.c, k)}</strong>
        case 'i':
          return <em key={k}>{inline(n.c, k)}</em>
        case 'u':
          return <u key={k}>{inline(n.c, k)}</u>
        case 's':
          return <del key={k}>{inline(n.c, k)}</del>
        case 'br':
          return <br key={k} />
        case 'code':
          return <code key={k}>{n.v}</code>
        case 'color':
          return (
            <span key={k} style={{ color: n.color }}>
              {inline(n.c, k)}
            </span>
          )
        case 'size':
          return (
            <span key={k} style={{ fontSize: `${100 + n.step * 20}%` }}>
              {inline(n.c, k)}
            </span>
          )
        case 'fn':
          return (
            <sup key={k} className="wk-fn" title={plain(n.c)}>
              <a href={`#fn-${n.n}`} onClick={(e) => (e.preventDefault(), jump(`fn-${n.n}`))} id={`rfn-${n.n}`}>
                [{n.n}]
              </a>
            </sup>
          )
        case 'link': {
          // [[#s-2]] points into this page: never a red link.
          const found = n.page === '' || existing.has(n.page)
          return (
            <a
              key={k}
              href="#"
              className={found ? 'wk-link' : 'wk-link missing'}
              title={n.page}
              onClick={(e) => {
                e.preventDefault()
                onLink(n.page, n.anchor)
              }}
            >
              {inline(n.c, k)}
            </a>
          )
        }
      }
    })

  // An empty one shows nothing: its section is left out, or it sits under text that says enough.
  const table = (tbl: WikiTable | null, key: string) =>
    !tbl || tbl.rows.length === 0 ? null : (
      <div key={key} className="wk-table-wrap">
        <table className="wk-table">
          <thead>
            <tr>
              {tbl.columns.map((c, j) => (
                <th key={`${j}:${c}`} title={tbl.hints?.[j] ?? undefined} style={colorStyle(tbl.colors)}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tbl.rows.map((r, i) => (
              <tr key={i} className={r.total ? 'wk-total' : undefined}>
                {r.cells.map((c, j) => {
                  const tone = r.tones?.[j]
                  const cls = [tbl.grades?.includes(j) ? 'center' : '', tone ? `wk-tone ${tone}` : ''].filter(Boolean).join(' ')
                  const text = r.bold?.includes(j) ? <b>{c}</b> : c
                  return (
                    <td key={j} className={cls || undefined}>
                      {j === tbl.linkColumn && r.link ? (
                        <a href="#" className="wk-link" onClick={(e) => (e.preventDefault(), onLink(r.link!, null))}>
                          {text}
                        </a>
                      ) : tbl.grades?.includes(j) && c ? (
                        <GradeBadge grade={c} scale={grades} />
                      ) : (
                        text
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )

  const footnoteList = (key: string) => {
    footnotesShown = true
    return doc.footnotes.length ? (
      <ol key={key} className="wk-footnotes">
        {doc.footnotes.map((f) => (
          <li key={f.n} id={`fn-${f.n}`}>
            <a href={`#rfn-${f.n}`} onClick={(e) => (e.preventDefault(), jump(`rfn-${f.n}`))}>
              [{f.n}]
            </a>{' '}
            {inline(f.c, `fn${f.n}`)}
          </li>
        ))}
      </ol>
    ) : null
  }

  const block = (b: Block, key: string): ReactNode => {
    switch (b.t) {
      case 'p':
        return <p key={key}>{inline(b.c, key)}</p>
      case 'hr':
        return <hr key={key} />
      case 'pre':
        return <pre key={key}>{b.v}</pre>
      case 'quote':
        return <blockquote key={key}>{b.c.map((x, i) => block(x, `${key}.${i}`))}</blockquote>
      case 'fold':
        return (
          <details key={key} className="wk-fold">
            <summary>{b.title}</summary>
            {b.c.map((x, i) => block(x, `${key}.${i}`))}
          </details>
        )
      case 'list': {
        const items = b.items.map((it, i) => (
          <li key={i}>
            {inline(it.c, `${key}.${i}`)}
            {it.sub.map((s, j) => block(s, `${key}.${i}.${j}`))}
          </li>
        ))
        return b.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>
      }
      case 'table':
        return (
          <table key={key} className="wk-table">
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} colSpan={b.spans?.[i]?.[j] ?? undefined}>
                      {inline(c, `${key}.${i}.${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )
      case 'macro':
        switch (b.name) {
          case '목차':
            return view.headings.length ? (
              <div key={key} className="wk-toc">
                <div className="wk-toc-title">{tw.toc}</div>
                {view.headings.map((h) => (
                  <div key={h.id} className="wk-toc-item" style={{ paddingLeft: `${(h.level - topLevel) * 14}px` }}>
                    <a href={`#${h.id}`} onClick={(e) => (e.preventDefault(), jump(h.id))}>
                      {h.num}.
                    </a>{' '}
                    {h.title}
                  </div>
                ))}
              </div>
            ) : null
          case '각주':
            return footnoteList(key)
          case '기록':
            return table(data.record, key)
          case '정보':
            return table(data.roster, key)
          case '최근경기':
            return table(data.recent, key)
          case '역사':
            return data.history.length ? (
              <ul key={key} className="wk-history">
                {data.history.map((h, i) => (
                  <li key={i}>
                    {h.season ? <span className="wk-season">{h.season}</span> : null} {h.text}
                  </li>
                ))}
              </ul>
            ) : null
          case '인간관계':
            return data.relations.length ? (
              <ul key={key} className="wk-relations">
                {data.relations.map((r, i) => (
                  <li key={i} className={r.rumor ? 'wk-rumor' : undefined}>
                    {r.link ? (
                      <a href="#" className={existing.has(r.link) ? 'wk-link' : 'wk-link missing'} onClick={(e) => (e.preventDefault(), onLink(r.link!, null))}>
                        {r.name}
                      </a>
                    ) : (
                      <b>{r.name}</b>
                    )}
                    {r.team ? <span className="wk-rel-team">({r.team})</span> : null}
                    <span className="wk-rel-text">{r.text}</span>
                  </li>
                ))}
              </ul>
            ) : null
          case 'auto': {
            // The app's own text for an empty section (a player's 개요 and 플레이 스타일): no one wrote it, nothing stores it.
            const auto = b.arg ? autoDocs.get(b.arg) : undefined
            return auto ? (
              <div key={key} className="wk-auto" title={tw.autoHint}>
                {auto.blocks.map((x, i) => block(x, `${key}.${i}`))}
              </div>
            ) : null
          }
          default:
            return null
        }
      case 'h':
        return null
    }
  }

  const node = (n: Node, key: string): ReactNode => {
    if (!isSection(n)) return block(n, key)
    const h = n.heading
    const open = !folded.has(h.id)
    const Tag = `h${Math.min(6, h.level)}` as 'h2'
    return (
      <section key={key} className="wk-section">
        <Tag id={h.id} className={`wk-h l${h.level}${open ? '' : ' folded'}`} onClick={() => toggle(h.id)}>
          <a href={`#${h.id}`} className="wk-num" onClick={(e) => e.preventDefault()}>
            {h.num}.
          </a>{' '}
          {inline(h.text, key)}
        </Tag>
        {open ? n.children.map((c, i) => node(c, `${key}.${i}`)) : null}
      </section>
    )
  }

  const body = nest(view.blocks).map((n, i) => node(n, String(i)))
  return (
    <div className="wk-body">
      {body}
      {!footnotesShown && doc.footnotes.length ? footnoteList('fn-end') : null}
    </div>
  )
}
