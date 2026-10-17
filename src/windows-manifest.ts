import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"

export interface WindowsManifest {
  scopeId: string
  slug: string
  names: string[]
  registered: string[]
  inFlight: string | null
}

export function loadWindowsManifest(file: string, scopeId: string, slug: string, prefix: string): WindowsManifest {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"))
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid Windows task manifest; refusing cross-scope effects")
  }
  const state = raw as Partial<WindowsManifest>
  if (state.scopeId !== scopeId || state.slug !== slug || !Array.isArray(state.names) ||
      state.names.length === 0 || !state.names.every((name, i) =>
        typeof name === "string" && name === (state.names!.length === 1 ? prefix : `${prefix}-${i + 1}`))) {
    throw new Error("Invalid Windows task manifest; refusing cross-scope effects")
  }
  // V1 contains only desired names, not an ownership record. In particular,
  // a same-name legacy/foreign task must never be inferred as ours.
  if (!Object.hasOwn(state, "registered") || !Object.hasOwn(state, "inFlight")) {
    throw new Error("Legacy Windows task manifest has no ownership proof; manual reconciliation required")
  }
  const { registered, inFlight, names } = state
  if (!Array.isArray(registered) || !registered.every((name, i) => name === names[i]) ||
      (inFlight !== null && (typeof inFlight !== "string" || inFlight !== names[registered.length]))) {
    throw new Error("Invalid Windows task registration state")
  }
  return { scopeId, slug, names, registered, inFlight }
}

export function saveWindowsManifest(file: string, manifest: WindowsManifest): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    // Durable content before publish; an interrupted write cannot truncate
    // the previous manifest or leave a reusable predictable temp pathname.
    fd = openSync(temp, "wx", 0o600)
    writeFileSync(fd, JSON.stringify(manifest, null, 2))
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, file)
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temp) } catch {}
  }
}

export function beginWindowsTask(manifest: WindowsManifest, name: string): WindowsManifest {
  if (manifest.inFlight || manifest.names[manifest.registered.length] !== name) {
    throw new Error("Unexpected Windows task registration transition")
  }
  return { ...manifest, inFlight: name }
}

export function confirmWindowsTask(manifest: WindowsManifest, name: string): WindowsManifest {
  if (manifest.inFlight !== name || manifest.names[manifest.registered.length] !== name) {
    throw new Error("Unexpected Windows task completion")
  }
  return { ...manifest, inFlight: null, registered: [...manifest.registered, name] }
}

// Only an authoritative OS query that distinguishes ABSENT from ACCESS DENIED,
// malformed output and other failures can clear an uncertain /Create. Never
// infer ownership from a successful /Query after schtasks returns an error.
export function reconcileAbsentWindowsTask(
  manifest: WindowsManifest,
  name: string,
  query: (name: string) => "absent" | "present" | "unknown",
): WindowsManifest {
  if (manifest.inFlight !== name || manifest.names[manifest.registered.length] !== name) {
    throw new Error("Unexpected Windows task reconciliation")
  }
  if (query(name) !== "absent") {
    throw new Error(`Windows task ${name} remains unverified; manual reconciliation required`)
  }
  return { ...manifest, inFlight: null }
}

// A durable deletion must retire only the last confirmed registration. This
// keeps the registered prefix verifiable after a crash between /Delete and
// saving the updated manifest; query errors never count as absence.
export function confirmWindowsTaskDeleted(
  manifest: WindowsManifest,
  name: string,
  query: (name: string) => "absent" | "present" | "unknown",
): WindowsManifest {
  if (manifest.inFlight || manifest.registered[manifest.registered.length - 1] !== name) {
    throw new Error("Unexpected Windows task deletion transition")
  }
  if (query(name) !== "absent") {
    throw new Error(`Windows task ${name} is not verified deleted; manifest preserved`)
  }
  return { ...manifest, registered: manifest.registered.slice(0, -1) }
}

export function windowsTasksToDelete(manifest: WindowsManifest): string[] {
  // A crash while /Create was in flight leaves ownership ambiguous: schtasks
  // can report a conflicting pre-existing task with the same name. It is not
  // safe to delete such a task based only on a name. Require reconciliation.
  if (manifest.inFlight) {
    throw new Error(`Windows task creation for ${manifest.inFlight} is unverified; manual reconciliation required`)
  }
  return [...manifest.registered]
}
