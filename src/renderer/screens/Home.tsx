import { useState } from 'react'
import { Link } from 'react-router'
import { call } from '../api'
import { Badge, ErrorBox, Loading } from '../components/ui'
import { useLoad } from '../hooks'
import { t } from '../i18n'
import { knownErrorCode } from '@shared/dbErrors'

/** Why a league file couldn't be read: in Korean when it's a known database problem (from a newer app, damaged…), else as it came. */
function listingError(message: string): string {
  const code = knownErrorCode(message)
  return code ? t.errors.codes[code] : message
}

export function Home() {
  const leagues = useLoad(() => call('leagues.list'), [])
  const info = useLoad(() => call('app.info'), [])
  const [error, setError] = useState<unknown>(null)

  const openFolder = () => {
    setError(null)
    call('app.openDataFolder').catch((e: unknown) => setError(e))
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
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
