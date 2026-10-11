import { useEffect, useMemo, useState } from 'react'
import type { CardRow, TradeCheck, TradeItem, TradeItemRow } from '@shared/season'
import { call } from '../../api'
import { Badge, Check, IssueList, Loading, Notice, Select, TextInput } from '../../components/ui'
import { useLoad } from '../../hooks'
import { t } from '../../i18n'
import { useLeague } from './LeagueLayout'
import { RuleErrors, ruleText } from './RuleErrors'
import { PastSeasonNotice, SeasonPicker, useSeasonPick } from './SeasonPicker'
import { cardName as nameCard, formatDate, rosterOf } from './util'

// One empty list while cards load, so the memos below hold.
const NO_CARDS: CardRow[] = []

export function Trades() {
  const { league, reload } = useLeague()
  const slug = league.slug
  const [tick, setTick] = useState(0)
  // A past season shows its trades only: no builder, no vetoes.
  const season = useSeasonPick()
  const trades = useLoad(() => call('trades.list', slug, season.arg), [`${slug}:${season.seasonId}`, tick], { keepPrevious: true })
  const cards = useLoad(() => call('cards.list', slug), [slug, tick], { keepPrevious: true })
  const tradable = league.teams.filter((tm) => tm.control !== 'frozen')
  const [a, setA] = useState(tradable[0]?.id ?? '')
  const [b, setB] = useState(tradable[1]?.id ?? '')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [note, setNote] = useState('')
  const [check, setCheck] = useState<TradeCheck | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  const teamName = (id: string) => league.teams.find((tm) => tm.id === id)?.shortName ?? id
  const playerName = (id: string) => league.players.find((p) => p.id === id)?.name ?? id
  const slotName = (id: string | null) => league.config.roster.slots.find((s) => s.id === id)?.name ?? '–'
  const cardList = cards.state === 'ready' ? cards.value : NO_CARDS
  // The builder trades this season's cards.
  const cardName = (id: number) => {
    const c = cardList.find((x) => x.id === id)
    return c ? nameCard(league, c, league.season.id) : String(id)
  }
  // A traded card names itself, as the season on screen knew it.
  const itemCard = (i: TradeItemRow) => (i.card ? nameCard(league, i.card, season.seasonId) : cardName(i.cardId ?? 0))

  const items = useMemo((): TradeItem[] => {
    const out: TradeItem[] = []
    for (const key of picked) {
      const [kind, id] = key.split(':') as ['p' | 'c', string]
      if (kind === 'p') {
        const p = league.players.find((x) => x.id === id)
        if (p && (p.teamId === a || p.teamId === b)) out.push({ kind: 'player', playerId: p.id, from: p.teamId, to: p.teamId === a ? b : a })
      } else {
        const c = cardList.find((x) => x.id === Number(id))
        if (c && (c.ownerTeamId === a || c.ownerTeamId === b)) out.push({ kind: 'card', cardId: c.id, from: c.ownerTeamId, to: c.ownerTeamId === a ? b : a })
      }
    }
    return out
  }, [picked, a, b, league.players, cardList])

  // Check against the rules as the trade changes; the old result and error go first.
  useEffect(() => {
    setCheck(null)
    setError(null)
    if (items.length === 0 || a === b) return
    let alive = true
    call('trades.preview', slug, items).then(
      (r) => alive && setCheck(r),
      (e: unknown) => alive && setError(e),
    )
    return () => {
      alive = false
    }
  }, [items, slug, a, b])

  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const apply = async () => {
    setBusy(true)
    setError(null)
    try {
      await call('trades.apply', slug, items, note.trim())
      setPicked(new Set())
      setNote('')
      setDone(true)
      setTick((x) => x + 1)
      reload()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const veto = async (id: number) => {
    if (!window.confirm(t.trades.confirmVeto)) return
    setError(null)
    try {
      await call('trades.veto', slug, id)
      setTick((x) => x + 1)
      reload()
    } catch (e) {
      setError(e)
    }
  }

  const side = (teamId: string, setTeam: (v: string) => void, label: string) => (
    <div className="card">
      <div className="card-head">
        <h3>{label}</h3>
        <Select
          value={teamId}
          ariaLabel={label}
          options={tradable.map((tm) => ({ value: tm.id, label: tm.shortName }))}
          onChange={(v) => {
            setTeam(v)
            setPicked(new Set())
            setDone(false)
          }}
        />
      </div>
      <div className="stack" style={{ gap: 4 }}>
        <span className="label">{t.trades.players}</span>
        {rosterOf(league, teamId).map((p) => (
          <Check key={p.id} checked={picked.has(`p:${p.id}`)} onChange={() => toggle(`p:${p.id}`)}>
            <span className="muted">{slotName(p.slotId)}</span> {p.name}
          </Check>
        ))}
      </div>
      {cardList.some((c) => c.ownerTeamId === teamId && c.status === 'held') ? (
        <div className="stack" style={{ gap: 4 }}>
          <span className="label">{t.trades.cards}</span>
          {cardList
            .filter((c) => c.ownerTeamId === teamId && c.status === 'held')
            .map((c) => (
              <Check key={c.id} checked={picked.has(`c:${c.id}`)} onChange={() => toggle(`c:${c.id}`)}>
                {cardName(c.id)}
              </Check>
            ))}
        </div>
      ) : null}
    </div>
  )

  return (
    <div className="page wide">
      <div className="page-head">
        <h1>{t.trades.title}</h1>
        <SeasonPicker season={season} />
      </div>
      <PastSeasonNotice season={season} />
      {season.past ? null : (
        <>
          <h2>{t.trades.builder}</h2>
          <div className="grid-2">
            {side(a, setA, t.trades.teamA)}
            {side(b, setB, t.trades.teamB)}
          </div>
          <div className="card">
            <TextInput value={note} onChange={setNote} placeholder={t.trades.note} ariaLabel={t.trades.note} />
            {check && !check.ok ? (
              <Notice tone="err">
                <IssueList items={check.issues.map((i) => ({ level: 'error' as const, text: ruleText(i.code, i.params) }))} />
              </Notice>
            ) : null}
            {check?.ok ? (
              <Notice tone="ok">
                <div className="stack" style={{ gap: 2 }}>
                  <span>{t.trades.ok}</span>
                  {check.moves.map((m) => (
                    <span key={m.playerId}>{t.trades.moveLine(playerName(m.playerId), teamName(m.to), slotName(m.toSlotId))}</span>
                  ))}
                </div>
              </Notice>
            ) : null}
            {done && items.length === 0 ? <Notice tone="ok">{t.trades.applied}</Notice> : null}
            {error ? <RuleErrors error={error} /> : null}
            <div>
              <button className="btn primary" disabled={busy || !check?.ok} onClick={() => void apply()}>
                {t.trades.apply}
              </button>
            </div>
          </div>
        </>
      )}

      <div className="card">
        <h2>{t.trades.history}</h2>
        {trades.state === 'loading' ? <Loading /> : null}
        {trades.state === 'error' ? <RuleErrors error={trades.error} onRetry={trades.reload} /> : null}
        {trades.state === 'ready' && trades.value.length === 0 ? <p className="help">{season.past ? t.trades.noneThen : t.trades.none}</p> : null}
        {trades.state === 'ready'
          ? trades.value.map((tr) => (
              <div key={tr.id} className="trade-row">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="row" style={{ gap: 6 }}>
                    <b>#{tr.id}</b>
                    <span className="muted">{formatDate(tr.createdAt)}</span>
                    {tr.status === 'vetoed' ? (
                      <Badge tone="err">{t.trades.vetoed}</Badge>
                    ) : tr.pendingIn2k ? (
                      <Badge tone="warn">{t.trades.pending}</Badge>
                    ) : (
                      <Badge tone="ok">{t.trades.done}</Badge>
                    )}
                  </span>
                  {tr.status === 'applied' && tr.pendingIn2k && !season.past ? (
                    <button className="btn small danger" onClick={() => void veto(tr.id)}>
                      {t.trades.veto}
                    </button>
                  ) : null}
                </div>
                <ul className="plain">
                  {tr.items.map((i, n) => (
                    <li key={n}>
                      {i.kind === 'player'
                        ? t.trades.moveLine(playerName(i.playerId ?? ''), teamName(i.to), slotName(i.toSlotId))
                        : `${itemCard(i)} → ${teamName(i.to)}`}
                    </li>
                  ))}
                </ul>
                {tr.note ? <p className="help">{tr.note}</p> : null}
              </div>
            ))
          : null}
      </div>
    </div>
  )
}
