import type { ApiErrorShape, ErrorCode } from '@shared/api'
import { knownErrorCode } from '@shared/dbErrors'
import type { SetupIssue } from '@shared/setup'
import type { RuleIssue } from '@shared/season'
import type { TemplateError } from '@shared/template'

/** An error meant for the renderer: its code is shown as a translated message. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: { issues?: SetupIssue[]; templateError?: TemplateError; rules?: RuleIssue[] } = {},
  ) {
    super(message)
  }

  toShape(): ApiErrorShape {
    return { code: this.code, message: this.message, ...this.extra }
  }
}

/**
 * What a failed call sends the renderer: an AppError as it is; a database or
 * disk error the user can act on (a league from a newer app, a full disk…)
 * by its own code, so it's shown in Korean; anything else as 'internal'.
 * The original text stays in `message` for the details.
 */
export function errorShape(e: unknown): ApiErrorShape {
  if (e instanceof AppError) return e.toShape()
  const message = e instanceof Error ? e.message : String(e)
  // node:sqlite puts SQLite's own words in errstr ("constraint failed", "database is locked").
  const errstr = e !== null && typeof e === 'object' && typeof (e as { errstr?: unknown }).errstr === 'string' ? (e as { errstr: string }).errstr : ''
  return { code: knownErrorCode(`${message}\n${errstr}`) ?? 'internal', message }
}
