import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The writers' style guides, as editable text: `defaults/prompts/<name>.md`,
 * unless the league has its own `<league>/prompts/<name>.md`. Read at each
 * job, so an edit applies to the next one without a restart. Null when
 * neither file is there (the job then uses its built-in guide).
 */
export type PromptName = 'community' | 'wiki' | 'lore' | 'gm' | 'player'

export function loadPrompt(name: PromptName, leagueFolder: string | null, defaultsDir: string): string | null {
  const candidates = [...(leagueFolder ? [join(leagueFolder, 'prompts', `${name}.md`)] : []), join(defaultsDir, 'prompts', `${name}.md`)]
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue
      const text = readFileSync(file, 'utf8').replace(/^﻿/, '').trim()
      if (text) return text
    } catch {
      // Unreadable (locked mid-save): try the next one.
    }
  }
  return null
}
