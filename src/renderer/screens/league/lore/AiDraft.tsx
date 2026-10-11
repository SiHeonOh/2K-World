import { useState } from 'react'
import { Link } from 'react-router'
import type { SuggestionTarget } from '@shared/suggestions'
import type { LeagueSnapshot } from '@shared/league'
import { call } from '../../../api'
import { ErrorBox, Notice, Select } from '../../../components/ui'
import { useLoad } from '../../../hooks'
import { t } from '../../../i18n'
import { AutoTextarea } from './controls'

const ts = t.suggest
const inboxLink = (slug: string) => `/l/${encodeURIComponent(slug)}/inbox?tab=suggestions`
const sameTarget = (a: SuggestionTarget, b: SuggestionTarget) =>
  a.kind === b.kind && (a.kind === 'player' ? a.playerId === (b as { playerId: string }).playerId : a.teamId === (b as { teamId: string }).teamId)

/**
 * One file's AI draft: your own few sentences about the player (optional),
 * and the cards already waiting for it. The draft goes to 제안함; nothing in
 * the file changes until you approve it there.
 */
export function AiDraftBar({ slug, target }: { slug: string; target: SuggestionTarget }) {
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState(false)
  const [queued, setQueued] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const waiting = useLoad(async () => (await call('suggestions.list', slug, 'pending')).filter((s) => sameTarget(s.target, target)).length, [slug, queued])
  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      await call('suggestions.draft', slug, { scope: 'one', target, hint: hint.trim() || undefined })
      setQueued(true)
      setHint('')
      setOpen(false)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="lore-ai">
      <div className="row">
        <button type="button" className="btn small" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
          ✦ {ts.oneButton}
        </button>
        {waiting.state === 'ready' && waiting.value > 0 ? (
          <Link to={inboxLink(slug)} className="muted">
            {ts.waitingHere(waiting.value)} →
          </Link>
        ) : null}
        {queued ? (
          <span className="muted">
            {ts.oneQueued} <Link to={inboxLink(slug)}>{ts.goInbox}</Link>
          </span>
        ) : null}
      </div>
      {open ? (
        <div className="lore-ai-panel">
          <b>{ts.oneTitle}</b>
          <p className="help">{ts.oneHelp}</p>
          <AutoTextarea value={hint} onChange={setHint} placeholder={ts.onePlaceholder} minRows={3} ariaLabel={ts.oneTitle} />
          {error ? <ErrorBox error={error} /> : null}
          <div className="row">
            <button type="button" className="btn primary small" disabled={busy} onClick={() => void start()}>
              {ts.oneStart}
            </button>
            <button type="button" className="btn ghost small" onClick={() => setOpen(false)}>
              {ts.cancel}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** The overview's card: drafts for every blank part of one school's files, or every school's. */
export function AiDraftCard({ league }: { league: LeagueSnapshot }) {
  const [school, setSchool] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const start = async () => {
    if (school === '' && !window.confirm(ts.confirmAll(league.teams.length))) return
    setBusy(true)
    setNote(null)
    setError(null)
    try {
      const r = await call('suggestions.draft', league.slug, school ? { scope: 'team', teamId: school } : { scope: 'league' })
      setNote(ts.draftQueued(r.jobs, r.targets))
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="card">
      <div className="card-head">
        <h3>✦ {ts.draftTitle}</h3>
      </div>
      <p className="help">{ts.draftHelp}</p>
      <div className="row">
        <Select
          compact
          value={school}
          ariaLabel={ts.draftTitle}
          options={[{ value: '', label: ts.allSchools }, ...league.teams.map((tm) => ({ value: tm.id, label: tm.shortName }))]}
          onChange={setSchool}
        />
        <button type="button" className="btn primary small" disabled={busy} onClick={() => void start()}>
          {ts.draftStart}
        </button>
      </div>
      {note ? (
        <Notice tone="ok">
          {note} <Link to={inboxLink(league.slug)}>{ts.goInbox}</Link>
        </Notice>
      ) : null}
      {error ? <ErrorBox error={error} /> : null}
    </div>
  )
}
