import type { RuleIssue } from '@shared/season'

/** The League engine refused a move. `issues` say why, as codes the screens translate. */
export class RuleError extends Error {
  constructor(readonly issues: RuleIssue[]) {
    super(`refused: ${issues.map((i) => i.code).join(', ')}`)
  }
}

export function refuse(code: string, params: RuleIssue['params'] = {}): never {
  throw new RuleError([{ code, params }])
}
