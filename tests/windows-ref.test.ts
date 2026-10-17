import { test, expect } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { windowsJobRefId, windowsJobRefPath, writeWindowsJobReference } from "../src/windows-job-ref"

test("Windows scheduled command uses short deterministic per-job path references", () => {
  const root = mkdtempSync(path.join(tmpdir(), "scheduler-shortref-"))
  try {
    const long = `C:\\Users\\runneradmin\\.config\\opencode\\scheduler\\scopes\\${"very-long-project-".repeat(6)}\\jobs\\job.json`
    const pointer = windowsJobRefPath(root, long)
    expect(path.basename(pointer)).toBe(`j-${windowsJobRefId(long)}.json`)
    expect(pointer.length).toBeLessThan(long.length)
    writeWindowsJobReference(pointer, long)
    expect(JSON.parse(readFileSync(pointer, "utf8")).jobPath).toBe(long)
    expect(() => writeWindowsJobReference(pointer, long)).not.toThrow()
    expect(() => writeWindowsJobReference(pointer, "C:\\foreign\\job.json")).toThrow()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("rejects non-absolute short-reference paths", () => {
  expect(() => windowsJobRefId("relative/job.json")).toThrow()
})