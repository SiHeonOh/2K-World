import { HashRouter, Route, Routes } from 'react-router'
import { RouteErrorBoundary } from './components/ErrorBoundary'
import { Shell } from './components/Shell'
import { AppSettings } from './screens/AppSettings'
import { Home } from './screens/Home'
import { LeagueLayout } from './screens/league/LeagueLayout'
import { EditRoom } from './screens/league/EditRoom'
import { LeagueSettings } from './screens/league/LeagueSettings'
import { Office } from './screens/league/Office'
import { Players } from './screens/league/Players'
import { RosterEditor } from './screens/league/RosterEditor'
import { TeamPage } from './screens/league/TeamPage'
import { PlayerPage } from './screens/league/PlayerPage'
import { Awards } from './screens/league/Awards'
import { Draft } from './screens/league/Draft'
import { Inbox } from './screens/league/Inbox'
import { Leaders } from './screens/league/Leaders'
import { Playoffs } from './screens/league/Playoffs'
import { Schedule } from './screens/league/Schedule'
import { Standings } from './screens/league/Standings'
import { Trades } from './screens/league/Trades'
import { GameDay } from './screens/league/GameDay'
import { Community } from './screens/league/Community'
import { LoreScreen } from './screens/league/lore/LoreScreen'
import { Wiki } from './screens/league/wiki/Wiki'
import { WarRoom } from './screens/league/WarRoom'
import { Wizard } from './screens/setup/Wizard'

export function App() {
  return (
    <HashRouter>
      <RouteErrorBoundary>
        <Routes>
          <Route
            path="/"
            element={
              <Shell>
                <Home />
              </Shell>
            }
          />
          <Route
            path="/settings"
            element={
              <Shell>
                <AppSettings />
              </Shell>
            }
          />
          <Route
            path="/setup"
            element={
              <Shell>
                <Wizard />
              </Shell>
            }
          />
          <Route path="/l/:slug" element={<LeagueLayout />}>
            <Route index element={<Office />} />
            <Route path="team/:teamId" element={<TeamPage />} />
            <Route path="player/:playerId" element={<PlayerPage />} />
            <Route path="players" element={<Players />} />
            <Route path="roster" element={<RosterEditor />} />
            <Route path="editroom" element={<EditRoom />} />
            <Route path="settings" element={<LeagueSettings />} />
            <Route path="schedule" element={<Schedule />} />
            <Route path="standings" element={<Standings />} />
            <Route path="leaders" element={<Leaders />} />
            <Route path="playoffs" element={<Playoffs />} />
            <Route path="trades" element={<Trades />} />
            <Route path="draft" element={<Draft />} />
            <Route path="awards" element={<Awards />} />
            <Route path="inbox" element={<Inbox />} />
            <Route path="gameday" element={<GameDay />} />
            <Route path="community" element={<Community />} />
            <Route path="lore" element={<LoreScreen />} />
            <Route path="wiki" element={<Wiki />} />
            <Route path="warroom" element={<WarRoom />} />
          </Route>
        </Routes>
      </RouteErrorBoundary>
    </HashRouter>
  )
}
