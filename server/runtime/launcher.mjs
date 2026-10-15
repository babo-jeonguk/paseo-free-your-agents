import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";

const profilePath = process.argv[2],
  args = process.argv.slice(3);
const directory = await lstat(dirname(profilePath));
if (
  !directory.isDirectory() ||
  directory.isSymbolicLink() ||
  directory.uid !== process.getuid?.() ||
  (directory.mode & 0o777) !== 0o700
)
  throw new Error("Invalid runtime launch profile directory");
const file = await open(profilePath, constants.O_RDONLY | constants.O_NOFOLLOW);
let profile;
try {
  const info = await file.stat();
  if (
    !info.isFile() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o600 ||
    info.size > 65536
  )
    throw new Error("Invalid runtime launch profile");
  profile = JSON.parse(await file.readFile("utf8"));
} finally {
  await file.close();
}
if (
  profile.version !== 1 ||
  !["codex", "claude"].includes(profile.provider) ||
  !Array.isArray(profile.command) ||
  !profile.command.length ||
  profile.command.length > 256 ||
  profile.command.some((arg) => typeof arg !== "string" || !arg || arg.length > 16384)
)
  throw new Error("Invalid runtime launch command");
const nativeEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !name.startsWith("RUNTIME_PROXY_") &&
      !["NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE"].includes(name),
  ),
);
const interactive =
  process.platform === "linux" &&
  !!process.env.RUNTIME_PROXY_RECIPE_FILE &&
  (profile.provider === "codex" ? args.includes("app-server") : args.includes("stream-json")) &&
  !args.includes("--version");
if (!interactive) {
  // No recipe after plugin removal, or a version/catalog/history invocation:
  // forward the original argv/environment. Never try to adopt these processes.
  const child = spawn(profile.command[0], [...profile.command.slice(1), ...args], {
    env: nativeEnv,
    stdio: "inherit",
    detached: true,
  });
  let force;
  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  for (const name of ["SIGTERM", "SIGINT"])
    process.on(name, () => {
      signal(name);
      force ??= setTimeout(() => signal("SIGKILL"), 2000);
    });
  child.on("error", () => process.exit(1));
  child.on("exit", (code, signal) => {
    clearTimeout(force);
    process.exit(code ?? (signal ? 1 : 0));
  });
} else {
  if (profile.provider === "claude") {
    // Do not inject an observer into an unvalidated CLI initialization. Failed
    // probes disable process control while preserving ordinary CLI behavior.
    try {
      const { stdout } = await promisify(execFile)(
        profile.command[0],
        [...profile.command.slice(1), "--version"],
        { env: nativeEnv, timeout: 5000, maxBuffer: 4096 },
      );
      if (/^2\.1\.299(?:\s|$)/.test(stdout.trim()))
        process.env.RUNTIME_PROXY_CLAUDE_VALIDATED = "1";
    } catch {
      /* Normal SDK messages still pass through. */
    }
  }
  process.argv = [process.execPath, process.argv[1], ...profile.command, ...args];
  await import(new URL(profile.provider + ".mjs", import.meta.url).href);
}
