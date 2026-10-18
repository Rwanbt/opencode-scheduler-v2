import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = mkdtempSync(path.join(tmpdir(), "scheduler-v13-cli-"))
const config = path.join(root, "config")
const workspace = path.join(root, "project")
const out = path.join(root, "out")
mkdirSync(path.join(config, "jobs"), { recursive: true })
mkdirSync(workspace)
mkdirSync(out)
const source = path.join(config, "jobs", "daily.json")
writeFileSync(source, JSON.stringify({
  slug: "daily", name: "daily", workdir: workspace, schedule: "0 9 * * *", prompt: "NO INFERENCE",
}))
const snapshot = readFileSync(source)
const script = path.resolve("scripts/legacy-migration.mjs")
function cli(...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 12000 })
}
try {
  const preview = cli("--root", config)
  assert.equal(preview.status, 0, preview.stderr)
  const plan = JSON.parse(preview.stdout)
  assert.equal(plan.dryRun, true)
  assert.equal(plan.candidates.length, 1)
  assert.equal(plan.candidates[0].verdict, "eligible")
  assert.equal(existsSync(path.join(config, "scheduler")), false)

  const archive = path.join(out, "version-1.json")
  assert.equal(cli("export", "--root", config, "--out", archive).status, 0)
  assert.equal(existsSync(archive), true)
  const proofFile = path.join(out, "ownership.json")
  const { path: relative, sha256, workdir } = plan.candidates[0]
  writeFileSync(proofFile, JSON.stringify([{ path: relative, sha256, workdir, acknowledgedByOperator: true }]))
  const stage = path.join(out, "staged")
  const staged = cli("stage", "--archive", archive, "--out", stage, "--proofs", proofFile)
  assert.equal(staged.status, 0, staged.stderr)
  assert.equal(JSON.parse(staged.stdout).offlineOnly, true)
  assert.equal(existsSync(path.join(config, "scheduler")), false)
  const restored = path.join(out, "restored")
  const recovered = cli("restore", "--archive", archive, "--out", restored)
  assert.equal(recovered.status, 0, recovered.stderr)
  assert.deepEqual(readFileSync(path.join(restored, "jobs", "daily.json")), snapshot)
  assert.deepEqual(readFileSync(source), snapshot)

  writeFileSync(source, JSON.stringify({ ...JSON.parse(snapshot), schedule: "15 12 * * *" }))
  const stale = cli("stage", "--archive", archive, "--out", path.join(out, "stale"), "--proofs", proofFile)
  assert.notEqual(stale.status, 0)
  assert.match(stale.stderr, /changed since export/)
  console.log("SCHEDULER_V13_OFFLINE_MIGRATION_BACKUP_ROLLBACK_PASS")
} finally {
  rmSync(root, { recursive: true, force: true })
}
