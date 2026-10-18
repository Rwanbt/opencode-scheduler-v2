import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  captureLegacyArchive, exportLegacyArchive, previewLegacyMigration,
  readLegacyArchive, restoreLegacyArchive, stageLegacyMigration, type Archive, type OwnershipProof,
} from "../src/legacy-migration"

function fixture(run: (root: string, output: string) => void) {
  const temp = mkdtempSync(path.join(tmpdir(), "scheduler-legacy-migration-"))
  const root = path.join(temp, "config")
  const output = path.join(temp, "output")
  mkdirSync(root)
  mkdirSync(output)
  try { run(root, output) } finally { rmSync(temp, { recursive: true, force: true }) }
}
function addJob(root: string, slug: string, workdir: string, extras: Record<string, unknown> = {}) {
  const file = path.join(root, "jobs", `${slug}.json`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ slug, name: slug, schedule: "0 9 * * *", prompt: "Never execute in test", workdir, ...extras }))
  return file
}
function proof(archive: Archive): OwnershipProof[] {
  return previewLegacyMigration(archive).filter((c) => c.kind === "legacy")
    .map((c) => ({ path: c.path, sha256: c.sha256, workdir: c.workdir!, acknowledgedByOperator: true }))
}

describe("v1.3.0 offline migration backup and recovery", () => {
  test("preview never creates or changes source, stable archive round-trips original bytes", () => fixture((root, out) => {
    const workdir = path.join(root, "workspace")
    mkdirSync(workdir)
    const file = addJob(root, "daily", workdir)
    const original = readFileSync(file)
    const snapshot = captureLegacyArchive(root)
    expect(previewLegacyMigration(snapshot).map((x) => x.verdict)).toEqual(["eligible"])
    expect(readFileSync(file)).toEqual(original)
    expect(existsSync(path.join(root, "scheduler"))).toBe(false)
    const archiveFile = path.join(out, "v1.json")
    exportLegacyArchive(snapshot, archiveFile)
    expect(() => exportLegacyArchive(snapshot, archiveFile)).toThrow()
    const verified = readLegacyArchive(archiveFile)
    expect(verified).toEqual(snapshot)
    const restored = path.join(out, "restored")
    restoreLegacyArchive(verified, restored)
    expect(readFileSync(path.join(restored, "jobs", "daily.json"))).toEqual(original)
    expect(readFileSync(file)).toEqual(original)
    expect(() => restoreLegacyArchive(verified, restored)).toThrow()
  }))

  test("exact operator proof allows only isolated staging with derived scoped identity", () => fixture((root, out) => {
    const workdir = path.join(root, "workspace")
    mkdirSync(workdir)
    const legacyFile = addJob(root, "daily", workdir)
    const archive = captureLegacyArchive(root)
    const staging = path.join(out, "stage")
    const staged = stageLegacyMigration(archive, staging, proof(archive))
    expect(staged).toHaveLength(1)
    const expected = staged[0].target!
    const migrated = JSON.parse(readFileSync(path.join(staging, ...expected.split("/")), "utf8"))
    expect(migrated.scopeId).toMatch(/^workspace-[0-9a-f]{12}$/)
    expect(migrated.workdir).toBe(workdir)
    expect(readFileSync(legacyFile, "utf8")).not.toContain("scopeId")
    expect(existsSync(path.join(root, "scheduler"))).toBe(false)
    expect(() => stageLegacyMigration(archive, staging, proof(archive))).toThrow()
  }))

  test("already scoped v1.3 data is backed up and restored with exact bytes but never copied into staged legacy output", () => fixture((root, out) => {
    const workdir = path.join(root, "workspace")
    mkdirSync(workdir)
    addJob(root, "first", workdir)
    const first = captureLegacyArchive(root)
    const scopeTarget = previewLegacyMigration(first)[0].target!
    const scopeDir = path.dirname(path.join(root, ...scopeTarget.split("/")))
    mkdirSync(scopeDir, { recursive: true })
    const scopedFile = path.join(scopeDir, "second.json")
    const scopeId = path.basename(path.dirname(scopeDir))
    writeFileSync(scopedFile, JSON.stringify({ slug: "second", scopeId, workdir, schedule: "0 8 * * *", prompt: "archived" }))
    const archive = captureLegacyArchive(root)
    expect(previewLegacyMigration(archive).map((c) => [c.kind, c.verdict])).toEqual([
      ["legacy", "eligible"], ["scoped", "eligible"],
    ])
    const backup = path.join(out, "backup.json")
    exportLegacyArchive(archive, backup)
    const restored = path.join(out, "restore-scoped")
    restoreLegacyArchive(readLegacyArchive(backup), restored)
    expect(readFileSync(path.join(restored, ...archive.artifacts[1].path.split("/")))).toEqual(readFileSync(scopedFile))
    const stage = path.join(out, "stage-only-legacy")
    expect(stageLegacyMigration(archive, stage, proof(archive))).toHaveLength(1)
    expect(existsSync(path.join(stage, ...archive.artifacts[1].path.split("/")))).toBe(false)
  }))

  test("missing, duplicate and forged owner proof fail before a single write", () => fixture((root, out) => {
    const workdir = path.join(root, "workspace")
    mkdirSync(workdir)
    addJob(root, "daily", workdir)
    const archive = captureLegacyArchive(root)
    const valid = proof(archive)[0]
    const bad: OwnershipProof[][] = [[], [valid, valid],
      [{ ...valid, sha256: "0".repeat(64) }], [{ ...valid, workdir: path.join(root, "another") }],
      [{ ...valid, acknowledgedByOperator: false as true }]]
    bad.forEach((evidence, i) => {
      const dest = path.join(out, `attempt-${i}`)
      expect(() => stageLegacyMigration(archive, dest, evidence)).toThrow()
      expect(existsSync(dest)).toBe(false)
    })
  }))

  test("tampered digest, duplicate path and backup traversal cannot be restored", () => fixture((root, out) => {
    const workdir = path.join(root, "workspace")
    mkdirSync(workdir)
    addJob(root, "daily", workdir)
    const archive = captureLegacyArchive(root)
    const cases = [
      { ...archive, artifacts: [{ ...archive.artifacts[0], sha256: "0".repeat(64) }] },
      { ...archive, artifacts: [archive.artifacts[0], archive.artifacts[0]] },
      { ...archive, artifacts: [{ ...archive.artifacts[0], path: "../escape.json" }] },
      { ...archive, format: "other" },
    ] as Archive[]
    cases.forEach((candidate, i) => {
      const dest = path.join(out, `tamper-${i}`)
      expect(() => restoreLegacyArchive(candidate, dest)).toThrow()
      expect(existsSync(dest)).toBe(false)
    })
  }))

  test("interrupted restore/stage atomically cleans partial destination and leaves source unchanged", () => fixture((root, out) => {
    const workdir = path.join(root, "workspace")
    mkdirSync(workdir)
    const source = addJob(root, "daily", workdir)
    addJob(root, "weekly", workdir)
    const before = readFileSync(source)
    const archive = captureLegacyArchive(root)
    const faults = (at: string) => { throw new Error(`fault after ${at}`) }
    expect(() => restoreLegacyArchive(archive, path.join(out, "restore-fail"), faults)).toThrow(/fault/)
    expect(() => stageLegacyMigration(archive, path.join(out, "stage-fail"), proof(archive), faults)).toThrow(/fault/)
    expect(existsSync(path.join(out, "restore-fail"))).toBe(false)
    expect(existsSync(path.join(out, "stage-fail"))).toBe(false)
    expect(readFileSync(source)).toEqual(before)
    expect(stageLegacyMigration(archive, path.join(out, "stage-ok"), proof(archive))).toHaveLength(2)
  }))

  test("ambiguous scoped collision, foreign scope, missing workdir and OS task manifest block staging", () => fixture((root, out) => {
    const workdir = path.join(root, "workspace")
    mkdirSync(workdir)
    const file = addJob(root, "daily", workdir)
    const snapshot = captureLegacyArchive(root)
    const target = previewLegacyMigration(snapshot)[0].target!
    const scopedFile = path.join(root, ...target.split("/"))
    mkdirSync(path.dirname(scopedFile), { recursive: true })
    writeFileSync(scopedFile, "{}")
    let archive = captureLegacyArchive(root)
    expect(previewLegacyMigration(archive).some((c) => c.verdict === "blocked")).toBe(true)
    expect(() => stageLegacyMigration(archive, path.join(out, "collide"), proof(archive))).toThrow()
    rmSync(scopedFile)
    writeFileSync(file, JSON.stringify({ slug: "daily", schedule: "0 9 * * *", workdir: "relative" }))
    archive = captureLegacyArchive(root)
    expect(() => stageLegacyMigration(archive, path.join(out, "relative"), proof(archive))).toThrow()
    writeFileSync(file, JSON.stringify({ slug: "daily", schedule: "0 9 * * *", workdir, scopeId: "other-scope" }))
    archive = captureLegacyArchive(root)
    expect(() => stageLegacyMigration(archive, path.join(out, "foreign"), proof(archive))).toThrow()
    addJob(root, "daily", workdir)
    const manifest = path.join(path.dirname(scopedFile), "..", "windows-tasks", "daily.json")
    mkdirSync(path.dirname(manifest), { recursive: true })
    writeFileSync(manifest, "{}")
    archive = captureLegacyArchive(root)
    expect(() => stageLegacyMigration(archive, path.join(out, "os-unknown"), proof(archive))).toThrow()
  }))

  test("symlink sources and hidden file types are refused before export", () => fixture((root, out) => {
    const workdir = path.join(root, "workspace")
    mkdirSync(workdir)
    const source = addJob(root, "daily", workdir)
    const linked = path.join(root, "jobs", "alias.json")
    symlinkSync(source, linked, "file")
    expect(() => captureLegacyArchive(root)).toThrow()
    expect(existsSync(path.join(out, "versioned.json"))).toBe(false)
  }))

  test("export rejects writing backup into the source config tree", () => fixture((root) => {
    const workdir = path.join(root, "workspace")
    mkdirSync(workdir)
    addJob(root, "daily", workdir)
    const archive = captureLegacyArchive(root)
    const forbidden = path.join(root, "versioned-backup.json")
    expect(() => exportLegacyArchive(archive, forbidden)).toThrow(/outside live configuration/)
    expect(existsSync(forbidden)).toBe(false)
  }))
})
