import type { LeagueConfig } from '@shared/config/schema'
import { positionName, ratingKind, ratingSpacing } from '@shared/labels'
import type { RatingValue } from '@shared/setup'
import { normalized } from './value'

/**
 * The core roles a lineup needs, read from 2K's grades and the slots, so the
 * trade market notices when a deal leaves a team without one:
 * - a ball handler: a guard (PG or SG slot) with playmaking B+ or better, or
 *   an A playmaker at any position;
 * - a big for the rim and the boards: inside D or rebounding B+ or better;
 * - shooters to space the floor: 3pt B or better (two in the lineup space it);
 * - a perimeter stopper: perimeter D B+ or better.
 * A lineup is the team's top five by value. Grades are read on the league's
 * own scale (B+ is 85 on 2K's A+ 100 … F 40). A role the league's columns
 * can't tell (no playmaking rating, say) is never counted for or against.
 */

export const ROLES = ['handler', 'big', 'shooter', 'stopper'] as const
export type Role = (typeof ROLES)[number]

/** B+, B and A on 2K's scale, as shares of it (normalized grades). */
const GOOD = 0.75
const DECENT = 0.66
const ELITE = 0.9
/** Shooters a lineup needs to space the floor. */
export const SPACING = 2
/** What a GM makes of a role (utility): losing the only one is a clear penalty, filling a gap a smaller bonus. */
export const ROLE_LOSS = 1
export const ROLE_GAIN = 0.6

const GUARDS = new Set(['포인트 가드', '슈팅 가드', '가드', '콤보 가드'])

interface Columns {
  play: string[]
  big: string[]
  shoot: string[]
  stop: string[]
}
const columnsMemo = new WeakMap<LeagueConfig['ratings'], Columns>()

/** The rating columns that tell each role, by what they measure: the 3-point rating for spacing when there is one. */
function roleColumns(config: Pick<LeagueConfig, 'ratings'>): Columns {
  let cols = columnsMemo.get(config.ratings)
  if (!cols) {
    const ids = (pick: (c: LeagueConfig['ratings']['columns'][number]) => boolean) => config.ratings.columns.filter((c) => c.id !== config.ratings.overallColumnId && pick(c)).map((c) => c.id)
    const threes = ids((c) => ratingSpacing(c) === 'three')
    cols = {
      play: ids((c) => ratingKind(c) === 'play'),
      big: ids((c) => ratingKind(c) === 'rim' || ratingKind(c) === 'board'),
      shoot: threes.length > 0 ? threes : ids((c) => ratingSpacing(c) === 'outside'),
      stop: ids((c) => ratingKind(c) === 'perimeter'),
    }
    columnsMemo.set(config.ratings, cols)
  }
  return cols
}

/** The roles the league's ratings can tell at all. */
export function knownRoles(config: Pick<LeagueConfig, 'ratings'>): Role[] {
  const c = roleColumns(config)
  return ROLES.filter((r) => (r === 'handler' ? c.play : r === 'big' ? c.big : r === 'shooter' ? c.shoot : c.stop).length > 0)
}

/** The roles one player covers, from his grades and his slot (his position). */
export function playerRoles(config: Pick<LeagueConfig, 'ratings' | 'roster'>, slotId: string | null, ratings: Record<string, RatingValue>): Role[] {
  const c = roleColumns(config)
  const best = (ids: string[]) => Math.max(-1, ...ids.map((id) => normalized(config, id, ratings[id]) ?? -1))
  const slot = config.roster.slots.find((s) => s.id === slotId)
  const guard = slot ? GUARDS.has(positionName(slot.name)) : false
  const out: Role[] = []
  const play = best(c.play)
  if (play >= ELITE || (guard && play >= GOOD)) out.push('handler')
  if (best(c.big) >= GOOD) out.push('big')
  if (best(c.shoot) >= DECENT) out.push('shooter')
  if (best(c.stop) >= GOOD) out.push('stopper')
  return out
}

/** How many of a lineup cover each role. */
export type Cover = Record<Role, number>

export function coverOf(lineup: readonly { roles?: readonly Role[] }[]): Cover {
  const cover: Cover = { handler: 0, big: 0, shooter: 0, stopper: 0 }
  for (const p of lineup) for (const r of p.roles ?? []) cover[r]++
  return cover
}

/** Roles a lineup had and has no more, and gaps it filled (spacing: fewer or more of the shooters it needs). */
export function roleChanges(before: Cover, after: Cover, known: ReadonlySet<Role>): { lost: Role[]; filled: Role[] } {
  const lost: Role[] = []
  const filled: Role[] = []
  for (const r of ROLES) {
    if (!known.has(r)) continue
    const need = r === 'shooter' ? SPACING : 1
    if (Math.min(need, after[r]) < Math.min(need, before[r])) lost.push(r)
    else if (Math.min(need, after[r]) > Math.min(need, before[r])) filled.push(r)
  }
  return { lost, filled }
}

/**
 * What a deal's effect on a lineup's roles is worth to its GM (utility):
 * losing the only one covering a role costs ROLE_LOSS, filling a gap earns
 * ROLE_GAIN; a shooter short of spacing (or one more toward it) half that. A
 * defense-first GM (trait 1–5) weighs the big and the stopper more.
 */
export function fitValue(before: Cover, after: Cover, known: ReadonlySet<Role>, defenseFirst = 3): number {
  const defense = 1 + 0.25 * (defenseFirst - 3)
  let u = 0
  for (const r of ROLES) {
    if (!known.has(r)) continue
    const w = r === 'big' || r === 'stopper' ? defense : r === 'shooter' ? 0.5 : 1
    const need = r === 'shooter' ? SPACING : 1
    const change = Math.min(need, after[r]) - Math.min(need, before[r])
    u += change < 0 ? change * ROLE_LOSS * w : change * ROLE_GAIN * w
  }
  return u
}
