import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = mkdtempSync(path.join(tmpdir(), "scheduler-record-scope-"))
const home = path.join(root, "home")
const a = path.join(root, "workspace-a")
const b = path.join(root, "workspace-b")
mkdirSync(home); mkdirSync(a); mkdirSync(b)
// Must isolate before importing the engine, which computes a home path once.
process.env.HOME = home
process.env.USERPROFILE = home
const normalize = (dir) => path.resolve(dir)
const slugify = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
function scope(workdir) {
  let hash = 0xcbf29ce484222325n
  for (const octet of Buffer.from(normalize(workdir), "utf8")) hash = (hash ^ BigInt(octet)) * 0x100000001b3n & 0xffffffffffffffffn
  return `${slugify(path.basename(workdir))}-${hash.toString(16).padStart(16, "0").slice(0,12)}`
}
const scopedJob = (workdir, slug) => path.join(home, ".config", "opencode", "scheduler", "scopes", scope(workdir), "jobs", `${slug}.json`)
const now = new Date().toISOString()
const makeRecord = (directory, slug, name) => ({ scopeId: scope(directory), slug, name,
  schedule: "0 9 * * *", workdir: directory, prompt: `private ${name}`, createdAt: now })
async function registry(directory, plugin) {
  const definitions = new Map()
  const unload = await plugin.setup({ directory, tool: { transform: (register) => register({ add: (item) => definitions.set(item.name, item) }) } })
  return { definitions, unload }
}
async function call(wrapper, name, args) {
  const result = await wrapper.definitions.get(name).execute({ format: "json", ...args }, {})
  return JSON.parse(result.content)
}
try {
  const original = process.env.HOME
  assert.equal(homedir(), original, "fixture must isolate HOME before importing engine")
  const entry = await import(pathToFileURL(path.resolve("dist/index.js")).href)
  const A = await registry(a, entry.default)
  const B = await registry(b, entry.default)
  try {
    const ownA = scopedJob(a, "own-a")
    const ownB = scopedJob(b, "own-b")
    const forged = scopedJob(a, "foreign")
    const wrongFileSlug = scopedJob(a, "filename")
    const badWorkdir = scopedJob(a, "wrong-workdir")
    const oversized = scopedJob(a, "oversized")
    for (const p of [ownA, ownB, forged, wrongFileSlug, badWorkdir, oversized]) mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(ownA, JSON.stringify(makeRecord(a, "own-a", "OWN_A")))
    writeFileSync(ownB, JSON.stringify(makeRecord(b, "own-b", "OWN_B")))
    // A file physically stored in A's scope MUST NOT grant access to B's
    // tasks merely by claiming B's scopeId/workdir in its JSON contents.
    writeFileSync(forged, JSON.stringify(makeRecord(b, "foreign", "FOREIGN_SECRET")))
    writeFileSync(wrongFileSlug, JSON.stringify(makeRecord(a, "different-slug", "WRONG_FILENAME")))
    writeFileSync(badWorkdir, JSON.stringify({ ...makeRecord(a, "wrong-workdir", "WRONG_WORKDIR"), workdir: b }))
    writeFileSync(oversized, JSON.stringify(makeRecord(a, "oversized", "OVERSIZED_SECRET")) + " ".repeat(1024 * 1024))
    const before = readFileSync(ownB, "utf8")
    const listingA = await call(A, "list_jobs", {})
    const listingB = await call(B, "list_jobs", {})
    assert.equal(listingA.success, true, JSON.stringify(listingA))
    assert.equal(listingB.success, true, JSON.stringify(listingB))
    assert.deepEqual(listingA.data.jobs.map((j) => j.name), ["OWN_A"], "A must ignore mismatched physical scope records")
    assert.deepEqual(listingB.data.jobs.map((j) => j.name), ["OWN_B"], "B must see only its own records")
    const poisonedLookup = await call(A, "get_job", { name: "foreign" })
    assert.equal(poisonedLookup.success, false, "a forged job may not be opened using its foreign scopeId")
    const poisonedDelete = await call(A, "delete_job", { name: "foreign" })
    assert.equal(poisonedDelete.success, false, "a forged job may not route deletion to another scope")
    // First prove the ordinary (unapproved) host cannot authorize model work.
    await assert.rejects(() => call(A, "update_job", { name: "foreign", schedule: "15 8 * * *" }),
      /token\/cost budget authority/)
    // Then preserve the independent cross-scope assertion under the isolated
    // no-inference acceptance mode. No OS task or model will be invoked.
    process.env.OPENCODE_SCHEDULER_HOST_NO_INFERENCE = "explicit-disposable-task"
    process.env.OPENCODE_SCHEDULER_CI_NO_INFERENCE = "acknowledged-fixture-only"
    try {
      const poisonedUpdate = await call(A, "update_job", { name: "foreign", schedule: "15 8 * * *" })
      assert.equal(poisonedUpdate.success, false, "a forged job may not be updated under a foreign scope")
    } finally {
      delete process.env.OPENCODE_SCHEDULER_HOST_NO_INFERENCE
      delete process.env.OPENCODE_SCHEDULER_CI_NO_INFERENCE
    }
    for (const name of ["filename", "wrong-workdir", "oversized", "../../other/scope"]) {
      const checked = await call(A, "get_job", { name })
      assert.equal(checked.success, false, `untrusted record must be rejected: ${name}`)
    }
    assert.equal(readFileSync(ownB, "utf8"), before)
    console.log("NATIVE_SCOPED_RECORD_INTEGRITY_PASS: two workspaces, no cross-scope record read")
  } finally {
    if (typeof A.unload === "function") await A.unload()
    if (typeof B.unload === "function") await B.unload()
  }
} finally { rmSync(root, { recursive: true, force: true }) }
