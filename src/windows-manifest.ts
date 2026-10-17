import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

export interface WindowsManifest {
  scopeId: string
  slug: string
  names: string[]
  registered: string[]
  inFlight: string | null
}

export function loadWindowsManifest(file: string, scopeId: string, slug: string, prefix: string): WindowsManifest {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<WindowsManifest>
  const valid = (name: unknown): name is string =>
    typeof name === "string" && (name === prefix ||
      (name.startsWith(`${prefix}-`) && /^[1-9]\d*$/.test(name.slice(prefix.length + 1))))
  if (raw.scopeId !== scopeId || raw.slug !== slug || !Array.isArray(raw.names) ||
      raw.names.length === 0 || new Set(raw.names).size !== raw.names.length || !raw.names.every(valid)) {
    throw new Error("Invalid Windows task manifest; refusing cross-scope effects")
  }
  // Manifest v1 recorded only intended names. Conservatively treat every
  // listed name as potentially installed during migration.
  const registered = raw.registered ?? raw.names
  const inFlight = raw.inFlight ?? null
  if (!Array.isArray(registered) || !registered.every((name) => valid(name) && raw.names!.includes(name)) ||
      new Set(registered).size !== registered.length ||
      (inFlight !== null && (!valid(inFlight) || !raw.names.includes(inFlight)))) {
    throw new Error("Invalid Windows task registration state")
  }
  return { scopeId, slug, names: raw.names, registered, inFlight }
}

export function saveWindowsManifest(file: string, manifest: WindowsManifest): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(manifest, null, 2))
  renameSync(temp, file)
}

export function beginWindowsTask(manifest: WindowsManifest, name: string): WindowsManifest {
  if (!manifest.names.includes(name) || manifest.inFlight) throw new Error("Unexpected Windows task registration transition")
  return { ...manifest, inFlight: name }
}

export function confirmWindowsTask(manifest: WindowsManifest, name: string): WindowsManifest {
  if (manifest.inFlight !== name) throw new Error("Unexpected Windows task completion")
  return { ...manifest, inFlight: null, registered: [...manifest.registered, name] }
}

export function windowsTasksToDelete(manifest: WindowsManifest): string[] {
  return [...new Set([...manifest.registered, ...(manifest.inFlight ? [manifest.inFlight] : [])])]
}