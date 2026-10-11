import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useOutletContext, useParams } from 'react-router'
import type { LeagueSnapshot } from '@shared/league'
import { call } from '../../api'
import { QueueBanner } from '../../components/QueueBanner'
import { Shell } from '../../components/Shell'
import { ErrorBox, Loading } from '../../components/ui'
import { useLoad, usePush } from '../../hooks'

interface LeagueContext {
  league: LeagueSnapshot
  reload: () => void
  /** A reload is running; `league` is still the previous snapshot. */
  refreshing: boolean
}

/** Loads a league's snapshot once and shares it with every screen under /l/:slug. */
export function LeagueLayout() {
  const { slug = '' } = useParams()
  // A reload keeps the screens mounted on the old snapshot until the new one arrives.
  const snap = useLoad(() => call('leagues.snapshot', slug), [slug], { keepPrevious: true })
  const waiting = useWaiting(slug, snap.state === 'ready' ? snap.value.stamp : null, snap.reload)
  return (
    <Shell leagueName={snap.state === 'ready' ? snap.value.config.league.name : null} badges={{ inbox: waiting }}>
      {snap.state === 'ready' ? <QueueBanner slug={slug} /> : null}
      {snap.state === 'loading' ? (
        <div className="page">
          <Loading />
        </div>
      ) : null}
      {snap.state === 'error' ? (
        <div className="page">
          <ErrorBox error={snap.error} onRetry={snap.reload} />
        </div>
      ) : null}
      {snap.state === 'ready' ? <Outlet context={{ league: snap.value, reload: snap.reload, refreshing: snap.refreshing } satisfies LeagueContext} /> : null}
    </Shell>
  )
}

export const useLeague = () => useOutletContext<LeagueContext>()

/**
 * Things waiting in the inbox (2K moves to apply, lore suggestions), looked at
 * again on every screen change and now and then. It also notices facts that
 * changed in the background (an AI GM's trade) and reloads the snapshot.
 */
function useWaiting(slug: string, shown: number | null, reloadSnapshot: () => void): number {
  const location = useLocation()
  const [count, setCount] = useState(0)
  const [tick, setTick] = useState(0)
  // The stamp of the snapshot on screen, read inside the effect without re-running it.
  const shownRef = useRef(shown)
  shownRef.current = shown
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 20_000)
    return () => clearInterval(id)
  }, [])
  // A GM's trade or new lore suggestions finishing in the background show up at once, not at the next look.
  usePush(slug, ['gm', 'inbox'], () => setTick((x) => x + 1))
  useEffect(() => {
    let alive = true
    Promise.all([call('checklist.list', slug), call('suggestions.status', slug), call('leagues.stamp', slug)])
      .then(([list, status, s]) => {
        if (!alive) return
        setCount(list.filter((c) => c.appliedAt === null).length + status.pending)
        if (shownRef.current !== null && s.stamp !== shownRef.current) reloadSnapshot()
      })
      .catch(() => alive && setCount(0))
    return () => {
      alive = false
    }
  }, [slug, location.pathname, location.search, tick])
  return count
}
