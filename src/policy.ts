import path from "node:path"

// The model is not a privilege authority. Restrict all job-mutating tools to
// the project whose registry instance was created by OpenCode.
export function assertProjectToolScope(name: string, args: unknown, project: string): void {
  if (!path.isAbsolute(project)) throw new Error("Scheduler host has no absolute project authority")
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
    if (typeof value !== "string" || !path.isAbsolute(value) ||
        path.normalize(value).toLowerCase() !== path.normalize(project).toLowerCase()) {
      throw new Error(`Scheduler ${name} cannot act outside the active project (${key})`)
    }
  }
}