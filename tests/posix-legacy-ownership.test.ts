import { describe, expect, test } from "bun:test"
import { assertSafeSystemdValue, stripManagedCronBlocks } from "../src/engine"

describe("POSIX legacy scheduler ownership and injected unit lines", () => {
  const scoped = "workspace-abc123:daily"
  const unscoped = "legacy:daily"
  const block = (id: string, line: string) =>
    ["# BEGIN opencode-scheduler " + id, line, "# END opencode-scheduler " + id].join("\n")

  test("deletion targets only the explicitly scoped cron block", () => {
    const legacy = block(unscoped, "0 9 * * * legacy-service")
    const owned = block(scoped, "0 9 * * * scoped-service")
    const other = "1 2 * * * unrelated-service"
    const result = stripManagedCronBlocks([legacy, owned, other].join("\n"), new Set([scoped]))
    expect(result.removed).toBe(1)
    expect(result.content).toContain(legacy)
    expect(result.content).toContain(other)
    expect(result.content).not.toContain("scoped-service")
  })

  test("torn or unclosed blocks reject mutation rather than deleting following entries", () => {
    const invalid = "# BEGIN opencode-scheduler " + scoped + "\n0 9 * * * managed\n1 2 * * * unrelated"
    expect(() => stripManagedCronBlocks(invalid, new Set([scoped])))
      .toThrow(/Unterminated Scheduler/)
    expect(() => stripManagedCronBlocks(invalid, new Set([unscoped])))
      .toThrow(/Unterminated Scheduler/)
  })

  test("systemd unit fields refuse newline directives and unit specifiers", () => {
    for (const invalid of ["user\nExecStart=/bin/false", "path\r\n[Service]", "%n", "name\0null", "line\ttab"]) {
      expect(() => assertSafeSystemdValue(invalid)).toThrow(/Unsafe control or specifier/)
    }
    expect(() => assertSafeSystemdValue("Sommières / projet")).not.toThrow()
  })
})
