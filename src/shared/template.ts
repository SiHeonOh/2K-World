import { z } from 'zod'
import { leagueConfigSchema } from './config/schema'
import { migrateConfig, MigrationError } from './config/migrations'
import { importMappingSchema } from './import'
import { playerSchema, teamSchema } from './setup'

/**
 * Template file: a league's config, optionally with its teams, players and
 * the spreadsheet column matching. JSON, so it can be shared and diffed.
 *
 * `formatVersion` covers the envelope; `config.version` covers the config
 * itself and is migrated separately.
 */
export const TEMPLATE_FORMAT = '2k-world-template'
export const TEMPLATE_FORMAT_VERSION = 1
export const TEMPLATE_EXTENSION = '.template.json'

export const templateMetaSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(2000),
  exportedAt: z.string(),
  appVersion: z.string(),
})

export const templateFileSchema = z.object({
  format: z.literal(TEMPLATE_FORMAT),
  formatVersion: z.literal(TEMPLATE_FORMAT_VERSION),
  meta: templateMetaSchema,
  config: leagueConfigSchema,
  teams: z.array(teamSchema).optional(),
  players: z.array(playerSchema).optional(),
  importMapping: importMappingSchema.optional(),
})

export type TemplateFile = z.infer<typeof templateFileSchema>
export type TemplateMeta = z.infer<typeof templateMetaSchema>

export type TemplateError =
  | { code: 'not-json' }
  | { code: 'not-a-template' }
  | { code: 'too-new'; version: number }
  | { code: 'migration'; detail: string }
  | { code: 'invalid'; issues: { path: string; message: string }[] }

export type TemplateParseResult = { ok: true; template: TemplateFile } | { ok: false; error: TemplateError }

/** Parses, migrates and validates a template file's text. */
export function parseTemplate(text: string): TemplateParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: { code: 'not-json' } }
  }
  if (typeof raw !== 'object' || raw === null || (raw as { format?: unknown }).format !== TEMPLATE_FORMAT) {
    return { ok: false, error: { code: 'not-a-template' } }
  }
  const envelope = raw as Record<string, unknown>
  const formatVersion = envelope.formatVersion
  if (typeof formatVersion === 'number' && formatVersion > TEMPLATE_FORMAT_VERSION) {
    return { ok: false, error: { code: 'too-new', version: formatVersion } }
  }
  // Envelope migrations go here when TEMPLATE_FORMAT_VERSION goes up.

  try {
    envelope.config = migrateConfig(envelope.config)
  } catch (e) {
    if (e instanceof MigrationError && e.code === 'too-new') {
      return { ok: false, error: { code: 'too-new', version: e.version ?? 0 } }
    }
    return { ok: false, error: { code: 'migration', detail: e instanceof Error ? e.message : String(e) } }
  }

  const parsed = templateFileSchema.safeParse(envelope)
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'invalid',
        issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    }
  }
  return { ok: true, template: parsed.data }
}

export function serializeTemplate(template: TemplateFile): string {
  return JSON.stringify(template, null, 2) + '\n'
}
