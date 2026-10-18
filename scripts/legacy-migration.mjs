import { readFileSync } from "node:fs"
import path from "node:path"
import {
  captureLegacyArchive, exportLegacyArchive, previewLegacyMigration,
  readLegacyArchive, restoreLegacyArchive, stageLegacyMigration,
} from "../dist/legacy-migration.js"

function usage() {
  throw new Error("Usage: node scripts/legacy-migration.mjs [preview|export|stage|restore] --root ABSOLUTE_CONFIG [--archive ABSOLUTE_JSON] [--out ABSOLUTE_NEW_PATH] [--proofs ABSOLUTE_JSON]; default preview")
}
const args = process.argv.slice(2)
const action = args[0]?.startsWith("--") || !args.length ? "preview" : args.shift()
const flags = new Map()
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith("--") || args[i + 1] === undefined || flags.has(args[i])) usage()
  flags.set(args[i], args[i + 1])
}
if (!new Set(["preview", "export", "stage", "restore"]).has(action) ||
    [...flags.keys()].some((flag) => !["--root", "--archive", "--out", "--proofs"].includes(flag))) usage()
const requireAbsolute = (flag) => {
  const value = flags.get(flag)
  if (!value || !path.isAbsolute(value)) usage()
  return path.resolve(value)
}

try {
  if (action === "preview" || action === "export") {
    const archive = captureLegacyArchive(requireAbsolute("--root"))
    const preview = previewLegacyMigration(archive)
    console.log(JSON.stringify({ action, dryRun: action === "preview", candidates: preview,
      artifacts: archive.artifacts.length }, null, 2))
    if (action === "export") exportLegacyArchive(archive, requireAbsolute("--out"))
  } else {
    const archive = readLegacyArchive(requireAbsolute("--archive"))
    if (action === "restore") {
      restoreLegacyArchive(archive, requireAbsolute("--out"))
      console.log("Verified original artifacts restored to a new isolated directory; no OS tasks modified")
    } else {
      // An old backup is never sufficient evidence that the live source
      // remains the same: check source bytes again before staging.
      const fresh = captureLegacyArchive(archive.sourceRoot)
      if (JSON.stringify(fresh.artifacts) !== JSON.stringify(archive.artifacts)) {
        throw new Error("Live source has changed since export: regenerate the versioned backup")
      }
      const proofs = JSON.parse(readFileSync(requireAbsolute("--proofs"), "utf8"))
      const candidates = stageLegacyMigration(archive, requireAbsolute("--out"), proofs)
      console.log(JSON.stringify({ action, offlineOnly: true, staged: candidates.map((x) => x.target) }, null, 2))
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
