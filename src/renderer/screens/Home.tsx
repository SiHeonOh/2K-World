import { useState } from 'react'
import { Link } from 'react-router'
import { call } from '../api'
import { Badge, ErrorBox, Loading } from '../components/ui'
import { useLoad } from '../hooks'
import { t } from '../i18n'
import { knownErrorCode } from '@shared/dbErrors'
import type { LeagueListing } from '@shared/league'

/** Why a league file couldn't be read: in Korean when it's a known database problem (from a newer app, damaged…), else as it came. */
function listingError(message: string): string {
  const code = knownErrorCode(message)
  return code ? t.errors.codes[code] : message
}

export function Home() {
  const leagues = useLoad(() => call('leagues.list'), [])
  const info = useLoad(() => call('app.info'), [])
  const [error, setError] = useState<unknown>(null)
  // The league whose 삭제 is open (one at a time), and the note after one was moved away.
  const [removing, setRemoving] = useState<string | null>(null)
  const [removed, setRemoved] = useState<string | null>(null)

  const openFolder = () => {
    setError(null)
    call('app.openDataFolder').catch((e: unknown) => setError(e))
  }

  const openDeleted = () => {
    setError(null)
    call('leagues.openDeleted').catch((e: unknown) => setError(e))
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t.home.title}</h1>
          {info.state === 'ready' ? (
            <p className="sub">
              {t.home.dataFolder}: <code>{info.value.dataDir}</code>{' '}
              <button className="btn ghost small" onClick={openFolder}>
                {t.home.openFolder}
              </button>
            </p>
          ) : null}
        </div>
        <Link to="/setup" className="btn primary">
          {t.home.create}
        </Link>
      </div>

      {removed ? (
        <div className="notice ok row" style={{ justifyContent: 'space-between' }}>
          <span>{removed}</span>
          <button className="btn ghost small" onClick={openDeleted}>
            {t.home.openDeleted}
          </button>
        </div>
      ) : null}
      {error ? <ErrorBox error={error} /> : null}
      {leagues.state === 'loading' ? <Loading /> : null}
      {leagues.state === 'error' ? <ErrorBox error={leagues.error} onRetry={leagues.reload} /> : null}
      {leagues.state === 'ready' && leagues.value.length === 0 ? (
        <div className="card">
          <p className="help">{t.home.empty}</p>
        </div>
      ) : null}
      {leagues.state === 'ready' && leagues.value.length > 0 ? (
        <div className="grid-cards">
          {leagues.value.map((l) => (
            <div key={l.slug} className="card">
              <div className="stack" style={{ gap: 4 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <h2>{l.name ?? l.slug}</h2>
                  {l.error ? <Badge tone="err">{t.home.broken}</Badge> : null}
                  {!l.hasDb ? <Badge tone="info">{t.home.loreOnly}</Badge> : null}
                </div>
                <span className="muted">
                  <code>{l.slug}</code>
                  {l.hasDb ? ` · ${l.season ?? ''} · ${t.home.teamsPlayers(l.teams, l.players)}` : ''}
                </span>
                {l.error ? <span className="help">{listingError(l.error)}</span> : null}
              </div>
              {removing === l.slug ? (
                <RemoveLeague
                  league={l}
                  onCancel={() => setRemoving(null)}
                  onRemoved={(movedTo) => {
                    setRemoving(null)
                    setRemoved(t.home.removed(l.name ?? l.slug, movedTo))
                    leagues.reload()
                  }}
                />
              ) : (
                <div className="row">
                  {l.hasDb && !l.error ? (
                    <Link className="btn primary small" to={`/l/${encodeURIComponent(l.slug)}`}>
                      {t.home.open}
                    </Link>
                  ) : null}
                  {!l.hasDb ? (
                    <Link className="btn small" to={`/setup?slug=${encodeURIComponent(l.slug)}`}>
                      {t.home.setUp}
                    </Link>
                  ) : null}
                  <button
                    className="btn ghost small"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => {
                      setRemoved(null)
                      setRemoving(l.slug)
                    }}
                  >
                    {t.home.remove}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** 삭제's confirm: typing the folder name, so a league isn't moved away by a stray click. */
function RemoveLeague({ league, onCancel, onRemoved }: { league: LeagueListing; onCancel: () => void; onRemoved: (movedTo: string) => void }) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const matches = typed.trim().normalize('NFC') === league.slug.normalize('NFC')

  const remove = async () => {
    if (!matches || busy) return
    setBusy(true)
    setError(null)
    try {
      const { movedTo } = await call('leagues.remove', league.slug)
      onRemoved(movedTo)
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  return (
    <div className="stack remove-league" style={{ gap: 8 }}>
      <strong>{t.home.removeTitle(league.name ?? league.slug)}</strong>
      <p className="help">{t.home.removeHelp}</p>
      <label className="stack" style={{ gap: 4 }}>
        <span className="help">{t.home.removeType(league.slug)}</span>
        <input
          value={typed}
          autoFocus
          aria-label={t.home.removeType(league.slug)}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void remove()
            if (e.key === 'Escape') onCancel()
          }}
        />
      </label>
      {error ? <ErrorBox error={error} /> : null}
      <div className="row">
        <button className="btn danger small" disabled={!matches || busy} onClick={() => void remove()}>
          {busy ? t.home.removing : t.home.removeConfirm}
        </button>
        <button className="btn ghost small" disabled={busy} onClick={onCancel}>
          {t.home.cancel}
        </button>
      </div>
    </div>
  )
}
