import { readFileSync } from "node:fs"
import { assessForeignTaskNondeletion } from "../src/windows-acl-evidence"
if (process.platform !== "win32" || (process.env.GITHUB_ACTIONS !== "true" &&
    process.env.SCHEDULER_ACL_MANUAL_CONSENT !== "disposable-vm-only") ||
    process.env.SCHEDULER_ACL_EPHEMERAL_APPROVAL !== "fixture-only") {
  throw new Error("Ephemeral runner qualification only")
}
const path = process.env.SCHEDULER_ACL_EVIDENCE
if (!path) throw new Error("Missing cross-user owner evidence")
assessForeignTaskNondeletion(JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")))
console.log("CROSS_USER_ACL_EVIDENCE_INVARIANTS_PASS")
