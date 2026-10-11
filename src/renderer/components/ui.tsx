import { useId, useState, type ReactNode } from 'react'
import { splitMarked } from '@shared/numbers'
import { ApiError } from '../api'
import { t } from '../i18n'

/**
 * A labelled form row. Pass a function as children for a single input: it gets the id
 * to put on the input so the label points at it. Anything else is a labelled group,
 * so clicking the label text never reaches a button or checkbox inside.
 */
export function Field({
  label,
  help,
  children,
}: {
  label: ReactNode
  help?: ReactNode
  children: ReactNode | ((id: string) => ReactNode)
}) {
  const id = useId()
  const helpEl = help ? (
    <span className="help" id={`${id}-help`}>
      {help}
    </span>
  ) : null
  if (typeof children === 'function') {
    return (
      <div className="field">
        <label className="label" htmlFor={id}>
          {label}
        </label>
        {children(id)}
        {helpEl}
      </div>
    )
  }
  return (
    <div
      className="field"
      role="group"
      aria-labelledby={label ? `${id}-label` : undefined}
      aria-describedby={help ? `${id}-help` : undefined}
    >
      <span className="label" id={`${id}-label`}>
        {label}
      </span>
      {children}
      {helpEl}
    </div>
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  invalid,
  compact,
  width,
  id,
  ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  invalid?: boolean
  compact?: boolean
  width?: number
  id?: string
  ariaLabel?: string
}) {
  return (
    <input
      type="text"
      id={id}
      aria-label={ariaLabel}
      className={[invalid ? 'invalid' : '', compact ? 'compact' : ''].join(' ')}
      value={value}
      placeholder={placeholder}
      style={width ? { width } : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

interface NumberProps {
  min?: number
  max?: number
  step?: number
  compact?: boolean
  id?: string
  ariaLabel?: string
  disabled?: boolean
  /** Only report the value on blur or Enter, not while typing. */
  lazy?: boolean
}

const formatNumber = (v: number | null) => (v === null ? '' : String(v))

function parseNumber(raw: string): number | null {
  if (raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * A number box. It keeps its own text, so it can be emptied or hold "-" while typing.
 * In-range numbers are reported as you type; blur or Enter clamps to min/max, or puts
 * the last value back. With `nullable`, an empty box gives null (an optional limit).
 */
export function NumberInput(props: NumberProps & { value: number; onChange: (v: number) => void; nullable?: false }): ReactNode
export function NumberInput(
  props: NumberProps & { value: number | null; onChange: (v: number | null) => void; nullable: true },
): ReactNode
export function NumberInput({
  value,
  onChange,
  nullable,
  min,
  max,
  step,
  compact,
  id,
  ariaLabel,
  disabled,
  lazy,
}: NumberProps & {
  value: number | null
  onChange: ((v: number) => void) | ((v: number | null) => void)
  nullable?: boolean
}) {
  const [text, setText] = useState(() => formatNumber(value))
  const [shown, setShown] = useState(value)
  // A new value from outside replaces the text, unless the text already means it ("1." for 1).
  if (!Object.is(shown, value)) {
    setShown(value)
    if (parseNumber(text) !== value) setText(formatNumber(value))
  }

  const emit = (v: number | null) => {
    if (v !== value) (onChange as (v: number | null) => void)(v)
  }
  const inRange = (n: number) => (min === undefined || n >= min) && (max === undefined || n <= max)
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))

  const commit = (input: HTMLInputElement) => {
    // Disabling a focused box blurs it; that's not the user finishing an entry.
    if (input.disabled) return
    // The browser reports a partial entry like "-" as '' with `badInput` set.
    const partial = input.validity.badInput
    const n = parseNumber(input.value)
    if (n !== null) {
      const c = clamp(n)
      setText(formatNumber(c))
      emit(c)
    } else if (nullable && !partial) {
      setText('')
      emit(null)
    } else {
      // Put the last good value back; the DOM still shows a partial entry, so set it too.
      if (partial) input.value = formatNumber(value)
      setText(formatNumber(value))
    }
  }

  return (
    <input
      type="number"
      id={id}
      aria-label={ariaLabel}
      className={compact ? 'compact' : ''}
      value={text}
      min={min}
      max={max}
      step={step ?? 1}
      disabled={disabled}
      onChange={(e) => {
        const raw = e.target.value
        setText(raw)
        if (lazy) return
        const n = parseNumber(raw)
        if (n !== null) {
          if (inRange(n)) emit(n)
        } else if (nullable && !e.target.validity.badInput) emit(null)
      }}
      onBlur={(e) => commit(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(e.currentTarget)
      }}
    />
  )
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  compact,
  invalid,
  id,
  ariaLabel,
  disabled,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  compact?: boolean
  invalid?: boolean
  id?: string
  ariaLabel?: string
  disabled?: boolean
}) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      className={[compact ? 'compact' : '', invalid ? 'invalid' : ''].join(' ')}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  )
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  ariaLabel?: string
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'on' : ''}
          // Picking the current option again is not a change.
          onClick={() => {
            if (o.value !== value) onChange(o.value)
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Badge({ tone, children }: { tone?: 'ok' | 'warn' | 'err' | 'info' | 'accent'; children: ReactNode }) {
  return <span className={`badge ${tone ?? ''}`}>{children}</span>
}

export function Notice({ tone, children }: { tone: 'ok' | 'warn' | 'err' | 'info'; children: ReactNode }) {
  return <div className={`notice ${tone}`}>{children}</div>
}

/**
 * AI text with the numbers its writer's facts didn't hold marked (a dotted
 * underline, a hint on hover). Only you see the marks; writers never do.
 * Each mark can be reached with Tab, and screen readers hear the hint (a
 * hidden description, so the mark's own text stays just the number).
 */
export function Marked({ text, numbers }: { text: string; numbers: readonly string[] | undefined }) {
  const hint = useId()
  if (!numbers?.length) return <>{text}</>
  const parts = splitMarked(text, numbers)
  if (!parts.some((p) => p.marked)) return <>{text}</>
  return (
    <>
      {parts.map((part, i) =>
        part.marked ? (
          <span key={i} className="ai-number" title={t.app.aiNumber} tabIndex={0} aria-describedby={hint}>
            {part.text}
          </span>
        ) : (
          part.text
        ),
      )}
      <span id={hint} hidden>
        {t.app.aiNumber}
      </span>
    </>
  )
}

export function IssueList({ items }: { items: { level: 'error' | 'warning' | 'info'; text: string; action?: ReactNode }[] }) {
  if (items.length === 0) return null
  return (
    <ul className="issues">
      {items.map((item, i) => (
        <li key={i} className={item.level}>
          <span className="dot" />
          <span>{item.text}</span>
          {item.action}
        </li>
      ))}
    </ul>
  )
}

export function Loading() {
  return (
    <div className="row muted">
      <span className="spin" /> {t.app.loading}
    </div>
  )
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const base = t.errors.codes[error.code]
    if (error.shape.templateError) return `${base} ${t.errors.template(error.shape.templateError)}`
    return error.code === 'internal' || error.code === 'file-read' ? `${base} (${error.message})` : base
  }
  return error instanceof Error ? error.message : String(error)
}

/** Errors shown in Korean whose original text still helps (a bug report, a search): kept under 자세히. */
const DETAILED = new Set<string>(['db-too-new', 'db-constraint', 'db-busy', 'disk-full', 'db-corrupt'])

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Notice tone="err">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>
          <b>{t.errors.title}</b> · {errorText(error)}
        </span>
        {onRetry ? (
          <button className="btn small" onClick={onRetry}>
            {t.app.retry}
          </button>
        ) : null}
      </div>
      {error instanceof ApiError && DETAILED.has(error.code) && error.message ? (
        <details className="error-details">
          <summary>{t.errors.details}</summary>
          <pre className="raw-error">{error.message}</pre>
        </details>
      ) : null}
    </Notice>
  )
}

/** Colour for a grade by its position in the scale (0 = best). */
export function gradeColors(index: number, total: number): { background: string; color: string } {
  const r = total <= 1 ? 0 : index / (total - 1)
  const hue = 140 - r * 140
  return { background: `hsl(${hue} 70% ${92 - (1 - r) * 6}%)`, color: `hsl(${hue} 70% 26%)` }
}

export function GradeBadge({ grade, scale }: { grade: string | null; scale: string[] }) {
  if (grade === null) return <span className="muted">–</span>
  const i = scale.indexOf(grade)
  return (
    <span className="grade" style={i < 0 ? undefined : gradeColors(i, scale.length)}>
      {grade}
    </span>
  )
}

export function OvrBadge({ value, min, max }: { value: number | null; min: number; max: number }) {
  if (value === null) return <span className="muted">–</span>
  const r = max === min ? 1 : Math.min(1, Math.max(0, (value - min) / (max - min)))
  const hue = 10 + r * 130
  return (
    <span className="ovr" style={{ background: `hsl(${hue} 60% ${46 - r * 8}%)` }}>
      {Number.isInteger(value) ? value : value.toFixed(1)}
    </span>
  )
}

/** Up / down / delete buttons for a row in an ordered list. */
export function RowControls({
  index,
  count,
  onMove,
  onRemove,
}: {
  index: number
  count: number
  onMove: (from: number, to: number) => void
  onRemove?: () => void
}) {
  return (
    <span className="row" style={{ gap: 2, flexWrap: 'nowrap' }}>
      <button type="button" className="btn ghost small icon" title={t.app.up} disabled={index === 0} onClick={() => onMove(index, index - 1)}>
        ↑
      </button>
      <button
        type="button"
        className="btn ghost small icon"
        title={t.app.down}
        disabled={index === count - 1}
        onClick={() => onMove(index, index + 1)}
      >
        ↓
      </button>
      {onRemove ? (
        <button type="button" className="btn ghost small icon danger" title={t.app.remove} onClick={onRemove}>
          ✕
        </button>
      ) : null}
    </span>
  )
}

export function move<T>(list: T[], from: number, to: number): void {
  if (to < 0 || to >= list.length) return
  const [item] = list.splice(from, 1)
  list.splice(to, 0, item!)
}
