import { createHash } from "node:crypto"
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const hash = (content: Buffer) => createHash("sha256").update(content).digest("hex")
export type Kind = "legacy" | "scoped" | "windows-manifest"
export interface Artifact { path: string; kind: Kind; sha256: string; dataBase64: string }
export interface Archive { format: "scheduler-legacy-backup/v1"; sourceRoot: string; artifacts: Artifact[] }
export interface Candidate { path: string; kind: "legacy" | "scoped"; sha256: string; workdir: string | null; target: string | null; verdict: "eligible" | "blocked"; reason: string }
export interface OwnershipProof { path: string; sha256: string; workdir: string; acknowledgedByOperator: true }

function scopeId(workdir: string): string {
  const base = path.basename(workdir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace"
  let n = 0xcbf29ce484222325n
  for (const byte of Buffer.from(workdir, "utf8")) n = ((n ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn
  return `${base}-${n.toString(16).padStart(16, "0").slice(0, 12)}`
}

function assertRegular(file: string): Buffer {
  const info = lstatSync(file)
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error(`Untrusted or oversized source: ${file}`)
  return readFileSync(file)
}
function assertDir(folder: string): void {
  if (!lstatSync(folder).isDirectory()) throw new Error(`Symbolic link or non-directory: ${folder}`)
}
function fileNames(dir: string): string[] {
  if (!existsSync(dir)) return []
  assertDir(dir)
  return readdirSync(dir, { withFileTypes: true }).map((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".json")) throw new Error(`Unexpected entry in backup area: ${entry.name}`)
    return entry.name
  }).sort()
}
function scopeFolders(root: string): string[] {
  const scopes = path.join(root, "scheduler", "scopes")
  if (!existsSync(scopes)) return []
  assertDir(path.join(root, "scheduler"))
  assertDir(scopes)
  return readdirSync(scopes, { withFileTypes: true }).map((entry) => {
    if (!entry.isDirectory() || !slugPattern.test(entry.name)) throw new Error("Untrusted scope directory")
    return entry.name
  }).sort()
}
function safeRelative(value: string): boolean {
  return /^(jobs\/[a-z0-9-]+\.json|scheduler\/scopes\/[a-z0-9-]+\/(jobs|windows-tasks)\/[a-z0-9-]+\.json)$/.test(value) &&
    !value.split("/").some((component) => component === "." || component === "..")
}
function artifactBytes(record: Artifact): Buffer {
  if (!safeRelative(record.path) || !/^[a-f\d]{64}$/.test(record.sha256) || !/^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(record.dataBase64)) {
    throw new Error("Invalid backup artifact metadata")
  }
  const inferred: Kind = record.path.startsWith("jobs/") ? "legacy" :
    record.path.includes("/windows-tasks/") ? "windows-manifest" : "scoped"
  if (record.kind !== inferred) throw new Error("Artifact classification mismatch")
  const bytes = Buffer.from(record.dataBase64, "base64")
  if (bytes.length > 1024 * 1024 || bytes.toString("base64") !== record.dataBase64 || hash(bytes) !== record.sha256) {
    throw new Error("Backup artifact digest mismatch")
  }
  return bytes
}
function parsedJob(bytes: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"))
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch { return null }
}

export function captureLegacyArchive(root: string): Archive {
  if (!path.isAbsolute(root)) throw new Error("Source root must be absolute")
  assertDir(root)
  const collected: Artifact[] = []
  const collect = (dir: string, relative: string, kind: Kind) => {
    if (!existsSync(dir)) return
    for (const name of fileNames(dir)) {
      if (!slugPattern.test(name.slice(0, -5))) throw new Error("Unsafe artifact name")
      const p = `${relative}/${name}`
      const bytes = assertRegular(path.join(dir, name))
      collected.push({ path: p, kind, sha256: hash(bytes), dataBase64: bytes.toString("base64") })
    }
  }
  collect(path.join(root, "jobs"), "jobs", "legacy")
  for (const scope of scopeFolders(root)) {
    const base = path.join(root, "scheduler", "scopes", scope)
    collect(path.join(base, "jobs"), `scheduler/scopes/${scope}/jobs`, "scoped")
    collect(path.join(base, "windows-tasks"), `scheduler/scopes/${scope}/windows-tasks`, "windows-manifest")
  }
  return { format: "scheduler-legacy-backup/v1", sourceRoot: path.resolve(root), artifacts: collected.sort((a, b) => a.path.localeCompare(b.path)) }
}

export function verifyLegacyArchive(input: Archive): Archive {
  if (!input || input.format !== "scheduler-legacy-backup/v1" || !path.isAbsolute(input.sourceRoot) || !Array.isArray(input.artifacts)) throw new Error("Invalid versioned backup")
  const seen = new Set<string>()
  let encodedSize = 0
  for (const entry of input.artifacts) {
    if (!entry || typeof entry.path !== "string" || seen.has(entry.path)) throw new Error("Duplicate or invalid backup entry")
    seen.add(entry.path)
    artifactBytes(entry)
    encodedSize += entry.dataBase64.length + entry.path.length + 256
    if (encodedSize > 48 * 1024 * 1024) throw new Error("Versioned backup exceeds safe size limit")
  }
  return input
}

export function previewLegacyMigration(archive: Archive): Candidate[] {
  verifyLegacyArchive(archive)
  const occupied = new Set(archive.artifacts.filter((a) => a.kind === "scoped").map((a) => a.path))
  const manifests = new Set(archive.artifacts.filter((a) => a.kind === "windows-manifest").map((a) => a.path))
  const staged = new Set<string>()
  return archive.artifacts.filter((a) => a.kind !== "windows-manifest").map((entry) => {
    const job = parsedJob(artifactBytes(entry))
    const slug = path.posix.basename(entry.path, ".json")
    let workdir: string | null = null
    if (typeof job?.workdir === "string" && path.isAbsolute(job.workdir) && job.workdir === job.workdir.trim()) {
      const normalized = path.resolve(job.workdir)
      try { if (realpathSync(normalized) === normalized && lstatSync(normalized).isDirectory()) workdir = normalized } catch {}
    }
    const scope = workdir ? scopeId(workdir) : null
    const target = scope ? `scheduler/scopes/${scope}/jobs/${slug}.json` : null
    let reason = "Ready for offline staging after exact ownership proof"
    if (!job || job.slug !== slug || !workdir || typeof job.schedule !== "string" || !job.schedule.trim()) reason = "Malformed or unattributed job"
    else if (entry.kind === "scoped" && (job.scopeId !== scope || entry.path !== target)) reason = "Scoped path and job identity disagree"
    else if (entry.kind === "legacy" && job.scopeId !== undefined && job.scopeId !== scope) reason = "Legacy record claims a different workspace"
    else if (target && entry.kind === "legacy" && occupied.has(target)) reason = "Existing scoped job collision"
    else if (target && staged.has(target)) reason = "Duplicate target across migration sources"
    else if (scope && manifests.has(`scheduler/scopes/${scope}/windows-tasks/${slug}.json`)) reason = "Task Scheduler ownership manifest needs manual OS reconciliation"
    if (target) staged.add(target)
    return { path: entry.path, kind: entry.kind as "legacy" | "scoped", sha256: entry.sha256, workdir, target,
      verdict: reason.startsWith("Ready") ? "eligible" : "blocked", reason }
  })
}

function assertDestination(source: string, destination: string): void {
  if (!path.isAbsolute(destination) || existsSync(destination)) throw new Error("Destination must be a new absolute path")
  const parent = path.dirname(destination)
  assertDir(parent)
  const realParent = realpathSync(parent)
  const realSource = path.resolve(source)
  const rel = path.relative(realSource, realParent)
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) throw new Error("Never stage/restore inside source configuration")
}
function publishDirectory(source: string, destination: string, files: { path: string; bytes: Buffer }[], inject?: (at: string) => void): void {
  assertDestination(source, destination)
  const temp = mkdtempSync(path.join(path.dirname(destination), ".scheduler-migrate-"))
  try {
    for (const item of files) {
      if (!safeRelative(item.path)) throw new Error("Unsafe output file")
      const output = path.join(temp, ...item.path.split("/"))
      mkdirSync(path.dirname(output), { recursive: true })
      const fd = openSync(output, "wx", 0o600)
      try { writeFileSync(fd, item.bytes); fsyncSync(fd) } finally { closeSync(fd) }
      inject?.(item.path)
    }
    if (existsSync(destination)) throw new Error("Concurrent destination collision")
    renameSync(temp, destination)
  } finally { if (existsSync(temp)) rmSync(temp, { recursive: true, force: true }) }
}
export function restoreLegacyArchive(archive: Archive, destination: string, inject?: (at: string) => void): void {
  verifyLegacyArchive(archive)
  publishDirectory(archive.sourceRoot, destination, archive.artifacts.map((a) => ({ path: a.path, bytes: artifactBytes(a) })), inject)
}
export function stageLegacyMigration(archive: Archive, destination: string, proofs: OwnershipProof[], inject?: (at: string) => void): Candidate[] {
  const preview = previewLegacyMigration(archive)
  const candidates = preview.filter((c) => c.kind === "legacy")
  if (!candidates.length) throw new Error("No legacy jobs to stage")
  if (candidates.some((c) => c.verdict === "blocked")) throw new Error("Ambiguous legacy job: staging denied")
  if (!Array.isArray(proofs) || proofs.length !== candidates.length) throw new Error("One exact ownership proof required per legacy job")
  const evidence = new Map(proofs.map((p) => [p.path, p]))
  if (evidence.size !== candidates.length) throw new Error("Duplicate ownership proof")
  const files = candidates.map((c) => {
    const proof = evidence.get(c.path)
    if (!proof || proof.acknowledgedByOperator !== true || proof.sha256 !== c.sha256 || proof.workdir !== c.workdir || !c.target) {
      throw new Error(`Missing or inconsistent owner attestation for ${c.path}`)
    }
    const entry = archive.artifacts.find((a) => a.path === c.path)!
    const job = parsedJob(artifactBytes(entry))!
    const bytes = Buffer.from(JSON.stringify({ ...job, scopeId: scopeId(c.workdir!) }, null, 2))
    return { path: c.target, bytes }
  })
  publishDirectory(archive.sourceRoot, destination, files, inject)
  return candidates
}

export function exportLegacyArchive(archive: Archive, file: string): void {
  verifyLegacyArchive(archive)
  if (!path.isAbsolute(file)) throw new Error("Export path must be absolute")
  assertDir(path.dirname(file))
  const parentReal = realpathSync(path.dirname(file))
  const rel = path.relative(archive.sourceRoot, parentReal)
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) throw new Error("Backup must be stored outside live configuration")
  const fd = openSync(file, "wx", 0o600)
  try { writeFileSync(fd, JSON.stringify(archive, null, 2)); fsyncSync(fd) }
  catch (error) { closeSync(fd); rmSync(file, { force: true }); throw error }
  closeSync(fd)
}

export function readLegacyArchive(file: string): Archive {
  const info = lstatSync(file)
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error("Invalid backup file")
  return verifyLegacyArchive(JSON.parse(readFileSync(file, "utf8")) as Archive)
}
