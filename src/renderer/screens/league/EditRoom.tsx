import { useState } from 'react'
import { Link } from 'react-router'
import type { ExportScope } from '@shared/api'
import { call } from '../../api'
import { Check, ErrorBox, Field, Notice, Segmented, TextInput } from '../../components/ui'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { CommunitySettings } from './CommunitySettings'
import { LoreSuggestSettings } from './LoreSuggestSettings'
import { GmSettings } from './GmSettings'
import { AiSettings } from './AiSettings'
import { WikiSettings } from './WikiSettings'
import { Backups } from './Backups'

export function EditRoom() {
  const { league } = useLeague()
  const [name, setName] = useState(league.config.league.name)
  const [includePlayers, setIncludePlayers] = useState(false)
  const [result, setResult] = useState<{ path: string } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [folderError, setFolderError] = useState<unknown>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<unknown>(null)
  const [saving, setSaving] = useState(false)
  // Every season, or just the current one (the choice only shows once there's a past season).
  const [scope, setScope] = useState<ExportScope>('current')
  const manySeasons = league.seasons.length > 1

  const save = async (kind: 'excel' | 'backup') => {
    if (saving) return
    setSaving(true)
    setSaved(null)
    setSaveError(null)
    try {
      const r =
        kind === 'excel'
          ? await call('leagues.exportExcel', league.slug, t.exports.labels, manySeasons ? scope : 'current')
          : await call('leagues.backup', league.slug)
      setSaved(r.path)
    } catch (e) {
      setSaveError(e)
    } finally {
      setSaving(false)
    }
  }

  const openFolder = () => {
    setFolderError(null)
    call('app.openDataFolder', league.slug).catch((e: unknown) => setFolderError(e))
  }

  const exportTemplate = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      setResult(await call('leagues.exportTemplate', league.slug, { name: name.trim() || league.slug, includePlayers }))
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t.editroom.title}</h1>
          <p className="sub">{t.editroom.intro}</p>
        </div>
        <button className="btn" onClick={openFolder}>
          {t.editroom.openFolder}
        </button>
      </div>
      {folderError ? <ErrorBox error={folderError} /> : null}

      <div className="card">
        <div className="card-head">
          <h2>{t.leagueSettings.editRoomTitle}</h2>
          <Link className="btn primary" to={`/l/${encodeURIComponent(league.slug)}/settings`}>
            {t.leagueSettings.open}
          </Link>
        </div>
        <p className="help">{t.leagueSettings.editRoomHelp}</p>
      </div>

      <div className="card">
        <h2>{t.exports.title}</h2>
        <p className="help">{t.exports.help}</p>
        <div className="row">
          {manySeasons ? (
            <Segmented
              ariaLabel={t.exports.scope}
              value={scope}
              options={(['current', 'all'] as const).map((x) => ({ value: x, label: t.exports.scopes[x] }))}
              onChange={setScope}
            />
          ) : null}
          <button className="btn primary" disabled={saving} onClick={() => void save('excel')}>
            {t.exports.excel}
          </button>
          <button className="btn" disabled={saving} onClick={() => void save('backup')}>
            {t.exports.backup}
          </button>
        </div>
        {manySeasons && scope === 'all' ? <p className="help">{t.exports.allHelp}</p> : null}
        {saved ? <Notice tone="ok">{t.exports.saved(saved)}</Notice> : null}
        {saveError ? <ErrorBox error={saveError} /> : null}
      </div>

      {/* Looks again after 지금 백업 (a new path saved). */}
      <Backups refresh={saved} />

      <div className="card">
        <h2>{t.editroom.exportTitle}</h2>
        <p className="help">{t.editroom.exportHelp}</p>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label={t.editroom.templateName}>
            {(id) => <TextInput id={id} value={name} onChange={setName} width={280} />}
          </Field>
          <Check checked={includePlayers} onChange={setIncludePlayers}>
            {t.editroom.includePlayers}
          </Check>
          <button className="btn primary" disabled={busy} onClick={() => void exportTemplate()}>
            {t.editroom.export}
          </button>
        </div>
        {result ? <Notice tone="ok">{t.editroom.exported(result.path)}</Notice> : null}
        {error ? <ErrorBox error={error} /> : null}
      </div>

      <CommunitySettings />

      <LoreSuggestSettings />

      <WikiSettings />

      <GmSettings />

      <AiSettings />

      <div className="card">
        <div className="card-head">
          <h2>{t.editroom.config}</h2>
          <span className="muted">{t.editroom.configVersion(league.configVersion)}</span>
        </div>
        <pre className="json">{JSON.stringify(league.config, null, 2)}</pre>
      </div>
    </div>
  )
}
