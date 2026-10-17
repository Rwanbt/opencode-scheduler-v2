import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { beginWindowsTask, confirmWindowsTask, confirmWindowsTaskDeleted, loadWindowsManifest, reconcileAbsentWindowsTask, saveWindowsManifest, windowsTasksToDelete } from "../src/windows-manifest"

const prefix = "\\OpenCode\\opencode-job-my-project"
const names = [prefix + "-1", prefix + "-2"]
const blank = () => ({ scopeId: "scope", slug: "job", names, registered: [] as string[], inFlight: null as string | null })

describe("durable Windows schtasks manifest recovery", () => {
  test("planned tasks are never guessed as registered", () => {
    const intended = blank()
    expect(windowsTasksToDelete(intended)).toEqual([])
    const started = beginWindowsTask(intended, names[0])
    expect(() => windowsTasksToDelete(started)).toThrow(/unverified/)
    const done = confirmWindowsTask(started, names[0])
    expect(windowsTasksToDelete(done)).toEqual([names[0]])
    expect(() => windowsTasksToDelete(beginWindowsTask(done, names[1]))).toThrow(/unverified/)
    expect(() => confirmWindowsTask(started, names[1])).toThrow()
    expect(() => beginWindowsTask(started, names[1])).toThrow()
  })
  test("crash recovery retains in-flight work and refuses foreign owners", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scheduler-manifest-test-"))
    const file = path.join(dir, "manifest.json")
    try {
      const partial = beginWindowsTask(blank(), names[0])
      saveWindowsManifest(file, partial)
      expect(() => windowsTasksToDelete(loadWindowsManifest(file, "scope", "job", prefix))).toThrow(/unverified/)
      expect(() => loadWindowsManifest(file, "foreign", "job", prefix)).toThrow()
      expect(() => loadWindowsManifest(file, "scope", "foreign", prefix)).toThrow()
      const corrupted = { ...partial, registered: ["\\OpenCode\\other-project"] }
      writeFileSync(file, JSON.stringify(corrupted))
      expect(() => loadWindowsManifest(file, "scope", "job", prefix)).toThrow()
      expect(readFileSync(file, "utf8")).toContain("other-project")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test("legacy name-only manifests have no ownership proof, so deletion is blocked", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scheduler-manifest-legacy-"))
    const file = path.join(dir, "manifest.json")
    try {
      writeFileSync(file, JSON.stringify({ scopeId: "scope", slug: "job", names }))
      expect(() => loadWindowsManifest(file, "scope", "job", prefix)).toThrow(/legacy|ownership/i)
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ scopeId: "scope", slug: "job", names })
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
  test("tampered registration states cannot authorize foreign deletion", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scheduler-manifest-state-"))
    const file = path.join(dir, "manifest.json")
    try {
      const invalid = [
        { registered: null }, { registered: "all" }, { inFlight: undefined },
        { registered: [names[1]] }, { registered: [names[0], names[0]] },
        { registered: [names[0], "\\OpenCode\\other-owner"] },
        { registered: [names[0]], inFlight: names[0] },
        { registered: names, inFlight: names[1] },
        { registered: [], inFlight: names[1] },
      ]
      for (const entry of invalid) {
        writeFileSync(file, JSON.stringify({ ...blank(), ...entry }))
        expect(() => loadWindowsManifest(file, "scope", "job", prefix)).toThrow()
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test("uncertain partial /Create can only be reconciled after authoritative absence", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scheduler-manifest-partial-"))
    const file = path.join(dir, "manifest.json")
    try {
      let state = blank()
      state = confirmWindowsTask(beginWindowsTask(state, names[0]), names[0])
      state = beginWindowsTask(state, names[1])
      saveWindowsManifest(file, state)
      // A mocked OS registers second task, then schtasks exits with an error.
      const osNames = new Set(names)
      const recovered = loadWindowsManifest(file, "scope", "job", prefix)
      expect(() => windowsTasksToDelete(recovered)).toThrow(/unverified/)
      expect(() => reconcileAbsentWindowsTask(recovered, names[1], () => "unknown")).toThrow()
      expect(() => reconcileAbsentWindowsTask(recovered, names[1], () => "present")).toThrow()
      expect(() => reconcileAbsentWindowsTask(recovered, names[0], () => "absent")).toThrow()
      expect(() => reconcileAbsentWindowsTask(recovered, names[1], () => { throw new Error("access denied") })).toThrow()
      expect(osNames.has(names[1])).toBe(true)
      // Operator removes the uncertain task independently, then verified /Query says absent.
      osNames.delete(names[1])
      state = reconcileAbsentWindowsTask(recovered, names[1], (name) => osNames.has(name) ? "present" : "absent")
      saveWindowsManifest(file, state)
      expect(windowsTasksToDelete(loadWindowsManifest(file, "scope", "job", prefix))).toEqual([names[0]])
      expect(() => beginWindowsTask(state, names[0])).toThrow()
      expect(() => confirmWindowsTask(state, names[1])).toThrow()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test("failed publication leaves the last verified manifest intact and removes temporary files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scheduler-manifest-durable-"))
    const file = path.join(dir, "manifest.json")
    try {
      const verified = confirmWindowsTask(beginWindowsTask(blank(), names[0]), names[0])
      saveWindowsManifest(file, verified)
      const original = readFileSync(file, "utf8")
      const invalid: any = { ...verified }
      invalid.cycle = invalid
      expect(() => saveWindowsManifest(file, invalid)).toThrow()
      expect(readFileSync(file, "utf8")).toBe(original)
      expect(readdirSync(dir)).toEqual(["manifest.json"])
      saveWindowsManifest(file, beginWindowsTask(verified, names[1]))
      expect(loadWindowsManifest(file, "scope", "job", prefix).inFlight).toBe(names[1])
      expect(readdirSync(dir)).toEqual(["manifest.json"])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test("reverse-order deletion can recover after a successful /Delete followed by a crash", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scheduler-manifest-delete-"))
    const file = path.join(dir, "manifest.json")
    try {
      const first = confirmWindowsTask(beginWindowsTask(blank(), names[0]), names[0])
      const fullyRegistered = confirmWindowsTask(beginWindowsTask(first, names[1]), names[1])
      saveWindowsManifest(file, fullyRegistered)
      expect(() => confirmWindowsTaskDeleted(fullyRegistered, names[0], () => "absent")).toThrow()
      expect(() => confirmWindowsTaskDeleted(fullyRegistered, names[1], () => "present")).toThrow()
      expect(() => confirmWindowsTaskDeleted(fullyRegistered, names[1], () => "unknown")).toThrow()
      expect(() => confirmWindowsTaskDeleted(fullyRegistered, names[1], () => { throw new Error("query inaccessible") })).toThrow()
      // OS deletes second task, then the process crashes before updating manifest.
      const replay = loadWindowsManifest(file, "scope", "job", prefix)
      const remaining = confirmWindowsTaskDeleted(replay, names[1], () => "absent")
      saveWindowsManifest(file, remaining)
      expect(windowsTasksToDelete(loadWindowsManifest(file, "scope", "job", prefix))).toEqual([names[0]])
      const none = confirmWindowsTaskDeleted(remaining, names[0], () => "absent")
      saveWindowsManifest(file, none)
      expect(windowsTasksToDelete(loadWindowsManifest(file, "scope", "job", prefix))).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
