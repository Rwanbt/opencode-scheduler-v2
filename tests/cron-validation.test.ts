import { describe, expect, test } from "bun:test"
import { validateCronExpression } from "../src/engine"

describe("cron injection and phantom schedule rejection", () => {
  test("accepts supported five-field numeric, list, and bounded interval schedules", () => {
    for (const expression of ["0 9 * * *", "*/15 * * * *", "30 8 * * 1", "0 9 1,15 1,7 *", "0 */6 * * *"]) {
      expect(() => validateCronExpression(expression)).not.toThrow()
    }
  })

  test("rejects line breaks and control bytes before writing crontab", () => {
    for (const expression of [
      "0 9 * * *\n* * * * * /bin/sh",
      "0 9 * * *\n",
      "\n0 9 * * *",
      "0\t9 * * *",
      "0 9 * * *\r",
      "0 9 * * *\0",
      "0 9 * * *\u2028",
      "0 9 * * *" + " ".repeat(130),
    ]) {
      expect(() => validateCronExpression(expression)).toThrow(/Invalid cron/)
    }
  })

  test("rejects parseInt prefix acceptance, malformed steps and overflow", () => {
    for (const expression of [
      "*/5payload * * * *",
      "*/61 * * * *",
      "*/999999999999999999999 * * * *",
      "*/0 * * * *",
      "*/01 * * * *",
      "1,2oops 9 * * *",
      "0 9 1,2;echo * *",
      "0 9 * * 1foo",
      "0 9 * * 90071992547409931234",
    ]) {
      expect(() => validateCronExpression(expression)).toThrow(/Invalid cron/)
    }
  })
})
