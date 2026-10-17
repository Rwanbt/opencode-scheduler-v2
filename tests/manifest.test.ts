import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { beginWindowsTask, confirmWindowsTask, loadWindowsManifest, saveWindowsManifest, windowsTasksToDelete } from "../src/windows-manifest"

const prefix = "\\OpenCode\\opencode-job-my-project"
const names = [prefix + "-1", prefix + "-2"]
const blank = () => ({ scopeId: "scope", slug: "job", names, registered: [] as string[], inFlight: null as string | null })

describe("durable Windows schtasks manifest recovery", () => {
  test("planned tasks are never guessed as registered", () => {
    const intended = blank()
    expect(windowsTasksToDelete(intended)).toEqual([])
    const started = beginWindowsTask(intended, names[0])
    expect(windowsTasksToDelete(started)).toEqual([names[0]])
    const done = confirmWindowsTask(started, names[0])
    expect(windowsTasksToDelete(done)).toEqual([names[0]])
    expect(windowsTasksToDelete(beginWindowsTask(done, names[1]))).toEqual(names)
    expect(() => confirmWindowsTask(started, names[1])).toThrow()
    expect(() => beginWindowsTask(started, names[1])).toThrow()
  })
  test("crash recovery retains in-flight work and refuses foreign owners", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scheduler-manifest-test-"))
    const file = path.join(dir, "manifest.json")
    try {
      const partial = beginWindowsTask(blank(), names[0])
      saveWindowsManifest(file, partial)
      expect(windowsTasksToDelete(loadWindowsManifest(file, "scope", "job", prefix))).toEqual([names[0]])
      expect(() => loadWindowsManifest(file, "foreign", "job", prefix)).toThrow()
      expect(() => loadWindowsManifest(file, "scope", "foreign", prefix)).toThrow()
      const corrupted = { ...partial, registered: ["\\OpenCode\\other-project"] }
      writeFileSync(file, JSON.stringify(corrupted))
      expect(() => loadWindowsManifest(file, "scope", "job", prefix)).toThrow()
      expect(readFileSync(file, "utf8")).toContain("other-project")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test("legacy name-only manifests are treated as potentially registered", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scheduler-manifest-legacy-"))
    const file = path.join(dir, "manifest.json")
    try {
      writeFileSync(file, JSON.stringify({ scopeId: "scope", slug: "job", names }))
      expect(windowsTasksToDelete(loadWindowsManifest(file, "scope", "job", prefix))).toEqual(names)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test("duplicate names and prefix-collision task names fail closed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scheduler-manifest-corrupt-"))
    const file = path.join(dir, "manifest.json")
    try {
      for (const invalid of [[names[0], names[0]], [prefix + "-0"], [prefix + "-11-other"], [prefix + "-1\\foreign"]]) {
        writeFileSync(file, JSON.stringify({ ...blank(), names: invalid }))
        expect(() => loadWindowsManifest(file, "scope", "job", prefix)).toThrow()
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})