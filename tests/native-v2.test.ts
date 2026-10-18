import { describe, expect, test } from "bun:test"
import { runInProject, projectDirectory } from "../src/scope"
import SchedulerPluginV2 from "../src/plugin"
import path from "node:path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"

describe("OpenCode 2 plugin boundary", () => {
  test("project identity is per async request (not process.cwd)", async () => {
    expect(() => projectDirectory()).toThrow()
    const a = runInProject(path.resolve("workspace-a"), async () => {
      await Promise.resolve()
      return projectDirectory()
    })
    const b = runInProject(path.resolve("workspace-b"), async () => {
      await Promise.resolve()
      return projectDirectory()
    })
    const results = await Promise.all([a, b])
    expect(results[0]).not.toBe(results[1])
    expect(() => runInProject("relative", () => null)).toThrow()
  })

  test("refuses unattested project and missing registry before installing tools", async () => {
    await expect(SchedulerPluginV2.setup({})).rejects.toThrow(/attested project/)
    await expect(SchedulerPluginV2.setup({ directory: "C:\\Example" })).rejects.toThrow(/tool registry/)
  })

  test("registers the original tools with converted nonpermissive JSON schemas", async () => {
    const names: string[] = []
    const schemas: Record<string, any> = {}
    const codemode: Record<string, unknown> = {}
    await SchedulerPluginV2.setup({
      directory: "D:\\Safe-Project",
      tool: { transform: async (register) => register({ add: (tool) => {
        names.push(tool.name)
        schemas[tool.name] = tool.input
        codemode[tool.name] = tool.options?.codemode
      } }) },
    })
    expect(names).toContain("schedule_job")
    expect(names).toContain("delete_job")
    expect(names).toContain("list_jobs")
    expect(names).not.toContain("cleanup_global")
    expect(codemode.schedule_job).toBe(false)
    expect(schemas.schedule_job.type).toBe("object")
    expect(schemas.schedule_job.properties.schedule).toBeDefined()
    expect(schemas.schedule_job.additionalProperties).not.toBe(true)
  })

  test("real V2 tool wrappers deny cross-project side effects before engine entry", async () => {
    const registered: Record<string, {execute: (args: unknown, context: unknown) => Promise<unknown>}> = {}
    const home = mkdtempSync(path.join(tmpdir(), "scheduler-v2-attested-"))
    try {
    await SchedulerPluginV2.setup({ directory: home, tool: { transform: async (callback) => callback({
      add: (tool) => { registered[tool.name] = tool },
    }) } })
    expect(registered.list_jobs).toBeDefined()
    expect(registered.schedule_job).toBeDefined()
    expect(registered.cleanup_global).toBeUndefined()
    await expect(registered.list_jobs.execute({ allScopes: true }, {})).rejects.toThrow(/Cross-project/)
    await expect(registered.list_jobs.execute({ includeLegacy: "yes" }, {})).rejects.toThrow(/Cross-project/)
    await expect(registered.schedule_job.execute({ name: "unsafe", schedule: "0 9 * * *", workdir: path.resolve("foreign") }, {}))
      .rejects.toThrow(/active project/)
    // Even an otherwise valid model-generated request must not create an OS
    // task until a certified token/cost authority exists.
    await expect(registered.schedule_job.execute({ name: "no-budget", schedule: "0 9 * * *",
      prompt: "DO_NOT_RUN", workdir: home }, {})).rejects.toThrow(/token\/cost budget/)
    await expect(registered.run_job.execute({ name: "no-budget" }, {})).rejects.toThrow(/token\/cost budget/)
    await expect(registered.update_job.execute({ name: "no-budget", schedule: "0 10 * * *" }, {}))
      .rejects.toThrow(/token\/cost budget/)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })})
