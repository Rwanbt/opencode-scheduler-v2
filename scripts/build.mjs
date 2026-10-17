import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync } from "node:fs"
const result = spawnSync("bun", ["build", "src/plugin.ts", "--outfile=dist/index.js", "--target=bun", "--format=esm"], {
  stdio: "inherit", shell: process.platform === "win32",
})
if (result.status !== 0) process.exit(result.status || 1)
mkdirSync("dist", { recursive: true })
copyFileSync("src/windows-runner.cjs", "dist/windows-runner.cjs")
