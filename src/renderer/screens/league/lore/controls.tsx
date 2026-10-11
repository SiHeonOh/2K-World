import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { matches, type Person } from './people'

/**
 * A 1–5 scale: five steps that fill up to the value, with words at both ends.
 * Arrow keys move it, like any radio group.
 */
export function Scale({
  value,
  onChange,
  low,
  high,
  ariaLabel,
  small,
  disabled,
}: {
  value: number
  onChange: (v: number) => void
  low?: string
  high?: string
  ariaLabel: string
  small?: boolean
  disabled?: boolean
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const key = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0
    if (step === 0 || disabled) return
    e.preventDefault()
    const next = Math.min(5, Math.max(1, value + step))
    onChange(next)
    refs.current[next - 1]?.focus()
  }
  return (
    <div className={`lore-scale${small ? ' small' : ''}`}>
      {low ? <span className="lore-scale-end">{low}</span> : null}
      <div className="lore-scale-steps" role="radiogroup" aria-label={ariaLabel} onKeyDown={key}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            ref={(el) => void (refs.current[n - 1] = el)}
            type="button"
            role="radio"
            aria-checked={n === value}
            tabIndex={n === value ? 0 : -1}
            disabled={disabled}
            className={`${n <= value ? 'filled' : ''}${n === value ? ' on' : ''}`}
            onClick={() => n !== value && onChange(n)}
          >
            {n}
          </button>
        ))}
      </div>
      {high ? <span className="lore-scale-end">{high}</span> : null}
    </div>
  )
}

/** A text box that grows with its text. */
export function AutoTextarea({
  value,
  onChange,
  placeholder,
  minRows = 4,
  readOnly,
  ariaLabel,
  id,
  mono,
}: {
  value: string
  onChange?: (v: string) => void
  placeholder?: string
  minRows?: number
  readOnly?: boolean
  ariaLabel?: string
  id?: string
  mono?: boolean
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      id={id}
      aria-label={ariaLabel}
      className={`lore-textarea${mono ? ' mono' : ''}`}
      value={value}
      rows={minRows}
      placeholder={placeholder}
      readOnly={readOnly}
      spellCheck={false}
      wrap={mono ? 'off' : 'soft'}
      onChange={(e) => onChange?.(e.target.value)}
    />
  )
}

/**
 * A text box with suggestions: type to search people (or schools), arrows
 * and Enter to pick. Anything typed is kept as is, so names outside the
 * league still work.
 */
export function PersonPicker({
  value,
  onChange,
  people,
  placeholder,
  ariaLabel,
  status,
  disabled,
  onPick,
}: {
  value: string
  onChange: (v: string) => void
  people: Person[]
  /** Called instead of onChange when a suggestion is chosen. */
  onPick?: (p: Person) => void
  placeholder?: string
  ariaLabel: string
  /** A line under the box: what the text resolves to, or a warning. */
  status?: { tone: 'ok' | 'warn'; text: string } | null
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const listId = useId()
  const box = useRef<HTMLDivElement>(null)
  const query = value.replace(/\(.*$/, '')
  const options = (query.trim() === '' ? people : people.filter((p) => matches(p, query))).slice(0, 8)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const pick = (p: Person) => {
    if (onPick) onPick(p)
    else onChange(p.value)
    setOpen(false)
  }
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    // Mid-composition (Korean IME), keys belong to the composition: Enter commits the syllable, not a pick.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((a) => Math.min(options.length - 1, a + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(0, a - 1))
    } else if (e.key === 'Enter' && open && options[active]) {
      e.preventDefault()
      pick(options[active])
    } else if (e.key === 'Escape') setOpen(false)
  }

  return (
    <div className="lore-picker" ref={box}>
      <input
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
          setActive(0)
        }}
        onKeyDown={key}
      />
      {open && options.length > 0 ? (
        <ul className="lore-picker-list" id={listId} role="listbox">
          {options.map((p, i) => (
            <li
              key={`${p.value}|${p.playerId ?? p.teamId}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(p)
              }}
            >
              <span className="name">{p.value}</span>
              <span className="detail">{p.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {status ? <span className={`lore-picker-status ${status.tone}`}>{status.text}</span> : null}
    </div>
  )
}

/** A list of short values as chips, with a picker to add more. */
export function ChipList({
  values,
  onChange,
  people,
  addLabel,
  ariaLabel,
}: {
  values: string[]
  onChange: (v: string[]) => void
  people: Person[]
  addLabel: string
  ariaLabel: string
}) {
  const [text, setText] = useState('')
  const add = (v: string) => {
    const clean = v.trim()
    if (clean !== '' && !values.includes(clean)) onChange([...values, clean])
    setText('')
  }
  return (
    <div className="lore-chips">
      {values.map((v) => (
        <span key={v} className="lore-chip">
          {v}
          <button type="button" aria-label={`${v} ✕`} onClick={() => onChange(values.filter((x) => x !== v))}>
            ✕
          </button>
        </span>
      ))}
      <div className="lore-chip-add">
        <PersonPicker
          value={text}
          onChange={setText}
          onPick={(p) => add(p.value)}
          people={people.filter((p) => !values.includes(p.value))}
          placeholder={addLabel}
          ariaLabel={ariaLabel}
        />
        <button type="button" className="btn small" disabled={text.trim() === ''} onClick={() => add(text)}>
          {addLabel}
        </button>
      </div>
    </div>
  )
}

/** Colour swatches: pick with the system colour picker or type a hex code. */
export function ColorList({ values, onChange, addLabel }: { values: string[]; onChange: (v: string[]) => void; addLabel: string }) {
  const set = (i: number, v: string) => onChange(values.map((x, j) => (j === i ? v : x)))
  return (
    <div className="lore-colors">
      {values.map((c, i) => (
        <span key={i} className="lore-color">
          <input type="color" value={/^#[0-9a-f]{6}$/i.test(c) ? c : '#000000'} aria-label={c} onChange={(e) => set(i, e.target.value)} />
          <input
            type="text"
            className={`compact mono${/^#[0-9a-f]{6}$/i.test(c) ? '' : ' invalid'}`}
            value={c}
            maxLength={7}
            aria-label={c}
            onChange={(e) => set(i, e.target.value.trim())}
          />
          <button type="button" className="btn ghost small icon danger" aria-label={`${c} ✕`} onClick={() => onChange(values.filter((_, j) => j !== i))}>
            ✕
          </button>
        </span>
      ))}
      <button type="button" className="btn small" onClick={() => onChange([...values, '#888888'])}>
        + {addLabel}
      </button>
    </div>
  )
}

/** A labelled block in an editor tab. */
export function Block({ title, help, children, aside }: { title: ReactNode; help?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="lore-block">
      <div className="lore-block-head">
        <div>
          <h3>{title}</h3>
          {help ? <p className="help">{help}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  )
}
