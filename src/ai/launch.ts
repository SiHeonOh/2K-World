import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * How to start `claude` without a shell. cmd.exe would parse every argument
 * a second time (quotes, &, %, and an 8191-character line limit), so an npm
 * `claude.cmd` shim is never run: it's read for the program it starts.
 */
export interface Launch {
  /** An executable, never a .cmd/.bat file. */
  file: string
  /** Leading arguments, e.g. the cli.js script when the shim runs node. */
  args: string[]
}

const SHIM_TARGET = /"%~?dp0%?\\?([^"%]+?\.(?:exe|js|mjs|cjs))"/gi

/** The launch for a found command, or null when it can't be started safely. */
export function resolveLaunch(command: string, findNode: () => string | null = () => onPath('node')): Launch | null {
  if (!/\.(cmd|bat)$/i.test(command)) return { file: command, args: [] }
  let text: string
  try {
    text = readFileSync(command, 'utf8')
  } catch {
    return null
  }
  const dir = dirname(command)
  const targets = [...text.matchAll(SHIM_TARGET)].map((m) => resolve(dir, m[1]!))
  const exe = targets.find((t) => /\.exe$/i.test(t) && !/[\\/]node\.exe$/i.test(t) && existsSync(t))
  if (exe) return { file: exe, args: [] }
  const script = targets.find((t) => /\.[mc]?js$/i.test(t) && existsSync(t))
  if (!script) return null
  // npm shims prefer a node.exe next to them, then node on PATH.
  const local = join(dir, 'node.exe')
  const node = existsSync(local) ? local : findNode()
  return node ? { file: node, args: [script] } : null
}

/** The first executable of that name on PATH. */
function onPath(name: string): string | null {
  const win = process.platform === 'win32'
  for (const d of (process.env.PATH ?? '').split(win ? ';' : ':').filter(Boolean)) {
    const candidate = join(d, win ? `${name}.exe` : name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Variables that would make Claude Code bill per use (an API key, a token, a
 * cloud provider or another endpoint). They're removed, so it can only use
 * the subscription sign-in.
 */
export const PER_USE_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]

export function subscriptionEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env }
  for (const key of Object.keys(out)) if (PER_USE_ENV.includes(key.toUpperCase())) delete out[key]
  return out
}

/** Starts the launch with no shell and no per-use credentials; arguments reach the program exactly as given. */
export function start(launch: Launch, args: string[], options: SpawnOptions = {}): ChildProcess {
  return spawn(launch.file, [...launch.args, ...args], { windowsHide: true, ...options, env: subscriptionEnv(options.env ?? process.env), shell: false })
}

/** Ends a process and everything it started (taskkill /T on Windows). */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid !== undefined) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
      // Already gone: nothing more to do.
    })
  } else {
    child.kill('SIGKILL')
  }
}
