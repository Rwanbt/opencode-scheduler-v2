import { z } from "zod"
import SchedulerPlugin from "opencode-scheduler"

export default {
  id: "local.v2.scheduler",
  setup: async (context: any) => {
    try {
      const hooks = await (SchedulerPlugin as any)()
      const toolDefs: Record<string, any> = hooks?.tool ?? {}
      await context.tool.transform((draft: any) => {
        for (const [name, def] of Object.entries<any>(toolDefs)) {
          let input: any
          try {
            input = z.toJSONSchema(z.object(def.args ?? {}))
          } catch {
            input = { type: "object", properties: {}, additionalProperties: true }
          }
          draft.add({
            name,
            description: def.description,
            input,
            execute: async (args: any, toolContext: any) => {
              const r = await def.execute(args, toolContext)
              return typeof r === "string" ? { content: r } : r ?? { content: "" }
            },
          })
        }
      })
    } catch (e) {
      console.error("[scheduler-v2] setup failed:", e)
    }
    return () => {}
  },
}
