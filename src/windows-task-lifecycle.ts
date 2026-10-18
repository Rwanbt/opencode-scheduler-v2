import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import {
  beginWindowsTask, confirmWindowsTask, confirmWindowsTaskDeleted,
  loadWindowsManifest, reconcileAbsentWindowsTask, saveWindowsManifest,
  windowsTasksToDelete, type WindowsManifest,
} from "./windows-manifest.js"

export type WindowsTaskState = "absent" | "present" | "unknown"
export interface WindowsTaskEffects {
  inspect(name: string): WindowsTaskState
  create(name: string, args: string[]): void
  remove(name: string): void
}

function acquireWindowsTaskLock(file: string): () => void {
  mkdirSync(path.dirname(file), { recursive: true })
  const lock = `${file}.operation-lock`
  // Exclusive create coordinates independent OpenCode/Desktop processes.
  // After a process crash a stale lock needs operator verification: it must
  // never silently expire while schtasks might still be changing the task.
  const fd = openSync(lock, "wx", 0o600)
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    fsyncSync(fd)
  } catch (error) {
    closeSync(fd)
    unlinkSync(lock)
    throw error
  }
  return () => { closeSync(fd); unlinkSync(lock) }
}

export function registerWindowsTasks(
  file: string, scopeId: string, slug: string, prefix: string,
  definitions: { name: string; args: string[] }[], effects: WindowsTaskEffects,
): void {
  const unlock = acquireWindowsTaskLock(file)
  try {
  if (existsSync(file)) throw new Error("Windows task manifest already exists; reconciliation required")
  const names = definitions.map((task) => task.name)
  if (!names.length || !names.every((name, i) => name ===
    (names.length === 1 ? prefix : `${prefix}-${i + 1}`))) {
    throw new Error("Invalid Windows task registration plan")
  }
  // Preflight is not an ownership grant; /Create still uses no /F. If a task
  // appears between the checks and /Create, its inFlight state stays blocked.
  for (const name of names) {
    const result = effects.inspect(name)
    if (result !== "absent") {
      throw new Error(`Windows task ${name} collision or unverified OS state: ${result}`)
    }
  }
  let state: WindowsManifest = { scopeId, slug, names, registered: [], inFlight: null }
  saveWindowsManifest(file, state)
  for (const task of definitions) {
    state = beginWindowsTask(state, task.name)
    saveWindowsManifest(file, state)
    effects.create(task.name, task.args)
    state = confirmWindowsTask(state, task.name)
    saveWindowsManifest(file, state)
  }
  } finally { unlock() }
}

export function removeWindowsTasks(
  file: string, scopeId: string, slug: string, prefix: string, effects: WindowsTaskEffects,
): boolean {
  const unlock = acquireWindowsTaskLock(file)
  try {
  if (!existsSync(file)) return false
  let state = loadWindowsManifest(file, scopeId, slug, prefix)
  if (state.inFlight) {
    const name = state.inFlight
    state = reconcileAbsentWindowsTask(state, name, effects.inspect)
    saveWindowsManifest(file, state)
  }
  // Removing newest first retains a validated registration prefix after each
  // durable checkpoint. A crash after /Delete is resolved by a fresh query.
  for (const name of windowsTasksToDelete(state).reverse()) {
    const before = effects.inspect(name)
    if (before === "unknown" || (before !== "present" && before !== "absent")) {
      throw new Error(`Windows task ${name} cannot be verified before deletion; manifest preserved`)
    }
    let failure: unknown
    if (before === "present") {
      try { effects.remove(name) } catch (error) { failure = error }
    }
    const after = effects.inspect(name)
    if (after !== "absent") {
      if (failure) throw failure
      throw new Error(`Windows task ${name} is not verified absent; manifest preserved`)
    }
    state = confirmWindowsTaskDeleted(state, name, () => after)
    saveWindowsManifest(file, state)
  }
  unlinkSync(file)
  return true
  } finally { unlock() }
}
