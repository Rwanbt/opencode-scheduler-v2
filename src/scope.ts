import { AsyncLocalStorage } from "node:async_hooks"
import path from "node:path"

const activeProject = new AsyncLocalStorage<string>()

export function runInProject<T>(project: string, callback: () => T): T {
  if (!path.isAbsolute(project)) throw new Error("Scheduler requires an absolute OpenCode project directory")
  return activeProject.run(path.resolve(project), callback)
}

export function projectDirectory(): string {
  const project = activeProject.getStore()
  if (!project) throw new Error("Scheduler call has no attested OpenCode project directory")
  return project
}
