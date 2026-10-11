import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { call } from '../../api'
import { Badge, Loading, Segmented } from '../../components/ui'
import { useLoad } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { RuleErrors } from './RuleErrors'
import { SuggestionInbox } from './Suggestions'
import { formatDate } from './util'

type Tab = 'checklist' | 'suggestions'

/** Everything that needs you: moves to apply in 2K, and lore suggestions (제안함). */
export function Inbox() {
  const { league } = useLeague()
  const [params, setParams] = useSearchParams()
  const counts = useLoad(
    async () => ({
      checklist: (await call('checklist.list', league.slug)).filter((c) => c.appliedAt === null).length,
      suggestions: (await call('suggestions.status', league.slug)).pending,
    }),
    [league.slug],
    { keepPrevious: true },
  )
  const [pending, setPending] = useState<number | null>(null)
  const asked = params.get('tab')
  // Without a choice in the address, open where something is waiting (2K moves first: they block games).
  const tab: Tab =
    asked === 'suggestions' || asked === 'checklist'
      ? asked
      : counts.state === 'ready' && counts.value.checklist === 0 && counts.value.suggestions > 0
        ? 'suggestions'
        : 'checklist'
  const checklistCount = counts.state === 'ready' ? counts.value.checklist : 0
  const suggestionCount = pending ?? (counts.state === 'ready' ? counts.value.suggestions : 0)

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t.inbox.title}</h1>
        </div>
      </div>
      <Segmented<Tab>
        value={tab}
        ariaLabel={t.inbox.title}
        options={[
          { value: 'checklist', label: t.suggest.checklistTab(checklistCount) },
          { value: 'suggestions', label: t.suggest.tab(suggestionCount) },
        ]}
        onChange={(v) => setParams(new URLSearchParams({ tab: v }), { replace: true })}
      />
      {tab === 'checklist' ? <Checklist onChanged={counts.reload} /> : <SuggestionInbox onCount={setPending} />}
    </div>
  )
}

/** The apply-in-2K checklist. */
function Checklist({ onChanged }: { onChanged: () => void }) {
  const { league } = useLeague()
  const [tick, setTick] = useState(0)
  const list = useLoad(() => call('checklist.list', league.slug), [league.slug, tick], { keepPrevious: true })
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const teamName = (id: string) => league.teams.find((tm) => tm.id === id)?.shortName ?? id
  const playerName = (id: string) => league.players.find((p) => p.id === id)?.name ?? id
  const slotName = (id: string | null) => league.config.roster.slots.find((s) => s.id === id)?.name ?? '–'

  // Marking an item applied ends its trade's veto window, so it asks first.
  const apply = async (id: number) => {
    if (busy || !window.confirm(t.inbox.confirmApply)) return
    setBusy(true)
    setError(null)
    try {
      await call('checklist.apply', league.slug, id)
      setTick((x) => x + 1)
      onChanged()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <p className="help">{t.inbox.intro}</p>
      {error ? <RuleErrors error={error} /> : null}
      {list.state === 'loading' ? <Loading /> : null}
      {list.state === 'error' ? <RuleErrors error={list.error} onRetry={list.reload} /> : null}
      {list.state === 'ready' && list.value.length === 0 ? (
        <div className="card">
          <p className="help">{t.inbox.empty}</p>
        </div>
      ) : null}
      {list.state === 'ready'
        ? list.value.map((item) => (
            <div key={item.id} className="card">
              <div className="card-head">
                <span className="row" style={{ gap: 6 }}>
                  <Badge tone="info">{t.inbox.kinds[item.kind]}</Badge>
                  <span className="muted">{formatDate(item.createdAt, true)}</span>
                </span>
                {item.appliedAt === null ? (
                  <button className="btn primary small" disabled={busy || list.refreshing} onClick={() => void apply(item.id)}>
                    {t.inbox.applied}
                  </button>
                ) : (
                  <Badge tone="ok">{t.inbox.done}</Badge>
                )}
              </div>
              <ul className="plain">
                {item.moves.map((m) => (
                  <li key={m.playerId}>{t.inbox.move(playerName(m.playerId), teamName(m.toTeamId), slotName(m.toSlotId))}</li>
                ))}
              </ul>
            </div>
          ))
        : null}
      <p className="muted">{t.inbox.later}</p>
    </div>
  )
}
