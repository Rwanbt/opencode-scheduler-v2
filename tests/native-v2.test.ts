import { describe, expect, test } from "bun:test"
import { runInProject, projectDirectory } from "../src/scope"
import SchedulerPluginV2 from "../src/plugin"
import path from "node:path"

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
    await SchedulerPluginV2.setup({
      directory: "D:\\Safe-Project",
      tool: { transform: async (register) => register({ add: (tool) => {
        names.push(tool.name)
        schemas[tool.name] = tool.input
      } }) },
    })
    expect(names).toContain("schedule_job")
    expect(names).toContain("delete_job")
    expect(names).toContain("list_jobs")
    expect(names).not.toContain("cleanup_global")
    expect(schemas.schedule_job.type).toBe("object")
    expect(schemas.schedule_job.properties.schedule).toBeDefined()
    expect(schemas.schedule_job.additionalProperties).not.toBe(true)
  })
})
