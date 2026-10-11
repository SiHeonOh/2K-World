import { useState, type ReactNode } from 'react'
import { plain, type Block, type Inline, type WikiDoc } from '@shared/namumark'
import type { WikiData, WikiTable } from '@shared/wiki'
import { t } from '../../../i18n'

const tw = t.wiki

interface Props {
  doc: WikiDoc
  data: WikiData
  existing: Set<string>
  onLink: (title: string, anchor: string | null) => void
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

/** Renders a parsed wiki page: headings fold, footnotes pop up, links go red when the page is missing. */
export function WikiRender({ doc, data, existing, onLink }: Props) {
  const [folded, setFolded] = useState<Set<string>>(
    () => new Set(doc.blocks.filter((b): b is Extract<Block, { t: 'h' }> => b.t === 'h' && b.folded).map((b) => b.id)),
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
  const topLevel = doc.headings.reduce((m, h) => Math.min(m, h.level), 6)

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

  const table = (tbl: WikiTable | null, empty: string, key: string) =>
    !tbl || tbl.rows.length === 0 ? (
      <p key={key} className="wk-empty">
        {empty}
      </p>
    ) : (
      <table key={key} className="wk-table">
        <thead>
          <tr>
            {tbl.columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tbl.rows.map((r, i) => (
            <tr key={i}>
              {r.cells.map((c, j) => (
                <td key={j}>
                  {j === tbl.linkColumn && r.link ? (
                    <a href="#" className="wk-link" onClick={(e) => (e.preventDefault(), onLink(r.link!, null))}>
                      {c}
                    </a>
                  ) : (
                    c
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
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
            return doc.headings.length ? (
              <div key={key} className="wk-toc">
                <div className="wk-toc-title">{tw.toc}</div>
                {doc.headings.map((h) => (
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
            return table(data.record, tw.emptyRecord, key)
          case '정보':
            return table(data.roster, tw.emptyRecord, key)
          case '최근경기':
            return table(data.recent, tw.emptyRecord, key)
          case '역사':
            return data.history.length ? (
              <ul key={key} className="wk-history">
                {data.history.map((h, i) => (
                  <li key={i}>
                    {h.season ? <span className="wk-season">{h.season}</span> : null} {h.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p key={key} className="wk-empty">
                {tw.emptyHistory}
              </p>
            )
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

  const body = nest(doc.blocks).map((n, i) => node(n, String(i)))
  return (
    <div className="wk-body">
      {body}
      {!footnotesShown && doc.footnotes.length ? footnoteList('fn-end') : null}
    </div>
  )
}
