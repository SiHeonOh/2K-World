import { useEffect, useState } from 'react'
import { backupKind, type BackupView, type LoreSnapshotView } from '@shared/backups'
import { call } from '../../api'
import { Badge, ErrorBox, Loading, Notice, Segmented } from '../../components/ui'
import { useLoad } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { RuleErrors } from './RuleErrors'
import { formatDate } from './util'

const tb = t.backups

/** Shown once after the window reloads from a restore (sessionStorage survives the reload). */
const FLASH_KEY = 'twok:restore-note'

const formatBytes = (n: number): string =>
  n < 1024 ? `${n}B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)}KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)}MB` : `${(n / 1024 ** 3).toFixed(2)}GB`

const reasonLabel = (reason: string): string => tb.reasons[backupKind(reason)] ?? reason

/** Read without clearing (StrictMode runs initializers twice); cleared once the screen is up. */
function readFlash(slug: string): string | null {
  try {
    const raw = sessionStorage.getItem(FLASH_KEY)
    if (raw === null) return null
    const note = JSON.parse(raw) as { slug?: string; text?: string }
    return note.slug === slug && typeof note.text === 'string' ? note.text : null
  } catch {
    return null
  }
}

function clearFlash(): void {
  try {
    sessionStorage.removeItem(FLASH_KEY)
  } catch {
    // No storage: nothing to clear.
  }
}

/**
 * 편집실 → 백업과 복원: the league's database backups and lore snapshots,
 * each with 복원. `refresh` changes when a backup was just made elsewhere on
 * the screen (지금 백업), so the list looks again.
 */
export function Backups({ refresh }: { refresh?: unknown }) {
  const { league } = useLeague()
  const slug = league.slug
  const list = useLoad(() => call('backups.list', slug), [slug, refresh], { keepPrevious: true })
  const [tab, setTab] = useState<'db' | 'lore'>('db')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(() => readFlash(slug))
  const [error, setError] = useState<unknown>(null)
  useEffect(clearFlash, [])

  const restore = async (b: BackupView) => {
    if (busy || !window.confirm(tb.confirmRestore(formatDate(b.at, true), reasonLabel(b.reason)))) return
    setBusy(true)
    setNote(null)
    setError(null)
    try {
      const r = await call('backups.restore', slug, b.id)
      const text = [tb.restored(r.safety), r.upgraded ? tb.upgraded : '', r.schools.length > 0 ? tb.schoolsMoved(r.schools) : ''].filter(Boolean).join(' ')
      try {
        sessionStorage.setItem(FLASH_KEY, JSON.stringify({ slug, text }))
      } catch {
        // No storage: the reload just won't say so.
      }
      // Every screen starts over from the restored league (settings forms keep their own copies otherwise).
      window.location.reload()
    } catch (e) {
      setError(e)
      setBusy(false)
      list.reload()
    }
  }

  const restoreLore = async (s: LoreSnapshotView) => {
    if (busy || !window.confirm(tb.confirmRestoreLore(formatDate(s.at, true), reasonLabel(s.reason)))) return
    setBusy(true)
    setNote(null)
    setError(null)
    try {
      const r = await call('backups.restoreLore', slug, s.id)
      setNote([tb.loreRestored(r.moved), r.schools.length > 0 ? tb.schoolsMoved(r.schools) : '', r.kept ? tb.loreKept(r.kept) : ''].filter(Boolean).join(' '))
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
      list.reload()
    }
  }

  const openLore = (s: LoreSnapshotView) => {
    setError(null)
    call('backups.openLore', slug, s.id).catch((e: unknown) => setError(e))
  }

  const keep = (n: number | null) => (n === null ? tb.keepAll : tb.keepN(n))

  return (
    <div className="card backups">
      <div className="card-head">
        <h2>{tb.title}</h2>
        <button className="btn small ghost" disabled={busy || list.state === 'loading' || list.refreshing} onClick={list.reload}>
          {tb.reload}
        </button>
      </div>
      <p className="help">{tb.help}</p>
      <details className="help">
        <summary>{tb.policyTitle}</summary>
        <ul>
          {tb.policy.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
      {note ? <Notice tone="ok">{note}</Notice> : null}
      {error ? <RuleErrors error={error} /> : null}
      {busy ? <Notice tone="info">{tb.restoring}</Notice> : null}
      <div className="row">
        <Segmented
          ariaLabel={tb.tabsLabel}
          value={tab}
          options={(['db', 'lore'] as const).map((x) => ({ value: x, label: tb.tabs[x] }))}
          onChange={setTab}
        />
        {list.state === 'ready' ? (
          <span className="muted">
            {tab === 'db'
              ? tb.total(list.value.db.length, formatBytes(list.value.db.reduce((n, b) => n + b.bytes, 0)))
              : tb.total(list.value.lore.length, formatBytes(list.value.lore.reduce((n, s) => n + s.bytes, 0)))}
          </span>
        ) : null}
      </div>
      {list.state === 'loading' ? (
        <Loading />
      ) : list.state === 'error' ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : tab === 'db' ? (
        list.value.db.length === 0 ? (
          <p className="muted">{tb.empty}</p>
        ) : (
          <div className="table-wrap">
            <table className="data compact">
              <thead>
                <tr>
                  <th>{tb.when}</th>
                  <th>{tb.reason}</th>
                  <th>{tb.season}</th>
                  <th className="num">{tb.size}</th>
                  <th>{tb.keep}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.value.db.map((b) => (
                  <tr key={b.id}>
                    <td>{formatDate(b.at, true)}</td>
                    <td>
                      {reasonLabel(b.reason)}
                      {b.version !== null && b.restorable && b.version < list.value.schema ? (
                        <>
                          {' '}
                          <Badge tone="info">{tb.older(b.version)}</Badge>
                        </>
                      ) : null}
                      {!b.restorable ? (
                        <>
                          {' '}
                          <Badge tone="err">{tb.unreadable}</Badge>
                        </>
                      ) : null}
                    </td>
                    <td>{b.season ?? '—'}</td>
                    <td className="num">{formatBytes(b.bytes)}</td>
                    <td className="muted">{keep(b.keep)}</td>
                    <td>
                      <button className="btn small" disabled={busy || !b.restorable} onClick={() => void restore(b)}>
                        {tb.restore}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : !list.value.hasLore && list.value.lore.length === 0 ? (
        <p className="muted">{tb.noLore}</p>
      ) : list.value.lore.length === 0 ? (
        <p className="muted">{tb.loreEmpty}</p>
      ) : (
        <div className="table-wrap">
          <table className="data compact">
            <thead>
              <tr>
                <th>{tb.when}</th>
                <th>{tb.reason}</th>
                <th className="num">{tb.files}</th>
                <th className="num">{tb.size}</th>
                <th>{tb.keep}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.value.lore.map((s) => (
                <tr key={s.id}>
                  <td>{formatDate(s.at, true)}</td>
                  <td>{reasonLabel(s.reason)}</td>
                  <td className="num">{s.files}</td>
                  <td className="num">{formatBytes(s.bytes)}</td>
                  <td className="muted">{keep(s.keep)}</td>
                  <td>
                    <div className="row">
                      <button className="btn small ghost" onClick={() => openLore(s)}>
                        {tb.openFolder}
                      </button>
                      <button className="btn small" disabled={busy} onClick={() => void restoreLore(s)}>
                        {tb.restore}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
