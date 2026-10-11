import { isMap, isSeq, LineCounter, parseDocument, type Node } from 'yaml'
import { z } from 'zod'
import { MOOD_PARTS, type LoreErrorCode } from '@shared/lore'

/**
 * One lore file: a YAML settings block between `---` lines, then prose split
 * by heading into 공개 (everyone), 소문 (rumor) and 비밀 (only the player).
 * The files are the source of truth; the app only reads them.
 */

export type LoreKind = 'player' | 'team' | 'gm' | 'world'
export type Visibility = 'public' | 'rumor' | 'secret'

const level = z.number().int().min(1).max(5)
/** An empty YAML key (every example line commented out) reads as null: treat it as empty. */
const list = <T extends z.ZodType>(item: T) => z.array(item).nullish().transform((v) => v ?? [])

// Loose: keys the app doesn't know (a note, say) are kept, so editing a list never drops them.
const relationship = z.looseObject({
  with: z.string().min(1),
  type: z.enum(['friend', 'rival', 'family', 'mentor', 'dislikes']),
  strength: level,
  visibility: z.enum(['public', 'rumor', 'secret']),
})

const moodComponent = z.enum(MOOD_PARTS)

const hook = z.looseObject({
  when: z.string().min(1),
  rival: z.string().optional(),
  // Only the mood parts the hook changes.
  mood: z.partialRecord(moodComponent, z.number().min(-100).max(100)),
})

export const playerLoreSchema = z.object({
  id: z.string().min(1),
  traits: z
    .object({
      ego: level.default(3),
      usage: level.default(3),
      competitiveness: level.default(3),
      loyalty: level.default(3),
      temperament: level.default(3),
      professionalism: level.default(3),
      ambition: level.default(3),
    })
    .default({ ego: 3, usage: 3, competitiveness: 3, loyalty: 3, temperament: 3, professionalism: 3, ambition: 3 }),
  media: z.enum(['quiet', 'normal', 'outspoken']).default('normal'),
  relationships: list(relationship),
  hooks: list(hook),
  canon: z.boolean().default(true),
})

export const teamLoreSchema = z.object({
  id: z.string().min(1),
  colors: list(z.string().regex(/^#[0-9a-fA-F]{6}$/)),
  fans: z.object({ size: level.default(3), temperament: level.default(3), pride: level.default(3) }).default({ size: 3, temperament: 3, pride: 3 }),
  rivals: list(z.string().min(1)),
  canon: z.boolean().default(true),
})

export const gmLoreSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullish().transform((v) => v ?? null),
  team: z.string().min(1),
  philosophy: z.enum(['win-now', 'balanced', 'development']).default('balanced'),
  traits: z
    .object({
      risk: level.default(3),
      patience: level.default(3),
      loyalty: level.default(3),
      star_chasing: level.default(3),
      defense_first: level.default(3),
      regional_pride: level.default(3),
      ego: level.default(3),
    })
    .default({ risk: 3, patience: 3, loyalty: 3, star_chasing: 3, defense_first: 3, regional_pride: 3, ego: 3 }),
  negotiation: z.enum(['fair', 'hardball', 'bluffer', 'pushover']).default('fair'),
  relationships: list(relationship),
  canon: z.boolean().default(true),
})

export const worldLoreSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['topic', 'event', 'place', 'rivalry']).default('topic'),
  date: z
    .union([z.string(), z.date()])
    .nullish()
    .transform((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v ?? null))),
  involves: list(z.string().min(1)),
  canon: z.boolean().default(true),
})

const SCHEMAS = { player: playerLoreSchema, team: teamLoreSchema, gm: gmLoreSchema, world: worldLoreSchema }

/** The settings schema for one kind of file. */
export const loreSchemaOf = (kind: LoreKind) => SCHEMAS[kind]

export type PlayerLore = z.infer<typeof playerLoreSchema>
export type TeamLore = z.infer<typeof teamLoreSchema>
export type GmLore = z.infer<typeof gmLoreSchema>
export type WorldLore = z.infer<typeof worldLoreSchema>

export interface LoreSections {
  public: string
  rumor: string
  secret: string
}

export type LoreEntry =
  | { kind: 'player'; file: string; team: string; settings: PlayerLore; sections: LoreSections }
  | { kind: 'team'; file: string; team: string; settings: TeamLore; sections: LoreSections }
  | { kind: 'gm'; file: string; team: string; settings: GmLore; sections: LoreSections }
  | { kind: 'world'; file: string; team: null; settings: WorldLore; sections: LoreSections }

/** What went wrong, as a code the screen translates; `message` is the raw detail (English, from the parser or the file system). */
export interface LoreError {
  file: string
  /** 1-based; 0 when the problem isn't tied to a line. */
  line: number
  code: LoreErrorCode
  /** 'field': the setting's path, e.g. traits.usage ('' for the block as a whole). */
  field?: string
  message: string
}

/**
 * Which section a heading opens. Secret wins: any heading that mentions 비밀
 * is secret, whatever else it says. Any other heading (the title, a note)
 * closes the current section, so its text goes nowhere.
 */
export function sectionOf(heading: string): keyof LoreSections | null {
  if (heading.includes('비밀')) return 'secret'
  if (heading.includes('소문')) return 'rumor'
  if (heading.includes('공개')) return 'public'
  return null
}

/** `## 공개`, `##공개`, `   ### 공개 ##`: any ATX heading, space optional. */
export const ATX = /^ {0,3}#{1,6}(?:[ \t]+|(?=[^#\s]))(.*?)(?:[ \t]+#+)?[ \t]*$|^ {0,3}#{1,6}[ \t]*$/
/** A setext underline (`===` or `---`) under a text line makes that line a heading. */
export const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/

/**
 * Splits the prose after the settings block into 공개, 소문 and 비밀 by
 * headings, in any Markdown heading style. Hint comments are dropped. Text
 * outside those three sections is ignored, so secret text can only ever land
 * in `secret`.
 */
export function splitSections(body: string): LoreSections {
  const out: LoreSections = { public: '', rumor: '', secret: '' }
  let current: keyof LoreSections | null = null
  const lines: Record<keyof LoreSections, string[]> = { public: [], rumor: [], secret: [] }
  const all = body.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)
  for (let i = 0; i < all.length; i++) {
    const line = all[i]!
    const atx = line.match(ATX)
    if (atx) {
      current = sectionOf(atx[1] ?? '')
      continue
    }
    const next = all[i + 1]
    if (line.trim() !== '' && next !== undefined && SETEXT.test(next)) {
      current = sectionOf(line)
      i++
      continue
    }
    if (current) lines[current].push(line)
  }
  for (const k of Object.keys(lines) as (keyof LoreSections)[]) out[k] = lines[k].join('\n').trim()
  return out
}

/** Which kind a file is, from where it sits: teams/<team>/<team>.md, "<team> 단장.md", a player, or world/. */
export function kindOf(relPath: string): { kind: LoreKind; team: string | null } | null {
  const parts = relPath.replace(/\\/g, '/').split('/')
  const name = parts.at(-1)!.replace(/\.md$/i, '')
  if (parts[0] === 'world' && parts.length === 2) return { kind: 'world', team: null }
  if (parts[0] === 'teams' && parts.length === 3) {
    const team = parts[1]!
    if (name === team) return { kind: 'team', team }
    if (name === `${team} 단장`) return { kind: 'gm', team }
    return { kind: 'player', team }
  }
  return null
}

/** The settings block: `---` lines (trailing spaces allowed), the closing one ending its line. */
export const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/

/** Parses one lore file. Errors point to the file and line. */
export function parseLoreFile(relPath: string, text: string): { entry: LoreEntry | null; errors: LoreError[] } {
  const where = kindOf(relPath)
  const errors: LoreError[] = []
  if (!where) return { entry: null, errors: [{ file: relPath, line: 0, code: 'not-in-folder', message: 'not in teams/<학교>/ or world/' }] }
  const m = text.replace(/^﻿/, '').match(FRONTMATTER)
  if (!m) return { entry: null, errors: [{ file: relPath, line: 1, code: 'no-settings', message: 'missing the --- settings block at the top' }] }
  const yamlText = m[1]!
  const body = m[2]!
  const counter = new LineCounter()
  const doc = parseDocument(yamlText, { lineCounter: counter, prettyErrors: false })
  // The settings block starts on line 2 of the file.
  const lineOf = (offset: number) => counter.linePos(offset).line + 1
  for (const e of doc.errors) errors.push({ file: relPath, line: lineOf(e.pos[0]), code: 'yaml', message: e.message.split('\n')[0]! })
  if (errors.length > 0) return { entry: null, errors }

  const parsed = SCHEMAS[where.kind].safeParse(doc.toJS() ?? {})
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const node = nodeAt(doc.contents, issue.path)
      errors.push({
        file: relPath,
        line: node?.range ? lineOf(node.range[0]) : 1,
        code: 'field',
        field: issue.path.map(String).join('.'),
        message: issue.message,
      })
    }
    return { entry: null, errors }
  }
  const sections = splitSections(body)
  return { entry: { kind: where.kind, file: relPath, team: where.team, settings: parsed.data, sections } as LoreEntry, errors }
}

/** The YAML node at a path, falling back to the deepest node that exists. */
function nodeAt(root: unknown, path: PropertyKey[]): Node | null {
  let node = root as Node | null
  for (const key of path) {
    if (isMap(node)) {
      const pair = node.items.find((p) => (p.key as { value?: unknown } | null)?.value === key)
      if (!pair) return node
      node = (pair.value as Node | null) ?? (pair.key as Node)
    } else if (isSeq(node) && typeof key === 'number') {
      const next = node.items[key] as Node | undefined
      if (!next) return node
      node = next
    } else {
      return node
    }
  }
  return node
}

/** A player file's name is the display name; same-name players carry their first team: 김하람(한빛고). */
export function playerNameOf(relPath: string): { name: string; originalTeam: string | null } {
  const base = relPath.replace(/\\/g, '/').split('/').at(-1)!.replace(/\.md$/i, '')
  const m = base.match(/^(.+?)\((.+)\)$/)
  return m ? { name: m[1]!, originalTeam: m[2]! } : { name: base, originalTeam: null }
}
