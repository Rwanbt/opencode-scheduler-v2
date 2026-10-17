import path from "node:path"
import { realpathSync } from "node:fs"

const sameDirectory = (left: string, right: string): boolean => {
  // A lexical comparison is insufficient: junctions/symlinks can point to a
  // foreign workspace even when the submitted path looks like this project.
  const a = realpathSync(left)
  const b = realpathSync(right)
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

// The model is not a privilege authority. Restrict all job-mutating tools to
// the project whose registry instance was created by OpenCode.
export function assertProjectToolScope(name: string, args: unknown, project: string): void {
  if (!path.isAbsolute(project)) throw new Error("Scheduler host has no absolute project authority")
  try { realpathSync(project) } catch { throw new Error("Scheduler project is no longer reachable") }
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid Scheduler tool input")
  const input = args as Record<string, unknown>
  if (name === "cleanup_global") {
    throw new Error("Global scheduler cleanup is not exposed through the native project-scoped plugin")
  }
  // Legacy and global enumeration can leak other projects' scheduled prompts.
  if (("allScopes" in input && input.allScopes !== false) ||
      ("includeLegacy" in input && input.includeLegacy !== false)) {
    throw new Error("Cross-project scheduler access is prohibited")
  }
  for (const key of ["workdir", "scopeRoot", "directory", "rootDir"]) {
    const value = input[key]
    if (value === undefined) continue
    let allowed = false
    try { allowed = typeof value === "string" && path.isAbsolute(value) && sameDirectory(value, project) }
    catch { allowed = false }
    if (!allowed) {
      throw new Error(`Scheduler ${name} cannot act outside the active project (${key})`)
    }
  }
  if ((name === "schedule_job" || name === "update_job") && "timeoutSeconds" in input &&
      (typeof input.timeoutSeconds !== "number" || !Number.isSafeInteger(input.timeoutSeconds) ||
       input.timeoutSeconds < 1 || input.timeoutSeconds > 3600)) {
    throw new Error("Unattended Scheduler timeout must be 1–3600 seconds; zero/unbounded execution is denied")
  }
}
