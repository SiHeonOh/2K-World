import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { ClaudeStatus } from '@shared/ai'
import { killTree, resolveLaunch, start, type Launch } from './launch'

export type { ClaudeStatus }

/** Finds the claude command: the native installer's claude.exe first, then whatever is on PATH. */
export async function findClaude(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const home = env.USERPROFILE ?? env.HOME ?? ''
  for (const candidate of [join(home, '.local', 'bin', 'claude.exe'), join(home, '.local', 'bin', 'claude')]) {
    if (home && existsSync(candidate)) return candidate
  }
  const finder = process.platform === 'win32' ? 'where.exe' : 'which'
  return new Promise((resolve) => {
    execFile(finder, ['claude'], { windowsHide: true, env }, (err, stdout) => {
      if (err) return resolve(null)
      const first = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        // On Windows prefer .exe, then .cmd (read, never run); skip the extension-less npm shim.
        .sort((a, b) => rank(a) - rank(b))[0]
      resolve(first ?? null)
    })
  })
}

const rank = (p: string) => (/\.exe$/i.test(p) ? 0 : /\.cmd$/i.test(p) ? 1 : process.platform === 'win32' ? 2 : 0)

function run(launch: Launch, args: string[], timeoutMs = 20_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = start(launch, args)
    } catch (e) {
      resolve({ code: -1, stdout, stderr: e instanceof Error ? e.message : String(e) })
      return
    }
    // If even the kill doesn't end it, give up waiting a few seconds later.
    const timer = setTimeout(() => {
      killTree(child)
      setTimeout(() => resolve({ code: -1, stdout, stderr: `timed out after ${timeoutMs} ms` }), 3000).unref()
    }, timeoutMs)
    child.stdout?.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

export interface ClaudeCheck {
  status: ClaudeStatus
  /** How to start it; null when it isn't installed or can't be started without a shell. */
  launch: Launch | null
}

const notInstalled = (command: string | null, detail?: string): ClaudeCheck => ({
  status: { installed: false, command, version: null, loggedIn: false, authMethod: null, ...(detail ? { detail } : {}) },
  launch: null,
})

/** `claude --version` and `claude auth status`, read without starting a session. */
export async function checkClaude(command: string | null): Promise<ClaudeCheck> {
  if (!command) return notInstalled(null)
  const launch = resolveLaunch(command)
  if (!launch) return notInstalled(command, `${command} could not be started without cmd.exe; install Claude Code with the native installer`)
  const version = await run(launch, ['--version'])
  if (version.code !== 0) return notInstalled(command, version.stderr || version.stdout)
  const status = await run(launch, ['auth', 'status'])
  let authMethod: string | null = null
  let loggedInFlag: boolean | null = null
  try {
    const json = JSON.parse(status.stdout) as { authMethod?: unknown; loggedIn?: unknown }
    authMethod = typeof json.authMethod === 'string' ? json.authMethod : null
    loggedInFlag = typeof json.loggedIn === 'boolean' ? json.loggedIn : null
  } catch {
    authMethod = null
  }
  // Exit 0 means signed in; authMethod 'none' or loggedIn false means not.
  const loggedIn = status.code === 0 && authMethod !== 'none' && loggedInFlag !== false
  return {
    status: {
      installed: true,
      command,
      version: version.stdout.trim().split(/\s+/)[0] ?? null,
      loggedIn,
      authMethod,
      ...(status.code !== 0 ? { detail: (status.stderr || status.stdout).slice(0, 1000) } : {}),
    },
    launch,
  }
}

/** Sign-ins that use the Claude subscription. Anything else (API keys, cloud providers, unknown) may bill per use. */
export const SUBSCRIPTION_AUTH = ['claude.ai', 'oauth_token']

export const usesSubscription = (s: ClaudeStatus) => s.authMethod !== null && SUBSCRIPTION_AUTH.includes(s.authMethod)

/** True when Claude is signed in some other way than the subscription, so jobs must not run. */
export const billsPerUse = (s: ClaudeStatus) => s.loggedIn && !usesSubscription(s)
