import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { TemplateListing } from '@shared/api'
import { parseTemplate, serializeTemplate, TEMPLATE_EXTENSION, type TemplateFile } from '@shared/template'
import { AppError } from './errors'

/**
 * Templates live in two places: built-in ones shipped in defaults/templates
 * (made-up examples only) and the user's own in <data folder>/templates.
 */
export class TemplateService {
  constructor(
    private readonly builtinDir: string,
    readonly userDir: string,
  ) {}

  list(): TemplateListing[] {
    return [...this.scan('builtin', this.builtinDir), ...this.scan('user', this.userDir)]
  }

  load(id: string): TemplateFile {
    const listing = this.list().find((t) => t.id === id)
    if (!listing) throw new AppError('not-found', `template ${id} not found`)
    return this.loadFile(join(listing.source === 'builtin' ? this.builtinDir : this.userDir, listing.fileName))
  }

  loadFile(file: string): TemplateFile {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (e) {
      throw new AppError('file-read', `can't read ${file}: ${(e as Error).message}`)
    }
    const result = parseTemplate(text)
    if (!result.ok) throw new AppError('bad-template', `bad template ${basename(file)}`, { templateError: result.error })
    return result.template
  }

  /** Saves into the user folder under a free name based on `baseName`; returns the path. */
  saveUser(template: TemplateFile, baseName: string): string {
    mkdirSync(this.userDir, { recursive: true })
    const safe = baseName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/[. ]+$/, '').trim() || 'template'
    let file = join(this.userDir, safe + TEMPLATE_EXTENSION)
    for (let n = 2; existsSync(file); n++) file = join(this.userDir, `${safe}-${n}${TEMPLATE_EXTENSION}`)
    writeFileSync(file, serializeTemplate(template), 'utf8')
    return file
  }

  private scan(source: 'builtin' | 'user', dir: string): TemplateListing[] {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith(TEMPLATE_EXTENSION))
      .sort()
      .map((fileName) => {
        const id = `${source}:${fileName}`
        const base = { id, source, fileName }
        try {
          const result = parseTemplate(readFileSync(join(dir, fileName), 'utf8'))
          if (!result.ok) {
            return { ...base, name: fileName, description: '', hasTeams: false, hasPlayers: false, error: result.error }
          }
          const t = result.template
          return {
            ...base,
            name: t.meta.name,
            description: t.meta.description,
            hasTeams: (t.teams?.length ?? 0) > 0,
            hasPlayers: (t.players?.length ?? 0) > 0,
          }
        } catch {
          return { ...base, name: fileName, description: '', hasTeams: false, hasPlayers: false, error: { code: 'not-json' } }
        }
      })
  }
}
