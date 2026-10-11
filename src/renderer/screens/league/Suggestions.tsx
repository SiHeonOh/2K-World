import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { GM_TRAITS, MEDIA_STYLES, NEGOTIATION_STYLES, PHILOSOPHIES, PLAYER_TRAITS, RELATIONSHIP_TYPES, VISIBILITIES, type LoreRelationship } from '@shared/lore'
import { cleanLoreText, cutText } from '@shared/secretText'
import type { ApproveResult, LorePatch, SuggestionKind, SuggestionView } from '@shared/suggestions'
import { call } from '../../api'
import { Badge, ErrorBox, Loading, Notice, Segmented, Select } from '../../components/ui'
import { useLoad } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { AutoTextarea, Scale } from './lore/controls'
import { useRoundName } from './Played'
import { formatDate } from './util'

const ts = t.suggest
const tl = t.lore

const loreLink = (slug: string, s: SuggestionView) =>
  `/l/${encodeURIComponent(slug)}/lore?${s.target.kind === 'player' ? `player=${encodeURIComponent(s.target.playerId)}` : `${s.target.kind}=${encodeURIComponent(s.target.teamId)}`}`
const traitInfo = (s: SuggestionView, key: string) => (s.target.kind === 'gm' ? tl.gmTraits[key] : tl.playerTraits[key])
const traitOrder = (s: SuggestionView) => (s.target.kind === 'gm' ? GM_TRAITS : PLAYER_TRAITS) as readonly string[]
/** A card's failure in words: its reason's own message (lore-error:heading-in-text), else its code's. */
const errorText = (error: string) => ts.errors[error] ?? ts.errors[error.split(':')[0]!] ?? error
/** The same on a reveal card, which says why it's stale in its own words. */
const revealErrorText = (error: string) =>
  (error.startsWith('stale:') ? ts.revealStale[error.slice('stale:'.length)] : undefined) ?? ts.revealErrors[error] ?? ts.revealErrors[error.split(':')[0]!] ?? errorText(error)

/** The lore suggestion inbox: every card waiting for you, grouped by where it came from. */
export function SuggestionInbox({ onCount }: { onCount?: (n: number) => void }) {
  const { league, reload: reloadLeague } = useLeague()
  // "R5 이후", or "5일차 이후" in 2K 일정대로.
  const roundName = useRoundName('short')
  const [tick, setTick] = useState(0)
  const status = useLoad(() => call('suggestions.status', league.slug), [league.slug, tick], { keepPrevious: true })
  const list = useLoad(() => call('suggestions.list', league.slug, 'pending'), [league.slug, tick], { keepPrevious: true })
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const reload = () => setTick((x) => x + 1)
  const working = status.state === 'ready' && status.value.drafting + status.value.sweeping > 0

  // While the AI is writing, look again every few seconds.
  useEffect(() => {
    if (!working) return
    const id = setInterval(reload, 4000)
    return () => clearInterval(id)
  }, [working])
  useEffect(() => {
    if (list.state === 'ready') onCount?.(list.value.length)
  }, [list])

  const teamName = (id: string) => league.teams.find((tm) => tm.id === id)?.shortName ?? id
  const groups = useMemo(() => {
    if (list.state !== 'ready') return []
    const out: { key: string; title: string; items: SuggestionView[] }[] = []
    const add = (key: string, title: string, s: SuggestionView) => {
      const g = out.find((x) => x.key === key)
      if (g) g.items.push(s)
      else out.push({ key, title, items: [s] })
    }
    const newest = (a: SuggestionView, b: SuggestionView) => (b.seasonId ?? 0) - (a.seasonId ?? 0) || (b.round ?? 0) - (a.round ?? 0) || a.id - b.id
    // Secrets that may be out come first, in groups of their own (each is approved by itself).
    for (const s of list.value.filter((x) => x.kind === 'reveal').sort(newest)) add(`reveal:${s.seasonId}:${s.round}`, ts.revealGroup(s.round, roundName), s)
    const drafts = list.value.filter((s) => s.kind === 'draft').sort((a, b) => a.teamId.localeCompare(b.teamId) || a.id - b.id)
    for (const s of drafts) add(`draft:${s.teamId}`, ts.draftGroup(teamName(s.teamId)), s)
    const rounds = list.value.filter((s) => s.kind !== 'draft' && s.kind !== 'reveal').sort(newest)
    for (const s of rounds) add(`round:${s.seasonId}:${s.round}`, s.round !== null ? ts.roundGroup(s.round, roundName) : ts.kinds[s.kind]!, s)
    return out
  }, [list])

  const act = async (fn: () => Promise<string | null>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      setMessage(await fn())
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
      reload()
    }
  }
  const approveAll = (items: SuggestionView[]) => {
    if (!window.confirm(ts.confirmApproveAll(items.length))) return
    void act(async () => {
      const r = await call('suggestions.approveMany', league.slug, items.map((s) => s.id))
      return ts.approveAllResult(r.approved, r.failed)
    })
  }
  const always = (kind: SuggestionKind) => {
    if (!window.confirm(ts.confirmAlways(ts.kinds[kind]!))) return
    void act(async () => {
      const r = await call('suggestions.setMode', league.slug, kind, 'auto')
      // 편집실 shows the league's settings: they changed.
      reloadLeague()
      return r.applied ? t.suggest.applied(r.applied) : t.suggest.saved
    })
  }

  return (
    <div className="stack suggest">
      <p className="help">{ts.intro}</p>
      {status.state === 'ready' && !status.value.aiReady ? <Notice tone="warn">{ts.aiOff}</Notice> : null}
      {status.state === 'ready' && status.value.drafting > 0 ? (
        <div className="row muted">
          <span className="spin" /> {ts.drafting(status.value.drafting)}
        </div>
      ) : null}
      {status.state === 'ready' && status.value.sweeping > 0 ? (
        <div className="row muted">
          <span className="spin" /> {ts.sweeping}
        </div>
      ) : null}
      {message ? <Notice tone="ok">{message}</Notice> : null}
      {error ? <ErrorBox error={error} /> : null}
      {list.state === 'loading' ? <Loading /> : null}
      {list.state === 'error' ? <ErrorBox error={list.error} onRetry={list.reload} /> : null}
      {list.state === 'ready' && list.value.length === 0 ? (
        <div className="card">
          <p>{ts.empty}</p>
          <p className="help">{ts.emptyHelp}</p>
        </div>
      ) : null}
      {groups.map((g) => (
        <section key={g.key} className="suggest-group">
          <div className="suggest-group-head">
            <h3>{g.title}</h3>
            {g.items.length > 1 && !g.items.some((s) => s.kind === 'reveal') ? (
              <button className="btn small" disabled={busy} onClick={() => approveAll(g.items)}>
                {ts.approveAll(g.items.length)}
              </button>
            ) : null}
          </div>
          {g.items.map((s) =>
            s.kind === 'reveal' ? <RevealCard key={s.id} s={s} busy={busy} act={act} /> : <SuggestionCard key={s.id} s={s} busy={busy} act={act} onAlways={always} />,
          )}
        </section>
      ))}
      <div className="suggest-history">
        <button type="button" className="btn ghost small" onClick={() => setShowHistory((x) => !x)}>
          {showHistory ? '▾' : '▸'} {ts.history}
        </button>
        {showHistory ? <History tick={tick} /> : null}
      </div>
    </div>
  )
}

function History({ tick }: { tick: number }) {
  const { league } = useLeague()
  const list = useLoad(() => call('suggestions.list', league.slug, 'decided'), [league.slug, tick], { keepPrevious: true })
  if (list.state === 'loading') return <Loading />
  if (list.state === 'error') return <ErrorBox error={list.error} onRetry={list.reload} />
  if (list.value.length === 0) return <p className="muted">{ts.historyEmpty}</p>
  return (
    <table className="data suggest-history-table">
      <tbody>
        {list.value.map((s) => (
          <tr key={s.id}>
            <td>
              <Badge tone={s.status === 'approved' ? 'ok' : undefined}>{ts.statuses[s.status]}</Badge>
              {s.auto ? <span className="muted"> {ts.autoTag}</span> : null}
            </td>
            <td>{ts.kinds[s.kind]}</td>
            <td>
              <Link to={loreLink(league.slug, s)}>{s.name}</Link>
            </td>
            <td className="muted">{summary(s.patch)}</td>
            <td className="muted">{s.decidedAt ? formatDate(s.decidedAt, true) : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** One short line for a decided card. */
function summary(p: LorePatch): string {
  const parts: string[] = []
  if (p.nicknames) parts.push(p.nicknames.join(', '))
  if (p.relationships) parts.push(...p.relationships.map((r) => `${tl.relationTypes[r.type]} ${r.with}`))
  if (p.traits) parts.push(`${tl.tabs.traits} ${Object.keys(p.traits).length}`)
  if (p.public) parts.push(`${tl.sections.public}: ${p.public.slice(0, 30)}…`)
  if (p.rumor) parts.push(`${tl.sections.rumor}: ${p.rumor.slice(0, 30)}…`)
  return parts.join(' · ')
}

function SuggestionCard({
  s,
  busy,
  act,
  onAlways,
}: {
  s: SuggestionView
  busy: boolean
  act: (fn: () => Promise<string | null>) => Promise<void>
  onAlways: (kind: SuggestionKind) => void
}) {
  const { league } = useLeague()
  const [editing, setEditing] = useState(false)
  const [patch, setPatch] = useState<LorePatch>(s.patch)
  const team = league.teams.find((tm) => tm.id === s.teamId)?.shortName
  // A failed approval is shown on the card itself (it stays waiting), unless the card is gone.
  const done = (r: ApproveResult) => {
    if (r.status === 'error' && r.code === 'gone') throw new Error(ts.errors.gone)
    if (r.status === 'error') return null
    return r.file ? ts.approvedFile(r.file) : ts.approvedRoster
  }
  const approve = (edited?: LorePatch) => void act(async () => done(await call('suggestions.approve', league.slug, s.id, edited)))
  const reject = () => void act(async () => (await call('suggestions.reject', league.slug, s.id), null))
  const shown = editing ? patch : s.patch

  return (
    <div className={`card suggest-card${editing ? ' editing' : ''}`}>
      <div className="suggest-card-head">
        <div className="row" style={{ gap: 8 }}>
          <Badge tone="accent">{ts.kinds[s.kind]}</Badge>
          <Link to={loreLink(league.slug, s)} className="suggest-name">
            {s.name}
          </Link>
          {s.target.kind === 'player' && team ? <span className="muted">{team}</span> : null}
          {s.times > 1 ? <Badge tone="info">{ts.times(s.times)}</Badge> : null}
          {s.source.postId ? (
            <Link className="muted" to={`/l/${encodeURIComponent(league.slug)}/community?post=${s.source.postId}`}>
              {ts.thread(s.source.postId)}
            </Link>
          ) : null}
        </div>
        <span className="muted">{formatDate(s.createdAt, true)}</span>
      </div>
      {!s.current.exists && s.kind !== 'nickname' ? <p className="help">{ts.newFile}</p> : null}
      {s.error ? <Notice tone="err">{errorText(s.error)}</Notice> : null}

      <div className="suggest-body">
        {shown.name !== undefined || s.patch.name !== undefined ? (
          <Row label={tl.gmName}>
            <Before value={s.current.name ?? '—'} />
            {editing ? <input className="compact" value={patch.name ?? ''} maxLength={30} onChange={(e) => setPatch({ ...patch, name: e.target.value })} /> : <After value={shown.name ?? ''} />}
          </Row>
        ) : null}
        {s.patch.philosophy !== undefined ? (
          <Row label={tl.philosophy}>
            <Before value={tl.philosophies[s.current.philosophy ?? ''] ?? ''} />
            {editing ? (
              <Select compact value={patch.philosophy ?? 'balanced'} options={PHILOSOPHIES.map((v) => ({ value: v, label: tl.philosophies[v]! }))} onChange={(v) => setPatch({ ...patch, philosophy: v })} />
            ) : (
              <After value={tl.philosophies[shown.philosophy ?? ''] ?? ''} />
            )}
          </Row>
        ) : null}
        {s.patch.negotiation !== undefined ? (
          <Row label={tl.negotiation}>
            <Before value={tl.negotiationStyles[s.current.negotiation ?? ''] ?? ''} />
            {editing ? (
              <Select compact value={patch.negotiation ?? 'fair'} options={NEGOTIATION_STYLES.map((v) => ({ value: v, label: tl.negotiationStyles[v]! }))} onChange={(v) => setPatch({ ...patch, negotiation: v })} />
            ) : (
              <After value={tl.negotiationStyles[shown.negotiation ?? ''] ?? ''} />
            )}
          </Row>
        ) : null}
        {s.patch.traits ? (
          <div className="suggest-traits">
            {traitOrder(s)
              .filter((k) => s.patch.traits![k] !== undefined)
              .map((k) => {
                const info = traitInfo(s, k)
                const before = s.current.traits?.[k] ?? 3
                const after = shown.traits?.[k] ?? before
                return (
                  <Row key={k} label={info?.name ?? k}>
                    {editing ? (
                      <Scale small value={after} onChange={(v) => setPatch({ ...patch, traits: { ...patch.traits, [k]: v } })} low={info?.low} high={info?.high} ariaLabel={info?.name ?? k} />
                    ) : (
                      <span className={after !== before ? 'suggest-changed' : 'muted'}>
                        {before} → <b>{after}</b>
                        {info ? <span className="muted"> · {after >= 4 ? info.high : after <= 2 ? info.low : tl.defaultValue}</span> : null}
                      </span>
                    )}
                  </Row>
                )
              })}
          </div>
        ) : null}
        {s.patch.media !== undefined ? (
          <Row label={tl.media}>
            <Before value={tl.mediaStyles[s.current.media ?? ''] ?? ''} />
            {editing ? (
              <Select compact value={patch.media ?? 'normal'} options={MEDIA_STYLES.map((v) => ({ value: v, label: tl.mediaStyles[v]! }))} onChange={(v) => setPatch({ ...patch, media: v })} />
            ) : (
              <After value={tl.mediaStyles[shown.media ?? ''] ?? ''} />
            )}
          </Row>
        ) : null}
        {s.patch.fans ? (
          <div className="suggest-traits">
            {(['size', 'temperament', 'pride'] as const)
              .filter((k) => s.patch.fans![k] !== undefined)
              .map((k) => {
                const info = tl.fanTraits[k]!
                const before = s.current.fans?.[k] ?? 3
                const after = shown.fans?.[k] ?? before
                return (
                  <Row key={k} label={info.name}>
                    {editing ? (
                      <Scale small value={after} onChange={(v) => setPatch({ ...patch, fans: { ...patch.fans, [k]: v } })} low={info.low} high={info.high} ariaLabel={info.name} />
                    ) : (
                      <span className={after !== before ? 'suggest-changed' : 'muted'}>
                        {before} → <b>{after}</b>
                      </span>
                    )}
                  </Row>
                )
              })}
          </div>
        ) : null}
        {s.patch.rivals ? (
          <Row label={ts.rivalsAdd}>
            <Chips values={shown.rivals ?? []} editing={editing} onRemove={(v) => setPatch({ ...patch, rivals: (patch.rivals ?? []).filter((x) => x !== v) })} />
          </Row>
        ) : null}
        {s.patch.nicknames ? (
          <Row label={ts.rosterNicknames}>
            {editing ? (
              <input
                className="compact"
                value={(patch.nicknames ?? []).join(', ')}
                aria-label={ts.rosterNicknames}
                placeholder={ts.nicknamesHelp}
                onChange={(e) => setPatch({ ...patch, nicknames: e.target.value.split(',').map((x) => x.trimStart()) })}
              />
            ) : (
              <Chips values={shown.nicknames ?? []} />
            )}
            {s.current.nicknames?.length ? <span className="muted">({s.current.nicknames.join(', ')})</span> : null}
          </Row>
        ) : null}
        {s.patch.relationships ? (
          <Relationships s={s} rels={shown.relationships ?? []} editing={editing} onChange={(relationships) => setPatch({ ...patch, relationships })} />
        ) : null}
        {(['public', 'rumor'] as const)
          .filter((k) => s.patch[k] !== undefined)
          .map((k) => (
            <Prose key={k} label={(s.current[k] ?? '').trim() ? ts.append(tl.sections[k]!) : ts.fill(tl.sections[k]!)} current={s.current[k] ?? ''}>
              {editing ? <AutoTextarea value={patch[k] ?? ''} onChange={(v) => setPatch({ ...patch, [k]: v })} minRows={3} ariaLabel={tl.sections[k]} /> : <p className="suggest-new-text">{shown[k]}</p>}
            </Prose>
          ))}
        {s.source.hint ? (
          <p className="help">
            <b>{ts.hint}</b> {s.source.hint}
          </p>
        ) : null}
        {s.reason ? (
          <p className="help">
            <b>{ts.why}</b> {s.reason}
          </p>
        ) : null}
      </div>

      <div className="row suggest-actions">
        {editing ? (
          <>
            <button className="btn primary small" disabled={busy} onClick={() => approve(cleanEdited(patch))}>
              {ts.saveApprove}
            </button>
            <button
              className="btn small"
              disabled={busy}
              onClick={() => {
                setPatch(s.patch)
                setEditing(false)
              }}
            >
              {ts.cancel}
            </button>
          </>
        ) : (
          <>
            <button className="btn primary small" disabled={busy} onClick={() => approve()}>
              {ts.approve}
            </button>
            <button
              className="btn small"
              disabled={busy}
              onClick={() => {
                // Start from the card as it is now (a newer draft may have replaced it), and never
                // from a more public relationship than the one in the file: making it public is your call.
                setPatch(withStricter(s.patch, s.current.relationships ?? []))
                setEditing(true)
              }}
            >
              {ts.edit}
            </button>
            <button className="btn ghost small" disabled={busy} onClick={reject}>
              {ts.reject}
            </button>
          </>
        )}
        <span className="spacer" />
        {s.kind !== 'draft' && s.kind !== 'reveal' && !editing ? (
          <button className="btn ghost small" disabled={busy} onClick={() => onAlways(s.kind as SuggestionKind)}>
            {ts.always}
          </button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * A secret that may be out: the 비밀 text (or secret relationship), why the
 * AI thinks it's known, and where it moves. The card shows exactly what
 * leaves 비밀 and what stays there after. Editing changes the wording that
 * goes public, the destination (공개 or 소문), and what you keep in 비밀 in
 * the card text's place; what leaves 비밀 stays the card's. Each is approved
 * by itself, never by "approve all" or a setting.
 */
function RevealCard({ s, busy, act }: { s: SuggestionView; busy: boolean; act: (fn: () => Promise<string | null>) => Promise<void> }) {
  const { league } = useLeague()
  const tie = s.patch.relationships?.[0]
  const startTo = s.patch.public !== undefined || tie?.visibility === 'public' ? 'public' : 'rumor'
  const [editing, setEditing] = useState(false)
  const [to, setTo] = useState<'public' | 'rumor'>(startTo)
  const [text, setText] = useState(s.patch.public ?? s.patch.rumor ?? '')
  const [keep, setKeep] = useState('')
  const team = league.teams.find((tm) => tm.id === s.teamId)?.shortName
  const now = editing ? to : startTo
  const shownText = editing ? text : (s.patch.public ?? s.patch.rumor ?? '')
  // 비밀 after approving, worked out the way approving does it, what you keep cleaned as the server cleans it (null: the text isn't there now).
  const stays = s.patch.fromSecret !== undefined && s.current.secret !== undefined ? cutText(s.current.secret, s.patch.fromSecret, editing ? cleanLoreText(keep, Infinity) : '') : null
  // A "no longer in the file" from an earlier try is wrong once the file holds the secret again: the card is shown as it would go now.
  const there = tie
    ? (s.current.relationships ?? []).some((r) => r.with.normalize('NFC') === tie.with.normalize('NFC') && r.type === tie.type && r.visibility === 'secret')
    : stays !== null
  const error = s.error && !(there && (s.error === 'stale' || s.error.startsWith('stale:'))) ? s.error : null
  const done = (r: ApproveResult) => {
    if (r.status === 'error' && r.code === 'gone') throw new Error(ts.errors.gone)
    return r.status === 'error' ? null : ts.approvedFile(r.file ?? '')
  }
  const approve = (edited?: LorePatch) => void act(async () => done(await call('suggestions.approve', league.slug, s.id, edited)))
  const reject = () => void act(async () => (await call('suggestions.reject', league.slug, s.id), null))
  const edited = (): LorePatch =>
    tie ? { relationships: [{ ...tie, visibility: to }] } : { ...(to === 'public' ? { public: text } : { rumor: text }), ...(keep.trim() ? { keepSecret: keep } : {}) }
  const cancel = () => {
    setTo(startTo)
    setText(s.patch.public ?? s.patch.rumor ?? '')
    setKeep('')
    setEditing(false)
  }

  return (
    <div className={`card suggest-card reveal${editing ? ' editing' : ''}`}>
      <div className="suggest-card-head">
        <div className="row" style={{ gap: 8 }}>
          <Badge tone="warn">{ts.kinds.reveal}</Badge>
          <Link to={loreLink(league.slug, s)} className="suggest-name">
            {s.name}
          </Link>
          {s.target.kind === 'player' && team ? <span className="muted">{team}</span> : null}
          {s.times > 1 ? <Badge tone="info">{ts.times(s.times)}</Badge> : null}
          {s.source.postId ? (
            <Link className="muted" to={`/l/${encodeURIComponent(league.slug)}/community?post=${s.source.postId}`}>
              {ts.thread(s.source.postId)}
            </Link>
          ) : null}
        </div>
        <span className="muted">{formatDate(s.createdAt, true)}</span>
      </div>
      {error ? <Notice tone="err">{revealErrorText(error)}</Notice> : null}

      <div className="suggest-body">
        <Row label={ts.revealMove}>
          {editing ? (
            <Segmented
              ariaLabel={ts.revealMove}
              value={to}
              options={(['public', 'rumor'] as const).map((v) => ({ value: v, label: ts.revealTo(tl.sections[v]!) }))}
              onChange={setTo}
            />
          ) : (
            <b className="suggest-changed">{ts.revealTo(tl.sections[now]!)}</b>
          )}
        </Row>
        {tie ? (
          <Row label={ts.revealTie}>
            <b>{tie.with}</b>
            <span>
              {tl.relationTypes[tie.type]} · {tl.strength} {tie.strength} · <span className="muted">{tl.visibilities.secret} →</span> <b className="suggest-changed">{tl.visibilities[now]}</b>
            </span>
          </Row>
        ) : (
          <>
            <div className="suggest-prose">
              <span className="suggest-label">{ts.revealLeaves}</span>
              <p className="suggest-secret-text">{s.patch.fromSecret}</p>
            </div>
            <Prose label={(s.current[now] ?? '').trim() ? ts.append(tl.sections[now]!) : ts.fill(tl.sections[now]!)} current={s.current[now] ?? ''}>
              {editing ? <AutoTextarea value={text} onChange={setText} minRows={3} ariaLabel={tl.sections[now]} /> : <p className="suggest-new-text">{shownText}</p>}
            </Prose>
            {editing ? (
              <div className="suggest-prose">
                <span className="suggest-label">{ts.revealKeep}</span>
                <AutoTextarea value={keep} onChange={setKeep} minRows={2} ariaLabel={ts.revealKeep} />
                <p className="help">{ts.revealKeepHelp}</p>
              </div>
            ) : null}
            {stays !== null ? (
              <div className="suggest-prose">
                <span className="suggest-label">{ts.revealStays}</span>
                {stays.trim() ? <p className="suggest-current-text">{stays}</p> : <p className="muted">{ts.revealStaysEmpty}</p>}
              </div>
            ) : null}
            {editing ? <Notice tone="warn">{ts.revealDeleted}</Notice> : null}
          </>
        )}
        {s.reason ? (
          <p className="help">
            <b>{ts.evidence}</b> {s.reason}
          </p>
        ) : null}
        <p className="help">{tie ? ts.revealTieHelp : ts.revealHelp}</p>
      </div>

      <div className="row suggest-actions">
        {editing ? (
          <>
            <button className="btn primary small" disabled={busy || (!tie && !text.trim())} onClick={() => approve(edited())}>
              {ts.saveApprove}
            </button>
            <button className="btn small" disabled={busy} onClick={cancel}>
              {ts.cancel}
            </button>
          </>
        ) : (
          <>
            <button className="btn primary small" disabled={busy} onClick={() => approve()}>
              {ts.approve}
            </button>
            <button className="btn small" disabled={busy} onClick={() => setEditing(true)}>
              {ts.edit}
            </button>
            <button className="btn ghost small" disabled={busy} onClick={reject}>
              {ts.reject}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

const RANK: Record<string, number> = { public: 0, rumor: 1, secret: 2 }
const stricter = (a: LoreRelationship['visibility'], b: LoreRelationship['visibility']) => ((RANK[a] ?? 0) > (RANK[b] ?? 0) ? a : b)

/** A card to edit: a relationship already in the file starts at the less public of the two visibilities. */
function withStricter(p: LorePatch, current: LoreRelationship[]): LorePatch {
  if (!p.relationships) return p
  return {
    ...p,
    relationships: p.relationships.map((r) => {
      const old = current.find((x) => x.with.normalize('NFC') === r.with.normalize('NFC'))
      return old ? { ...r, visibility: stricter(old.visibility, r.visibility) } : r
    }),
  }
}

/** What's sent when you approve an edited card: empty text and empty lists dropped. */
function cleanEdited(p: LorePatch): LorePatch {
  const out: LorePatch = { ...p }
  for (const k of ['public', 'rumor', 'name'] as const) if (out[k] !== undefined && out[k]!.trim() === '') delete out[k]
  if (out.nicknames) out.nicknames = out.nicknames.map((n) => n.trim()).filter(Boolean)
  for (const k of ['nicknames', 'rivals', 'relationships'] as const) if (out[k]?.length === 0) delete out[k]
  return out
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="suggest-row">
      <span className="suggest-label">{label}</span>
      <span className="suggest-value">{children}</span>
    </div>
  )
}

const Before = ({ value }: { value: string }) => <span className="muted">{value || '—'} →</span>
const After = ({ value }: { value: string }) => <b className="suggest-changed">{value}</b>

function Chips({ values, editing, onRemove }: { values: string[]; editing?: boolean; onRemove?: (v: string) => void }) {
  return (
    <span className="lore-chips">
      {values.map((v) => (
        <span key={v} className="lore-chip">
          + {v}
          {editing && onRemove ? (
            <button type="button" aria-label={`${v} ✕`} onClick={() => onRemove(v)}>
              ✕
            </button>
          ) : null}
        </span>
      ))}
    </span>
  )
}

function Prose({ label, current, children }: { label: string; current: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="suggest-prose">
      <div className="suggest-prose-head">
        <span className="suggest-label">{label}</span>
        {current.trim() ? (
          <button type="button" className="btn ghost small" onClick={() => setOpen((x) => !x)}>
            {open ? '▾' : '▸'} {ts.showCurrent}
          </button>
        ) : null}
      </div>
      {open ? <p className="suggest-current-text">{current}</p> : null}
      {children}
    </div>
  )
}

function Relationships({ s, rels, editing, onChange }: { s: SuggestionView; rels: LoreRelationship[]; editing: boolean; onChange: (r: LoreRelationship[]) => void }) {
  const have = (who: string) => (s.current.relationships ?? []).find((r) => r.with.normalize('NFC') === who.normalize('NFC'))
  const set = (i: number, change: Partial<LoreRelationship>) => onChange(rels.map((r, j) => (j === i ? { ...r, ...change } : r)))
  return (
    <div className="suggest-rels">
      <span className="suggest-label">{tl.tabs.relationships}</span>
      {rels.map((r, i) => {
        const old = have(r.with)
        return (
          <div key={`${r.with}:${i}`} className="suggest-rel">
            <Badge tone={old ? 'warn' : 'ok'}>{old ? ts.relationChange : ts.relationNew}</Badge>
            <b>{r.with}</b>
            {editing ? (
              <>
                <Select compact value={r.type} options={RELATIONSHIP_TYPES.map((v) => ({ value: v, label: tl.relationTypes[v]! }))} onChange={(v) => set(i, { type: v })} />
                <Scale small value={r.strength} onChange={(v) => set(i, { strength: v })} ariaLabel={tl.strength} />
                <Select compact value={r.visibility} options={VISIBILITIES.map((v) => ({ value: v, label: tl.visibilities[v]! }))} onChange={(v) => set(i, { visibility: v })} />
                <button type="button" className="btn ghost small" onClick={() => onChange(rels.filter((_, j) => j !== i))}>
                  {ts.removeItem}
                </button>
              </>
            ) : (
              <span>
                {old ? (
                  <span className="muted">
                    {tl.relationTypes[old.type]} {old.strength} · {tl.visibilities[old.visibility]} →{' '}
                  </span>
                ) : null}
                {tl.relationTypes[r.type]} · {tl.strength} {r.strength} · {tl.visibilities[r.visibility]}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
