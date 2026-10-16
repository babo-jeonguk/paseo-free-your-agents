// Platform boundary shared by the plugin server and the standalone bridges.
// Linux: owner-only modes, Unix sockets, /proc identities and process groups.
// Windows: per-user profile ACLs, named pipes, process start times and taskkill.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

export const windows = process.platform === "win32";
export const controlSupported = process.platform === "linux" || windows;

// Windows reports uid 0 and mode 0o666 for every file. Privacy there comes from
// the per-user profile and temp directory ACLs that plugin data inherits.
export function ownerOnly(info, mode) {
  return windows || (info.uid === process.getuid?.() && (info.mode & 0o777) === mode);
}

// A fresh unguessable pipe per bridge. The capability token still authenticates
// every request; the name only has to be unique and private to its record.
export const newControlPipe = () => `\\\\.\\pipe\\paseo-rc-${randomUUID()}`;
export const isControlPipe = (path) =>
  windows && typeof path === "string" && /^\\\\\.\\pipe\\paseo-rc-[a-f0-9-]{36}$/.test(path);

// Linux: start time in clock ticks after boot, null when the process is gone and
// undefined when it cannot be read.
export async function linuxStart(pid) {
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const start = text
      .slice(text.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/)[19];
    return /^\d+$/.test(start ?? "") ? start : undefined;
  } catch (error) {
    return error.code === "ENOENT" ? null : undefined;
  }
}

// This process's birth identity. Windows has no cheap self-query, so it records
// Node's start in epoch milliseconds; readers compare it with the OS creation
// time within a tolerance.
export async function ownStart() {
  if (windows) return String(Math.round(performance.timeOrigin));
  return linuxStart(process.pid);
}

// False only when the OS confirms the PID is gone. Access errors keep it alive.
export function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

const systemFile = (...parts) =>
  join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32", ...parts);
const envValue = (env, name) => {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
};
const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

// Windows CreateProcess searches neither PATHEXT nor command scripts. Resolve the
// way a shell would, without the current directory, so `codex` finds codex.cmd.
export function resolveWindowsCommand(command, env = process.env) {
  const extensions = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  const variants = (base) => [
    ...(extname(base) ? [base] : []),
    ...extensions.map((extension) => base + extension.toLowerCase()),
  ];
  if (/[\\/]/.test(command)) return variants(command).find(isFile) ?? command;
  for (const directory of (envValue(env, "PATH") ?? "").split(";")) {
    const unquoted = directory.trim().replace(/^"(.*)"$/, "$1");
    if (!unquoted) continue;
    const found = variants(join(unquoted, command)).find(isFile);
    if (found) return found;
  }
  return command;
}

const cmdMeta = /([()\][%!^"`<>&|;, *?])/g;
// Quote for the C runtime, then caret-escape every cmd.exe metacharacter twice:
// once for this cmd.exe and once for the script's own `%*` forwarding line.
function cmdArgument(value) {
  const quoted =
    '"' +
    value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1") +
    '"';
  return quoted.replace(cmdMeta, "^$1").replace(cmdMeta, "^$1");
}

// How a bridge starts a native CLI. Linux gives it its own process group so a
// stop reaches its helpers. Windows resolves the command and runs command
// scripts through cmd.exe without letting it interpret the arguments.
export function nativeCommand(command, args, env = process.env) {
  if (!windows) return { file: command, args, options: { detached: true } };
  const file = resolveWindowsCommand(command, env);
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args, options: { windowsHide: true } };
  const line = [file.replace(cmdMeta, "^$1"), ...args.map(cmdArgument)].join(" ");
  return {
    file: systemFile("cmd.exe"),
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsHide: true, windowsVerbatimArguments: true },
  };
}

// Signal a native CLI the bridge spawned, with its helpers. Windows has neither
// process groups nor console signals for a hidden child, so every signal force
// stops the tree. The bridge still holds the child's handle, so its PID cannot
// have been reused.
export function signalNative(child, name) {
  if (!windows) {
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    return;
  }
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  execFile(
    systemFile("taskkill.exe"),
    ["/PID", String(child.pid), "/T", "/F"],
    { windowsHide: true, timeout: 10_000 },
    () => {
      // The tree can finish on its own before taskkill reaches it.
    },
  );
}
