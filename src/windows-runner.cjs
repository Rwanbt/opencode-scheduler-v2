"use strict";
// Standalone Node Windows Task Scheduler runner. No plugin host or model import.
// Engine origin: different-ai/opencode-scheduler, licensed MIT.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const jobPath = process.argv[2];
const scopesDirectory = jobPath ? path.dirname(path.dirname(path.dirname(jobPath))) : "";
const schedulerDirectory = path.dirname(scopesDirectory);
if (!jobPath || !path.win32.isAbsolute(jobPath)) {
  console.error("scheduler: absolute job file required");
  process.exit(2);
}

let job;
try { job = JSON.parse(fs.readFileSync(jobPath, "utf8")); }
catch (error) { console.error("scheduler: unreadable job file", error.message); process.exit(2); }

// The scoped job metadata is the authority for this execution, never an
// arbitrary command supplied on Task Scheduler's command line.
if (!/^[a-z0-9-]+$/.test(job.scopeId ?? "") || !/^[a-z0-9-]+$/.test(job.slug ?? "") ||
    path.basename(jobPath) !== `${job.slug}.json` ||
    path.basename(path.dirname(jobPath)) !== "jobs" ||
    path.basename(path.dirname(path.dirname(jobPath))) !== job.scopeId ||
    path.basename(scopesDirectory) !== "scopes" ||
    path.basename(schedulerDirectory) !== "scheduler") {
  console.error("scheduler: invalid scoped job identity");
  process.exit(2);
}

const scopeRoot = path.dirname(path.dirname(jobPath));
const locks = path.join(scopeRoot, "locks");
const logs = path.resolve(scopeRoot, "..", "..", "..", "logs", "scheduler", job.scopeId);
fs.mkdirSync(locks, { recursive: true });
fs.mkdirSync(logs, { recursive: true });
const lock = path.join(locks, `${job.slug}.lock`);
const logPath = path.join(logs, `${job.slug}.log`);
const output = fs.createWriteStream(logPath, { flags: "a" });
const write = (text) => output.write(`[${new Date().toISOString()}] ${text}\n`);

// Atomic lock acquisition. Unknown or inaccessible owner => fail closed.
let fd;
try { fd = fs.openSync(lock, "wx"); }
catch (error) {
  if (error.code !== "EEXIST") throw error;
  let owner;
  try { owner = JSON.parse(fs.readFileSync(lock, "utf8")); }
  catch { write("lock owner unreadable; manual review required"); process.exit(3); }
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) process.exit(3);
  try { process.kill(owner.pid, 0); write("skipping overlapping scheduled run"); process.exit(0); }
  catch (check) { if (check.code !== "ESRCH") process.exit(3); }
  // No automatic stale-lock deletion: only an administrator can clear one.
  write("stale lock detected; manual review required");
  process.exit(3);
}
fs.writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
fs.closeSync(fd);

let child;
let finished = false;
const release = () => { try { fs.unlinkSync(lock); } catch {} };
const save = (status, code, error) => {
  try {
    const current = JSON.parse(fs.readFileSync(jobPath, "utf8"));
    if (current.slug !== job.slug || current.scopeId !== job.scopeId) return;
    const next = { ...current, lastRunStatus: status, lastRunExitCode: code, lastRunError: error,
      updatedAt: new Date().toISOString(), lastRunSource: "scheduled" };
    const temp = `${jobPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2));
    fs.renameSync(temp, jobPath);
  } catch (e) { write(`could not persist run status: ${e.message}`); }
};
const finish = (status, code, error) => {
  if (finished) return;
  finished = true;
  save(status, code, error);
  write(`finished ${status} exit=${code} ${error ?? ""}`);
  release();
  output.end();
  process.exitCode = code ?? 1;
};

const invocation = job.invocation;
if (!invocation || typeof invocation.command !== "string" || !path.win32.isAbsolute(invocation.command) ||
  !/^opencode(?:-cli)?\.exe$/i.test(path.win32.basename(invocation.command)) ||
  !fs.existsSync(invocation.command) || !Array.isArray(invocation.args) ||
  !invocation.args.every((arg) => typeof arg === "string") ||
  !invocation.args.includes("--") || !invocation.args.includes("run") ||
  !invocation.args[invocation.args.length - 1]?.trim()) {
  finish("failed", 2, "missing or unsafe OpenCode invocation");
} else if (!job.workdir || !path.win32.isAbsolute(job.workdir) || !fs.existsSync(job.workdir)) {
  finish("failed", 2, "missing absolute job workdir");
} else {
  // Noninteractive policy: deny questions, write tools, and shells by default.
  // A user can create more privileged jobs only through an explicit change.
  let existing = {};
  try { existing = JSON.parse(process.env.OPENCODE_PERMISSION || "{}"); } catch {}
  const permission = { ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}),
    question: "deny", edit: "deny", bash: "deny", external_directory: "deny" };
  const env = { ...process.env, OPENCODE_PERMISSION: JSON.stringify(permission) };
  write(`starting ${job.slug}, workspace=${job.workdir}`);
  save("running", undefined, undefined);
  try {
    child = spawn(invocation.command, invocation.args, { cwd: job.workdir, env, shell: false,
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.pipe(output, { end: false });
    child.stderr?.pipe(output, { end: false });
    child.once("error", (error) => finish("failed", 1, error.message));
    child.once("close", (code) => finish(code === 0 ? "success" : "failed", code ?? 1));
    const timeout = Number(job.timeoutSeconds);
    if (Number.isFinite(timeout) && timeout > 0) {
      const timer = setTimeout(() => {
        if (finished || !child?.pid) return;
        write(`timeout after ${timeout} seconds; terminating process tree`);
        spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).unref();
        finish("failed", 124, "timeout");
      }, Math.min(timeout, 86_400) * 1000);
      timer.unref();
    }
  } catch (error) { finish("failed", 1, error.message); }
}
