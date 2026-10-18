import { test, expect } from "bun:test"
import { assessForeignTaskNondeletion, type ForeignTaskEvidence } from "../src/windows-acl-evidence"

const foreign = "\\OpenCode\\opencode-job-foreign-421"
const owned = "\\OpenCode\\opencode-job-owned-421"
const good: ForeignTaskEvidence = {
  runnerSid: "S-1-5-21-1000-1100-1200-500",
  childSid: "S-1-5-21-1000-1100-1200-1001",
  createdTaskPrincipalSid: "S-1-5-21-1000-1100-1200-1001",
  expectedForeignTask: foreign,
  foreignTaskBefore: [foreign], foreignTaskAfter: [foreign],
  ownedTaskNames: [owned], deletedOwnedTasks: [owned], backendMutationSucceeded: true,
}
test("cross-user evidence must verify two real distinct SIDs and exact survivor", () => {
  expect(() => assessForeignTaskNondeletion(good)).not.toThrow()
  const invalid = [
    { childSid: good.runnerSid },
    { createdTaskPrincipalSid: good.runnerSid },
    { childSid: "UNVERIFIED_ACCOUNT" },
    { foreignTaskBefore: [] },
    { foreignTaskAfter: [] },
    { backendMutationSucceeded: false },
    { deletedOwnedTasks: [] },
    { deletedOwnedTasks: [foreign] },
    { ownedTaskNames: [owned, foreign] },
    { deletedOwnedTasks: [owned, owned] },
    { expectedForeignTask: "\\OpenCode\\other-foreign" },
  ] as Partial<ForeignTaskEvidence>[]
  for (const altered of invalid) expect(() => assessForeignTaskNondeletion({ ...good, ...altered })).toThrow()
})
