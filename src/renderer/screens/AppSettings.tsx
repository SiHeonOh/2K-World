import { useEffect, useState } from 'react'
import type { AiStatus } from '@shared/ai'
import { call } from '../api'
import { AiStatusCard } from '../components/AiStatusCard'
import { ErrorBox, Field, Loading } from '../components/ui'
import { useLoad } from '../hooks'
import { t } from '../i18n'

export function AppSettings() {
  const info = useLoad(() => call('app.info'), [])
  const [error, setError] = useState<unknown>(null)
  const [ai, setAi] = useState<AiStatus | null>(null)
  useEffect(() => {
    let alive = true
    void call('ai.status').then((s) => alive && setAi(s))
    return () => {
      alive = false
    }
  }, [])

  const change = async () => {
    setError(null)
    try {
      const next = await call('app.chooseDataFolder', { title: t.appSettings.chooseTitle, filterName: '' })
      if (next) info.reload()
    } catch (e) {
      setError(e)
    }
  }

  const openFolder = () => {
    setError(null)
    call('app.openDataFolder').catch((e: unknown) => setError(e))
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t.appSettings.title}</h1>
      </div>
      {ai ? <AiStatusCard status={ai} onChange={setAi} /> : null}
      {info.state === 'loading' ? <Loading /> : null}
      {info.state === 'error' ? <ErrorBox error={info.error} onRetry={info.reload} /> : null}
      {error ? <ErrorBox error={error} /> : null}
      {info.state === 'ready' ? (
        <div className="card">
          <Field label={t.appSettings.dataFolder} help={t.appSettings.dataFolderHelp}>
            <div className="row">
              <code>{info.value.dataDir}</code>
              <button className="btn small" onClick={openFolder}>
                {t.home.openFolder}
              </button>
              <button className="btn small" onClick={() => void change()}>
                {t.appSettings.change}
              </button>
            </div>
          </Field>
          <ShotFolder />
          <Field label={t.appSettings.version}>
            <span>
              {info.value.version}
              {info.value.isPackaged ? '' : ` · ${t.appSettings.devMode}`}
            </span>
          </Field>
        </div>
      ) : null}
    </div>
  )
}

/** Where 2K's screenshots land; game day takes the newest from here. */
function ShotFolder() {
  const folder = useLoad(() => call('gameday.screenshotFolder'), [])
  const [error, setError] = useState<unknown>(null)
  const choose = async () => {
    setError(null)
    try {
      await call('gameday.chooseScreenshotFolder', { title: t.appSettings.shotFolderTitle, filterName: '' })
      folder.reload()
    } catch (e) {
      setError(e)
    }
  }
  const clear = async () => {
    setError(null)
    try {
      await call('gameday.clearScreenshotFolder')
      folder.reload()
    } catch (e) {
      setError(e)
    }
  }
  const value = folder.state === 'ready' ? folder.value.folder : null
  return (
    <Field label={t.appSettings.shotFolder} help={t.appSettings.shotFolderHelp}>
      <div className="row">
        <code>{value ?? t.appSettings.shotFolderNone}</code>
        <button className="btn small" onClick={() => void choose()}>
          {t.appSettings.shotFolderChoose}
        </button>
        {value ? (
          <button className="btn small ghost" onClick={() => void clear()}>
            {t.appSettings.shotFolderClear}
          </button>
        ) : null}
      </div>
      {error ? <ErrorBox error={error} /> : null}
    </Field>
  )
}
