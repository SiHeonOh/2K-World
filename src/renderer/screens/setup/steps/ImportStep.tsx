import { useRef, useState } from 'react'
import type { ImportBaseInput } from '@shared/api'
import type { FieldTarget, ImportIssue, ImportMapping, SourceColumn } from '@shared/import'
import { call, openDroppedFile } from '../../../api'
import { ErrorBox, IssueList, Notice, NumberInput, Select } from '../../../components/ui'
import { t } from '../../../i18n'
import { importIsStale, type StepProps, type WizardState } from '../state'

type TargetKey = Exclude<FieldTarget['kind'], 'rating'> | 'rating-number' | 'rating-grade'

const TARGET_KEYS: TargetKey[] = [
  'ignore',
  'team',
  'division',
  'conference',
  'name',
  'slot',
  'height',
  'nicknames',
  'notes',
  'rating-number',
  'rating-grade',
]

const targetLabel = (k: TargetKey) =>
  k === 'rating-number' ? t.wizard.import.ratingNumber : k === 'rating-grade' ? t.wizard.import.ratingGrade : t.wizard.import.targets[k]

const keyOf = (target: FieldTarget): TargetKey =>
  target.kind === 'rating' ? (target.ratingKind === 'number' ? 'rating-number' : 'rating-grade') : target.kind

/** A rating column id from a header, unique within the mapping. */
function ratingId(header: string, letter: string, mapping: ImportMapping, index: number): string {
  const base =
    header
      .normalize('NFC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || `col-${letter.toLowerCase()}`
  const taken = new Set(
    mapping.columns.flatMap((c) => (c.target.kind === 'rating' && c.index !== index ? [c.target.columnId] : [])),
  )
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}

const base = (state: WizardState): ImportBaseInput => ({
  config: state.setup.config,
  ...(state.baseTeams ? { teams: state.baseTeams } : {}),
})

export function ImportStep({ state, edit }: StepProps) {
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  // Numbers each analyze request, so a slow reply can't overwrite a newer one.
  const request = useRef(0)
  const { workbook, analysis, mapping, imported } = state
  const stale = importIsStale(state)

  const analyze = async (path: string, sheet: string, headerRow?: number) => {
    const id = ++request.current
    try {
      const result = await call('import.analyze', {
        path,
        sheet,
        ...(headerRow ? { headerRow } : {}),
        base: base(state),
        ...(state.templateMapping ? { templateMapping: state.templateMapping } : {}),
      })
      if (id !== request.current) return
      edit((s) => {
        s.analysis = result
        s.mapping = result.suggested
      })
    } catch (e) {
      if (id === request.current) throw e
    }
  }

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const openWorkbook = (summary: NonNullable<WizardState['workbook']>) =>
    guard(async () => {
      edit((s) => {
        s.workbook = summary
        s.analysis = null
        s.mapping = null
      })
      // Pick the sheet with the most rows; it's almost always the roster.
      const sheet = [...summary.sheets].sort((a, b) => b.rows - a.rows)[0]
      if (sheet) await analyze(summary.path, sheet.name)
    })

  const choose = () =>
    guard(async () => {
      const summary = await call('import.chooseFile', { title: t.wizard.import.chooseTitle, filterName: t.wizard.import.filter })
      if (summary) await openWorkbook(summary)
    })

  const drop = (file: File | undefined) => {
    if (!file || busy) return
    void guard(async () => {
      const summary = await openDroppedFile(file)
      await openWorkbook(summary)
    })
  }

  const run = () =>
    guard(async () => {
      if (!workbook || !mapping) return
      const result = await call('import.run', { path: workbook.path, mapping, base: base(state) })
      edit((s) => {
        s.setup = result.setup
        s.imported = { path: workbook.path, summary: result.summary, issues: result.issues }
        s.importedMapping = mapping
      })
    })

  const setTarget = (col: SourceColumn, key: TargetKey) =>
    edit((s) => {
      if (!s.mapping) return
      const entry = s.mapping.columns.find((c) => c.index === col.index)
      if (!entry) return
      if (key === 'rating-number' || key === 'rating-grade') {
        const existing = entry.target.kind === 'rating' ? entry.target.columnId : null
        entry.target = {
          kind: 'rating',
          columnId: existing ?? ratingId(col.header, col.letter, s.mapping, col.index),
          ratingKind: key === 'rating-number' ? 'number' : 'grade',
        }
      } else {
        // Single fields can only come from one column: the newest choice wins.
        if (key !== 'ignore') {
          for (const other of s.mapping.columns) if (other.target.kind === key) other.target = { kind: 'ignore' }
        }
        entry.target = { kind: key } as FieldTarget
      }
    })

  const hasRequired = mapping?.columns.some((c) => c.target.kind === 'team') && mapping.columns.some((c) => c.target.kind === 'name')
  const templatePlayers = state.source.kind === 'template' && state.setup.players.length > 0 && !imported

  return (
    <>
      <div className="card">
        <h2>{t.wizard.steps.import}</h2>
        <p className="help">{t.wizard.import.intro}</p>
        {templatePlayers ? <Notice tone="info">{t.wizard.import.skip}</Notice> : null}
        <div
          className={`dropzone ${over ? 'over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            drop(e.dataTransfer.files[0])
          }}
        >
          <div className="stack" style={{ alignItems: 'center' }}>
            <button className="btn primary" disabled={busy} onClick={() => void choose()}>
              {t.wizard.import.choose}
            </button>
            <span>{workbook ? <code>{workbook.fileName}</code> : t.wizard.import.drop}</span>
          </div>
        </div>
        {error ? <ErrorBox error={error} /> : null}

        {workbook && analysis ? (
          <div className="row">
            <label className="row" style={{ gap: 6 }}>
              <span className="label">{t.wizard.import.sheet}</span>
              <Select
                value={analysis.sheet}
                disabled={busy}
                options={workbook.sheets.map((s) => ({ value: s.name, label: `${s.name} (${t.wizard.import.rows(s.rows)})` }))}
                onChange={(sheet) => void guard(() => analyze(workbook.path, sheet))}
              />
            </label>
            <label className="row" style={{ gap: 6 }}>
              <span className="label">{t.wizard.import.headerRow}</span>
              {/* Lazy: one analyze when the row is typed in full, not one per keystroke. */}
              <NumberInput
                lazy
                value={analysis.headerRow}
                min={1}
                disabled={busy}
                onChange={(row) => void guard(() => analyze(workbook.path, analysis.sheet, row))}
              />
            </label>
            {analysis.fromSaved ? <span className="badge info">{t.wizard.import.fromSaved}</span> : null}
          </div>
        ) : null}
      </div>

      {analysis && mapping ? (
        <div className="card flush">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t.wizard.import.column}</th>
                  <th>{t.wizard.import.header}</th>
                  <th>{t.wizard.import.samples}</th>
                  <th>{t.wizard.import.target}</th>
                  <th>{t.wizard.import.ratingId}</th>
                </tr>
              </thead>
              <tbody>
                {analysis.columns.map((col) => {
                  const entry = mapping.columns.find((c) => c.index === col.index)
                  const target = entry?.target ?? { kind: 'ignore' as const }
                  return (
                    <tr key={col.index} style={target.kind === 'ignore' ? { opacity: 0.6 } : undefined}>
                      <td className="muted">{col.letter}</td>
                      <td>
                        <b>{col.header || '–'}</b>
                        <div className="muted" style={{ fontSize: 11 }}>
                          {t.wizard.import.inferred[col.inferred]} · {col.filled}
                        </div>
                      </td>
                      <td className="wrap muted" style={{ maxWidth: 320 }}>
                        {col.samples.join(' · ')}
                      </td>
                      <td>
                        <Select
                          compact
                          ariaLabel={t.app.cellLabel(`${col.letter} ${col.header}`.trim(), t.wizard.import.target)}
                          value={keyOf(target)}
                          options={TARGET_KEYS.map((k) => ({ value: k, label: targetLabel(k) }))}
                          onChange={(k) => setTarget(col, k)}
                        />
                      </td>
                      <td>{target.kind === 'rating' ? <code>{target.columnId}</code> : null}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {analysis && mapping ? (
        <div className="card">
          {!hasRequired ? <Notice tone="warn">{t.wizard.import.required}</Notice> : null}
          {stale ? (
            <Notice tone="warn">
              <b>{t.wizard.import.staleTitle}</b> · {t.wizard.import.stale}
            </Notice>
          ) : null}
          {imported ? <p className="help">{t.wizard.import.rerunWarning}</p> : null}
          <div className="row">
            <button className="btn primary" disabled={busy || !hasRequired} onClick={() => void run()}>
              {imported ? t.wizard.import.rerun : t.wizard.import.run}
            </button>
            {imported ? (
              <span className={`badge ${stale ? 'warn' : 'ok'}`}>
                {t.wizard.import.done} · {t.wizard.import.summary(imported.summary)}
              </span>
            ) : null}
          </div>
          {imported ? <ImportIssues issues={imported.issues} /> : null}
        </div>
      ) : null}
    </>
  )
}

function ImportIssues({ issues }: { issues: ImportIssue[] }) {
  return (
    <IssueList
      items={issues.map((i) => ({
        level: i.level,
        text: t.wizard.import.issues[i.code](i.params, i.rows),
      }))}
    />
  )
}
