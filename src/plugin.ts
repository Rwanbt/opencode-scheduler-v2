import { z } from "zod"
import SchedulerPlugin from "./engine.js"
import { runInProject } from "./scope.js"

type ToolEditor = { add(definition: {
  name: string
  description: string
  input: Record<string, unknown>
  execute: (args: unknown, context: unknown) => Promise<{ content: string }>
}): void }

type NativeContext = {
  directory?: string
  location?: { directory?: string }
  tool?: { transform(callback: (editor: ToolEditor) => void): Promise<void> }
}

export const SchedulerPluginV2 = {
  id: "rwanbt.scheduler.v2",
  async setup(context: NativeContext) {
    const project = context.location?.directory ?? context.directory
    if (!project || !context.tool?.transform) {
      throw new Error("Scheduler V2 requires a native tool registry and an attested project directory")
    }

    // Preserve the original tool contract, but keep each invocation in its own
    // project context. A long-lived Desktop host can serve multiple workspaces.
    const v1 = await (SchedulerPlugin as unknown as () => Promise<{ tool?: Record<string, {
      args?: Record<string, unknown>
      description: string
      execute: (args: never, context: never) => Promise<unknown>
    }> }>)()
    const definitions = v1?.tool ?? {}
    await context.tool.transform((editor) => {
      for (const [name, definition] of Object.entries(definitions)) {
        // Fail closed on untranslatable schemas. A permissive {} schema would
        // turn destructive scheduler tools into unvalidated inputs.
        const input = z.toJSONSchema(z.object(definition.args ?? {})) as Record<string, unknown>
        if (input.type !== "object" || !input.properties) {
          throw new Error(`Invalid scheduler tool input schema: ${name}`)
        }
        editor.add({
          name,
          description: definition.description,
          input,
          execute: async (args, toolContext) => runInProject(project, async () => {
            const result = await definition.execute(args as never, toolContext as never)
            if (typeof result === "string") return { content: result }
            if (result && typeof result === "object" && "output" in result && typeof result.output === "string") {
              return { content: result.output }
            }
            throw new Error(`Scheduler tool ${name} returned an unsupported output shape`)
          }),
        })
      }
    })
    return () => {}
  },
}

export default SchedulerPluginV2
