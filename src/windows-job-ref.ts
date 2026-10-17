import { createHash } from "node:crypto"
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

export function windowsJobRefId(jobPath: string): string {
  if (!path.win32.isAbsolute(jobPath)) throw new Error("Windows job reference needs absolute path")
  return createHash("sha256").update(path.win32.normalize(jobPath).toLowerCase()).digest("hex").slice(0, 24)
}

export function windowsJobRefPath(schedulerRoot: string, jobPath: string): string {
  return path.join(schedulerRoot, `j-${windowsJobRefId(jobPath)}.json`)
}

export function writeWindowsJobReference(file: string, jobPath: string): void {
  // A collision or unexpected edited ref is NOT silently overwritten.
  if (existsSync(file)) {
    const stored = JSON.parse(readFileSync(file, "utf8"))
    if (stored.jobPath !== jobPath) throw new Error("Windows job reference collision or tampering detected")
    return
  }
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify({ jobPath }, null, 2))
  renameSync(temp, file)
}