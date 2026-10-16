import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as XLSX from 'xlsx'
import type { ExportLabels, ExportScope } from '@shared/api'
import { awardTitle, periodLabel } from '@shared/awards'
import { seasonTotals } from '@core/stats'
import type { Db } from '@data/db'
import { currentSeason, listPlayers, listSeasons, listTeams, loadConfig } from '@data/league'
import { listAwards, listCards, listDraftActions, listTrades } from '@data/moves'
import { listGames, playoffsView, seasonBoxLines, standings } from '@data/season'

/** A season as the export labels its rows. */
type Season = { id: number; label: string }

const pad2 = (n: number) => String(n).padStart(2, '0')

/** A stored time (ISO, UTC) as this PC's calendar date: a trade made at 8am in Korea is that day, not the day before. */
export function localDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** Now, in local time, for file names: 2026-10-11-08-05-00. */
export function localStamp(ms = Date.now()): string {
  const d = new Date(ms)
  return `${localDate(d.toISOString())}-${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`
}

/**
 * Writes the league to an .xlsx in <league>/exports: rosters, results,
 * standings, playoffs, player stats, trades, cards, the draft log and
 * awards. Labels come from the renderer's language file; missing ones fall
 * back to their keys.
 *
 * `scope: 'all'` puts every season in each season's sheet, with the season
 * first on every row. Rosters stay as they are now (past rosters aren't
 * stored), and their sheet name says so.
 */
export function exportLeague(db: Db, leagueFolder: string, slug: string, labels: ExportLabels, scope: ExportScope = 'current'): string {
  const L = (key: string) => labels[key] ?? key
  const { config } = loadConfig(db)
  const all = scope === 'all'
  const seasons: Season[] = all ? listSeasons(db) : [currentSeason(db)]
  const teams = listTeams(db)
  const players = listPlayers(db)
  const teamName = new Map(teams.map((t) => [t.id, t.shortName]))
  const playerName = new Map(players.map((p) => [p.id, p.name]))
  const slotName = new Map(config.roster.slots.map((s) => [s.id, s.name]))
  const divisionName = new Map(config.structure.divisions.map((d) => [d.id, d.name]))
  const wb = XLSX.utils.book_new()
  // Excel sheet names: at most 31 characters, none of : \ / ? * [ ], and unique.
  const used = new Set<string>()
  const add = (name: string, rows: unknown[][]) => {
    const base = name.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 28) || 'Sheet'
    let sheet = base
    for (let n = 2; used.has(sheet.toLowerCase()); n++) sheet = `${base} ${n}`
    used.add(sheet.toLowerCase())
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheet)
  }
  /** One sheet's rows for every season exported: with all seasons, each row starts with its season. */
  const perSeason = (header: unknown[], rowsOf: (season: Season) => unknown[][]): unknown[][] => [
    all ? [L('season'), ...header] : header,
    ...seasons.flatMap((s) => rowsOf(s).map((row) => (all ? [s.label, ...row] : row))),
  ]

  add(L(all ? 'rostersNow' : 'rosters'), [
    [L('team'), L('division'), L('name'), L('slot'), L('height'), ...config.ratings.columns.map((c) => c.name), L('nicknames'), L('notes')],
    ...players.map((p) => [
      teamName.get(p.teamId),
      divisionName.get(teams.find((t) => t.id === p.teamId)?.divisionId ?? ''),
      p.name,
      slotName.get(p.slotId ?? '') ?? '',
      p.height,
      ...config.ratings.columns.map((c) => p.ratings[c.id] ?? ''),
      p.nicknames.join(', '),
      p.notes,
    ]),
  ])

  add(
    L('results'),
    perSeason([L('stage'), L('round'), L('home'), L('homeScore'), L('awayScore'), L('away'), L('status')], (s) =>
      listGames(db, s.id).map((g) => [L(g.stage), g.round, teamName.get(g.home), g.homeScore ?? '', g.awayScore ?? '', teamName.get(g.away), L(g.status)]),
    ),
  )

  add(
    L('standings'),
    perSeason(
      [L('rank'), L('team'), L('wins'), L('losses'), L('pct'), L('gamesBehind'), L('pointsFor'), L('pointsAgainst'), L('streak')],
      (s) =>
        standings(db, s.id).overall.map((l, i) => [
          i + 1,
          teamName.get(l.teamId),
          l.wins,
          l.losses,
          Number(l.pct.toFixed(3)),
          l.gamesBehind,
          l.pointsFor,
          l.pointsAgainst,
          l.streak,
        ]),
    ),
  )

  const playoffs = perSeason([L('stage'), L('round'), L('slot'), L('high'), L('highWins'), L('lowWins'), L('low'), L('winner')], (s) =>
    playoffsView(db, s.id).series.map((x) => [
      L(x.stage),
      x.round,
      x.slot,
      x.high ? teamName.get(x.high) : '',
      x.highWins,
      x.lowWins,
      x.low ? teamName.get(x.low) : '',
      x.winner ? teamName.get(x.winner) : '',
    ]),
  )
  if (playoffs.length > 1) add(L('playoffs'), playoffs)

  // Per-game averages from the regular season's box lines; his team is the one he last played for that season.
  const columns = config.stats.columns
  const stats = perSeason([L('team'), L('name'), L('games'), ...columns.map((c) => c.name)], (s) =>
    [...seasonTotals(seasonBoxLines(db, s.id)).values()]
      .map((p) => ({ team: teamName.get(p.teamId) ?? '', name: playerName.get(p.playerId) ?? '', p }))
      .sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name))
      .map(({ team, name, p }) => [team, name, p.games, ...columns.map((c) => Number(((p.totals[c.id] ?? 0) / p.games).toFixed(1)))]),
  )
  if (stats.length > 1) add(L('stats'), stats)

  // A season's cards include the ones it carried over (marked so). Numbers restart each season, so a card
  // named in another season than the one that issued it says which: "가람고 #1 (시즌 1)".
  const cardsBySeason = new Map(seasons.map((s) => [s.id, listCards(db, s.id)]))
  const seasonLabel = new Map(listSeasons(db).map((s) => [s.id, s.label]))
  const cardText = (c: { originalTeamId: string; number: number; issuedSeasonId: number }, seasonId: number) =>
    `${teamName.get(c.originalTeamId)} #${c.number}${c.issuedSeasonId === seasonId ? '' : ` (${seasonLabel.get(c.issuedSeasonId) ?? c.issuedSeasonId})`}`
  const cardIn = (seasonId: number, id: number | null) => {
    const card = id === null ? undefined : cardsBySeason.get(seasonId)?.find((c) => c.id === id)
    return card ? cardText(card, seasonId) : ''
  }
  add(
    L('trades'),
    perSeason([L('date'), L('phase'), L('status'), L('from'), L('to'), L('player'), L('card')], (s) =>
      listTrades(db, s.id).flatMap((t) =>
        t.items.map((i) => [
          localDate(t.createdAt),
          L(t.phase),
          L(t.status),
          teamName.get(i.from),
          teamName.get(i.to),
          i.playerId ? playerName.get(i.playerId) : '',
          i.card ? cardText(i.card, s.id) : '',
        ]),
      ),
    ),
  )

  if ([...cardsBySeason.values()].some((c) => c.length > 0)) {
    add(
      L('cards'),
      perSeason([L('card'), L('owner'), L('status')], (s) =>
        (cardsBySeason.get(s.id) ?? []).map((c) => [
          cardText(c, s.id),
          teamName.get(c.ownerTeamId),
          c.carriedTo === null ? L(c.status) : `${L('carried')} → ${seasonLabel.get(c.carriedTo) ?? c.carriedTo}`,
        ]),
      ),
    )
    add(
      L('draft'),
      perSeason([L('seq'), L('team'), L('kind'), L('card'), L('player'), L('target')], (s) =>
        listDraftActions(db, s.id).map((a) => [
          a.seq,
          teamName.get(a.teamId),
          L(a.kind),
          cardIn(s.id, a.cardId),
          a.playerId ? playerName.get(a.playerId) : '',
          a.targetPlayerId ? playerName.get(a.targetPlayerId) : '',
        ]),
      ),
    )
  }

  // His team is the one he won it for, kept with the award. The award is named with its group ("동부 이주의 선수"),
  // and its period said the way screens say it (3주차, 11월), never as its code.
  add(
    L('awards'),
    perSeason([L('award'), L('period'), L('teamRank'), L('player'), L('team')], (s) =>
      listAwards(db, s.id, config).map((a) => [
        awardTitle(config, { awardId: a.awardId, group: a.group }),
        periodLabel(a.period),
        a.teamRank,
        playerName.get(a.playerId),
        teamName.get(a.teamId) ?? '',
      ]),
    ),
  )

  const dir = join(leagueFolder, 'exports')
  mkdirSync(dir, { recursive: true })
  const stamp = localStamp()
  const name = all ? `${slug}-all-${stamp}` : `${slug}-${stamp}`
  let file = join(dir, `${name}.xlsx`)
  for (let n = 2; existsSync(file); n++) file = join(dir, `${name}-${n}.xlsx`)
  writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer)
  return file
}
