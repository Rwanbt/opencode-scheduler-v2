import { execFileSync } from "node:child_process"
import { existsSync, statSync, readdirSync } from "node:fs"
import path from "node:path"

type Resolver = (program: string, args: string[]) => string

export function windowsExecutable(
  name: string,
  override?: string,
  lookup: Resolver = (program, args) => execFileSync(program, args, { encoding: "utf8", windowsHide: true }),
  exists: (file: string) => boolean = (file) => existsSync(file) && statSync(file).isFile(),
): string {
  if (override) {
    if (!path.win32.isAbsolute(override) || !/\.exe$/i.test(override) || !exists(override)) {
      throw new Error(`Scheduler needs an existing absolute ${name}.exe, not a PATH shim`)
    }
    return override
  }
  let lines = ""
  try { lines = lookup("where.exe", [name]) } catch {}
  const resolved = lines.split(/\r?\n/).map((s) => s.trim()).find((s) =>
    path.win32.isAbsolute(s) && /\.exe$/i.test(s) && exists(s),
  )
  if (!resolved) throw new Error(`Windows scheduled jobs require an absolute ${name}.exe; set OPENCODE_SCHEDULER_${name.toUpperCase()}_PATH`)
  return resolved
}

export function windowsArgument(value: string): string {
  // Windows CommandLineToArgvW escaping: quotes and the backslashes preceding
  // them must be escaped, as must trailing backslashes before a closing quote.
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
}

export function windowsTaskAction(node: string, runner: string, job: string): string {
  if (![node, runner, job].every((value) => path.win32.isAbsolute(value))) {
    throw new Error("Windows task action requires absolute, verified paths")
  }
  const action = [node, runner, job].map(windowsArgument).join(" ")
  // schtasks.exe /TR is limited to 261 characters on some Windows versions.
  if (action.length > 260) throw new Error("Windows task action exceeds schtasks.exe /TR length; use a shorter installation path")
  return action
}

export function windowsOpenCodeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  lookup?: Resolver,
  exists?: (file: string) => boolean,
): string {
  // Overrides are always explicit and validated; never start a .cmd wrapper
  // from a noninteractive Task Scheduler process.
  const readable = exists ?? ((file: string) => existsSync(file) && statSync(file).isFile())
  if (env.OPENCODE_SCHEDULER_OPENCODE_PATH) {
    return windowsExecutable("opencode", env.OPENCODE_SCHEDULER_OPENCODE_PATH, lookup, readable)
  }
  try { return windowsExecutable("opencode", undefined, lookup, readable) } catch {}
  // Official Desktop installs a versioned native CLI outside the interactive
  // shell's PATH. Choose only when the installation is unambiguous.
  const base = env.APPDATA ? path.win32.join(env.APPDATA, "ai.opencode.desktop", "cli") : ""
  let candidates: string[] = []
  try {
    if (base) candidates = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.win32.join(base, entry.name, "opencode-cli.exe"))
      .filter(readable)
  } catch {}
  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) {
    throw new Error("Multiple OpenCode Desktop CLIs detected; set OPENCODE_SCHEDULER_OPENCODE_PATH explicitly")
  }
  throw new Error("No absolute OpenCode Windows CLI found; set OPENCODE_SCHEDULER_OPENCODE_PATH")
}