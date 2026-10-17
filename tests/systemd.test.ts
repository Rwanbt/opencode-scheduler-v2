import { describe, test, expect } from "bun:test"
import { cronToSystemdCalendars } from "../src/engine"

describe("systemd OnCalendar portable rendering", () => {
  test("omits wildcard weekday prefix rather than emitting illegal '* *-...'", () => {
    const calendar = cronToSystemdCalendars("0 9 * * *")
    expect(calendar).toContain("*-*-* 09:00:00")
    expect(calendar.every((value) => !value.startsWith("* "))).toBe(true)
  })
  test("keeps actual weekday constraints", () => {
    const calendar = cronToSystemdCalendars("15 8 * * 1")
    expect(calendar.some((value) => value.startsWith("Mon *-*-* 08:15:00"))).toBe(true)
  })
  test("quarter-hour schedules never emit a bare weekday wildcard", () => {
    const calendar = cronToSystemdCalendars("*/15 * * * *")
    expect(calendar.length).toBeGreaterThan(0)
    expect(calendar.every((value) => !value.startsWith("* "))).toBe(true)
  })
})