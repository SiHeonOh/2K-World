import type { ReactNode } from 'react'
import { NavLink, useMatch } from 'react-router'
import { t } from '../i18n'

interface NavItem {
  path: string
  label: string
  end?: boolean
  /** Roadmap phase that builds it; 0 = available now. */
  phase: number
}

const LEAGUE_NAV: { group?: string; items: NavItem[] }[] = [
  {
    group: t.nav.officeGroup,
    items: [
      { path: '', label: t.nav.office, end: true, phase: 0 },
      { path: 'gameday', label: t.nav.gameday, phase: 0 },
      { path: 'schedule', label: t.nav.schedule, phase: 0 },
      { path: 'standings', label: t.nav.standings, phase: 0 },
      { path: 'leaders', label: t.nav.leaders, phase: 0 },
      { path: 'roster', label: t.roster.nav, phase: 0 },
      { path: 'playoffs', label: t.nav.playoffs, phase: 0 },
      { path: 'trades', label: t.nav.trades, phase: 0 },
      { path: 'warroom', label: t.nav.warroom, phase: 0 },
      { path: 'draft', label: t.nav.draft, phase: 0 },
      { path: 'awards', label: t.nav.awards, phase: 0 },
      { path: 'inbox', label: t.nav.inbox, phase: 0 },
    ],
  },
  {
    group: t.nav.storyGroup,
    items: [
      { path: 'community', label: t.nav.community, phase: 0 },
      { path: 'wiki', label: t.nav.wiki, phase: 0 },
      { path: 'lore', label: t.nav.lore, phase: 0 },
    ],
  },
  { items: [{ path: 'editroom', label: t.nav.editroom, phase: 0 }] },
]

/** `badges`: a count shown next to a league nav item, by its path (e.g. inbox: things waiting for you). */
export function Shell({ leagueName, badges, children }: { leagueName?: string | null; badges?: Record<string, number>; children: ReactNode }) {
  const match = useMatch('/l/:slug/*')
  const slug = match?.params.slug
  const cls = ({ isActive }: { isActive: boolean }) => `item${isActive ? ' active' : ''}`
  return (
    <div className="shell">
      <nav className="nav">
        <NavLink to="/" className="nav-brand">
          <span className="ball" />
          {t.app.name}
        </NavLink>
        <NavLink to="/" end className={cls}>
          {t.nav.leagues}
        </NavLink>
        <NavLink to="/setup" className={cls}>
          {t.nav.newLeague}
        </NavLink>
        {slug ? (
          <>
            <div className="nav-league">
              <div className="label">{slug}</div>
              <div className="name">{leagueName ?? ''}</div>
            </div>
            {LEAGUE_NAV.map((section, i) => (
              <div key={i} className="nav-section">
                {section.group ? <div className="nav-group">{section.group}</div> : null}
                {section.items.map((item) => (
                  // No trailing slash for the office, or it isn't highlighted on /l/slug.
                  <NavLink
                    key={item.path}
                    to={`/l/${encodeURIComponent(slug)}${item.path ? `/${item.path}` : ''}`}
                    end={item.end}
                    className={cls}
                  >
                    <span>{item.label}</span>
                    {item.phase > 0 ? <span className="soon">{t.nav.phase(item.phase)}</span> : null}
                    {badges?.[item.path] ? <span className="nav-badge">{badges[item.path]}</span> : null}
                  </NavLink>
                ))}
              </div>
            ))}
          </>
        ) : null}
        <div className="spacer" />
        <NavLink to="/settings" className={cls}>
          {t.nav.appSettings}
        </NavLink>
      </nav>
      <main className="main">{children}</main>
    </div>
  )
}
