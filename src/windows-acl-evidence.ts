export interface ForeignTaskEvidence {
  runnerSid: string
  childSid: string
  createdTaskPrincipalSid: string
  expectedForeignTask: string
  foreignTaskBefore: string[]
  foreignTaskAfter: string[]
  ownedTaskNames: string[]
  deletedOwnedTasks: string[]
  backendMutationSucceeded: boolean
}

export function assessForeignTaskNondeletion(e: ForeignTaskEvidence): void {
  const sid = /^S-1-5(?:-\d+){2,}$/
  const task = /^\\OpenCode\\opencode-job-[a-z0-9-]+$/i
  if (!sid.test(e.runnerSid) || !sid.test(e.childSid) || !sid.test(e.createdTaskPrincipalSid) ||
      e.runnerSid === e.childSid || e.childSid !== e.createdTaskPrincipalSid) {
    throw new Error("Distinct authenticated task principal was not proved")
  }
  if (!task.test(e.expectedForeignTask) || !e.backendMutationSucceeded || !e.ownedTaskNames.length) {
    throw new Error("Task Scheduler native execution evidence incomplete")
  }
  if (!e.foreignTaskBefore.includes(e.expectedForeignTask) ||
      !e.foreignTaskAfter.includes(e.expectedForeignTask)) {
    throw new Error("Foreign-owned task was absent or was deleted")
  }
  if (e.ownedTaskNames.some((name) => !task.test(name) || name === e.expectedForeignTask) ||
      e.deletedOwnedTasks.length !== e.ownedTaskNames.length ||
      e.deletedOwnedTasks.some((name) => !e.ownedTaskNames.includes(name)) ||
      new Set(e.deletedOwnedTasks).size !== e.deletedOwnedTasks.length) {
    throw new Error("Scoped deletion lacks exact confirmed task identity")
  }
}
