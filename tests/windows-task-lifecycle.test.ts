import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { registerWindowsTasks, removeWindowsTasks } from "../src/windows-task-lifecycle"
import { beginWindowsTask, loadWindowsManifest, saveWindowsManifest } from "../src/windows-manifest"

const prefix = "\\OpenCode\\opencode-job-workspace-sample"
const names = [`${prefix}-1`, `${prefix}-2`]
const planned = names.map((name) => ({ name, args: ["/Create", "/TN", name] }))
const state = () => ({ scopeId: "workspace", slug: "sample", names, registered: [...names], inFlight: null as string | null })

function fixture(run: (file: string) => void) {
  const folder = mkdtempSync(path.join(tmpdir(), "scheduler-win-lifecycle-"))
  try { run(path.join(folder, "manifest.json")) } finally { rmSync(folder, { recursive: true, force: true }) }
}

describe("Windows engine durable OS lifecycle", () => {
  test("creates only when every planned task is provably absent; ambiguous collision makes zero writes", () => fixture((file) => {
    for (const result of ["present", "unknown"] as const) {
      const operations: string[] = []
      expect(() => registerWindowsTasks(file, "workspace", "sample", prefix, planned, {
        inspect: (name) => { operations.push(`inspect:${name}`); return name === names[1] ? result : "absent" },
        create: (name) => operations.push(`create:${name}`),
        remove: () => { throw new Error("unexpected") },
      })).toThrow(/unverified|collision|already exists/i)
      expect(operations).toEqual([`inspect:${names[0]}`, `inspect:${names[1]}`])
      expect(existsSync(file)).toBe(false)
    }
  }))

  test("/Create succeeds in OS, then throws: inFlight stays durable; no unowned cleanup", () => fixture((file) => {
    const tasks = new Set<string>()
    expect(() => registerWindowsTasks(file, "workspace", "sample", prefix, planned, {
      inspect: (name) => tasks.has(name) ? "present" : "absent",
      create: (name) => { tasks.add(name); if (name === names[1]) throw new Error("partial OS success") },
      remove: () => { throw new Error("no implicit rollback") },
    })).toThrow(/partial OS success/)
    const persisted = loadWindowsManifest(file, "workspace", "sample", prefix)
    expect(persisted).toEqual({ ...state(), registered: [names[0]], inFlight: names[1] })
    expect(tasks.size).toBe(2)
    expect(() => removeWindowsTasks(file, "workspace", "sample", prefix, {
      inspect: (name) => tasks.has(name) ? "present" : "absent",
      remove: () => { throw new Error("foreign deletion") }, create: () => {},
    })).toThrow(/unverified/)
    expect(tasks.size).toBe(2)
    expect(existsSync(file)).toBe(true)
  }))

  test("verified absent inFlight recovers, followed by reverse durable deletion", () => fixture((file) => {
    saveWindowsManifest(file, beginWindowsTask({ ...state(), registered: [names[0]] }, names[1]))
    const operations: string[] = []
    const tasks = new Set([names[0]])
    removeWindowsTasks(file, "workspace", "sample", prefix, {
      inspect: (name) => { operations.push(`inspect:${name}`); return tasks.has(name) ? "present" : "absent" },
      remove: (name) => { operations.push(`remove:${name}`); tasks.delete(name) }, create: () => {},
    })
    expect(operations).toEqual([`inspect:${names[1]}`, `inspect:${names[0]}`, `remove:${names[0]}`, `inspect:${names[0]}`])
    expect(existsSync(file)).toBe(false)
  }))

  test("deleted-then-error is idempotently checkpointed; subsequent failure keeps remainder", () => fixture((file) => {
    saveWindowsManifest(file, state())
    const tasks = new Set(names)
    const removed: string[] = []
    expect(() => removeWindowsTasks(file, "workspace", "sample", prefix, {
      inspect: (name) => tasks.has(name) ? "present" : "absent",
      remove: (name) => { tasks.delete(name); removed.push(name); if (name === names[1]) throw new Error("post-delete failure") },
      create: () => {},
    })).not.toThrow()
    expect(removed).toEqual([names[1], names[0]])
    expect(existsSync(file)).toBe(false)
  }))

  test("unknown OS state or access denied never retires manifest or touches later tasks", () => fixture((file) => {
    saveWindowsManifest(file, state())
    const removed: string[] = []
    expect(() => removeWindowsTasks(file, "workspace", "sample", prefix, {
      inspect: (name) => name === names[1] ? "unknown" : "present",
      remove: (name) => removed.push(name), create: () => {},
    })).toThrow()
    expect(removed).toEqual([])
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(state())
    expect(() => removeWindowsTasks(file, "workspace", "sample", prefix, {
      inspect: () => "present", remove: () => { throw new Error("access denied") }, create: () => {},
    })).toThrow(/access denied|not verified/i)
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(state())
  }))

  test("crash after OS deletion replays by confirming absence, preserving foreign legacy manifest", () => fixture((file) => {
    saveWindowsManifest(file, state())
    const tasks = new Set([names[0]]) // second was removed before process crashed
    const removed: string[] = []
    removeWindowsTasks(file, "workspace", "sample", prefix, {
      inspect: (name) => tasks.has(name) ? "present" : "absent",
      remove: (name) => { tasks.delete(name); removed.push(name) }, create: () => {},
    })
    expect(removed).toEqual([names[0]])
    writeFileSync(file, JSON.stringify({ scopeId: "workspace", slug: "sample", names }))
    expect(() => removeWindowsTasks(file, "workspace", "sample", prefix, {
      inspect: () => "present", remove: () => removed.push("foreign"), create: () => {},
    })).toThrow(/legacy|ownership/i)
    expect(removed).toEqual([names[0]])
  }))
  test("a competing or crashed operator lock blocks all task and manifest mutations", () => fixture((file) => {
    const effects = {
      inspect: () => "absent" as const,
      create: () => { throw new Error("must not run") },
      remove: () => { throw new Error("must not run") },
    }
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(`${file}.operation-lock`, "OTHER_ACTIVE_OPERATOR")
    expect(() => registerWindowsTasks(file, "workspace", "sample", prefix, planned, effects)).toThrow()
    expect(() => removeWindowsTasks(file, "workspace", "sample", prefix, effects)).toThrow()
    expect(readFileSync(`${file}.operation-lock`, "utf8")).toBe("OTHER_ACTIVE_OPERATOR")
    expect(existsSync(file)).toBe(false)
  }))
  test("a failed second deletion persists the first checkpoint for safe retry", () => fixture((file) => {
    saveWindowsManifest(file, state())
    const tasks = new Set(names)
    const removed: string[] = []
    expect(() => removeWindowsTasks(file, "workspace", "sample", prefix, {
      inspect: (name) => tasks.has(name) ? "present" : "absent",
      remove: (name) => {
        if (name === names[0]) throw new Error("access denied")
        tasks.delete(name); removed.push(name)
      }, create: () => {},
    })).toThrow(/access denied/)
    expect(removed).toEqual([names[1]])
    expect(loadWindowsManifest(file, "workspace", "sample", prefix).registered).toEqual([names[0]])
    expect(existsSync(`${file}.operation-lock`)).toBe(false)
    removeWindowsTasks(file, "workspace", "sample", prefix, {
      inspect: (name) => tasks.has(name) ? "present" : "absent",
      remove: (name) => { tasks.delete(name); removed.push(name) }, create: () => {},
    })
    expect(removed).toEqual([names[1], names[0]])
    expect(existsSync(file)).toBe(false)
  }))
})
