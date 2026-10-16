import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { assertPrivateDirectory } from "./proxy-control";
import { controlSupported, ownerOnly, windows } from "./platform.mjs";

const Command = z.array(z.string().min(1).max(16_384)).min(1).max(256);
const Receipt = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    provider: z.enum(["codex", "claude"]).default("codex"),
    originalCommand: Command.nullable(),
    installedCommand: Command,
    phase: z.enum(["installing", "installed", "restoring", "restored", "cancelled"]),
  })
  .strict();
export type CommandReceipt = z.infer<typeof Receipt>;
export interface CommandReceiptStore {
  read(): Promise<CommandReceipt | null>;
  write(value: CommandReceipt): Promise<void>;
}
export interface CommandSetupStatus {
  state: "not-installed" | "installed" | "pending" | "changed" | "restored";
  // The public API cannot delete a command override. Default restoration leaves
  // an explicit provider command; expose this fact without leaking argv/secrets.
  explicitDefaultOnRestore: boolean;
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const restoredCommand = (receipt: CommandReceipt) => receipt.originalCommand ?? [receipt.provider];

// No startup/cleanup side effects. The caller invokes enable, enableIfNew or restore;
// neither action stops a daemon, conversation, or native process. This boundary
// can later be replaced by a first-class provider-command API.
export function createCommandSetup(input: {
  provider?: "codex" | "claude";
  config: Pick<PluginHandlerContext["paseo"]["config"], "get" | "patch">;
  store: CommandReceiptStore;
  installedCommand?: string[];
  prepareCommand?(originalCommand: string[] | null): Promise<string[]>;
}) {
  if (!controlSupported)
    throw new Error(
      "Free Your Agents command setup is currently validated on Linux and Windows only.",
    );
  const fixedCommand = input.installedCommand ? Command.parse(input.installedCommand) : null;
  if (!fixedCommand && !input.prepareCommand) throw new Error("A runtime command is required.");
  const provider = input.provider ?? "codex";
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  }
  async function currentCommand() {
    const { config } = await input.config.get();
    const command = config.providers[provider]?.command;
    return command === undefined ? null : Command.parse(command);
  }
  async function read() {
    const value = await input.store.read();
    if (value === null) return null;
    const receipt = Receipt.parse(value);
    if (receipt.provider !== provider)
      throw new Error("Command receipt belongs to another provider.");
    return receipt;
  }
  async function describe(receipt: CommandReceipt | null): Promise<CommandSetupStatus> {
    if (!receipt) return { state: "not-installed", explicitDefaultOnRestore: false };
    const current = await currentCommand();
    const owned = same(current, receipt.installedCommand);
    const restored = same(current, restoredCommand(receipt));
    const original = same(current, receipt.originalCommand);
    let state: CommandSetupStatus["state"] = "changed";
    if (receipt.phase === "installed" && owned) state = "installed";
    if (receipt.phase === "restored" && restored) state = "restored";
    if (receipt.phase === "cancelled" && original) state = "not-installed";
    if (receipt.phase === "installing") {
      if (owned) {
        await input.store.write({ ...receipt, phase: "installed" });
        state = "installed";
      } else if (original) state = "pending";
    }
    if (receipt.phase === "restoring") {
      if (restored) {
        await input.store.write({ ...receipt, phase: "restored" });
        state = "restored";
      } else if (owned) state = "pending";
    }
    return { state, explicitDefaultOnRestore: receipt.originalCommand === null };
  }
  async function patchIfUnchanged(
    receipt: CommandReceipt,
    expected: string[] | null,
    command: string[],
  ) {
    // Recheck after durable intent, so edits observed during setup win. Stock
    // config.patch has no revision/CAS: an edit to this SAME field admitted
    // between this read and the patch can still race. Never claim atomic CAS,
    // replay a stale whole-config snapshot, or compensate by overwriting again.
    if (!same(await currentCommand(), expected)) return describe(receipt);
    await input.config.patch({ providers: { [provider]: { command } } });
    return describe(receipt);
  }
  async function enable(receipt: CommandReceipt | null) {
    if (receipt && receipt.phase !== "restored" && receipt.phase !== "cancelled") {
      const status = await describe(receipt);
      if (status.state !== "pending" || receipt.phase !== "installing") return status;
      return patchIfUnchanged(receipt, receipt.originalCommand, receipt.installedCommand);
    }
    const originalCommand = await currentCommand();
    const installedCommand = Command.parse(
      input.prepareCommand ? await input.prepareCommand(originalCommand) : fixedCommand,
    );
    if (same(originalCommand, installedCommand))
      throw new Error("Cannot adopt a command without its original installation receipt.");
    receipt = {
      version: 1,
      id: randomUUID(),
      provider,
      originalCommand,
      installedCommand: [...installedCommand],
      phase: "installing",
    };
    // Save the original command before changing anything. A lost response or
    // worker reload can then reconcile without guessing the previous value.
    await input.store.write(receipt);
    return patchIfUnchanged(receipt, originalCommand, receipt.installedCommand);
  }
  return {
    status: () => serial(async () => describe(await read())),
    enable: () => serial(async () => enable(await read())),
    // First run only: any receipt, including a restored one, records a choice.
    enableIfNew: () =>
      serial(async () => {
        const receipt = await read();
        return receipt ? describe(receipt) : enable(null);
      }),
    restore: () =>
      serial(async () => {
        let receipt = await read();
        if (!receipt) return describe(null);
        const status = await describe(receipt);
        if (
          status.state === "changed" ||
          status.state === "restored" ||
          status.state === "not-installed"
        )
          return status;
        // An interrupted install that never patched config requires no undo.
        if (receipt.phase === "installing" && status.state === "pending") {
          await input.store.write({ ...receipt, phase: "cancelled" });
          return {
            state: "not-installed" as const,
            explicitDefaultOnRestore: receipt.originalCommand === null,
          };
        }
        receipt = { ...receipt, phase: "restoring" };
        await input.store.write(receipt);
        return patchIfUnchanged(receipt, receipt.installedCommand, restoredCommand(receipt));
      }),
  };
}

// Separate from policy persistence: corrupt/missing command ownership must never
// be inferred from scheduled stops. No full config or provider environment is saved.
export function createCommandReceiptStore(path: string): CommandReceiptStore {
  async function prepare() {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(dirname(path));
  }
  return {
    async read() {
      await prepare();
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (!file) return null;
      try {
        const info = await file.stat();
        if (!info.isFile() || !ownerOnly(info, 0o600) || info.size > 65_536)
          throw new Error("Free Your Agents command receipt is not private or valid.");
        return Receipt.parse(JSON.parse(await file.readFile("utf8")));
      } finally {
        await file.close();
      }
    },
    async write(value) {
      await prepare();
      const contents = JSON.stringify(Receipt.parse(value)) + "\n";
      if (Buffer.byteLength(contents) > 65_536) throw new Error("Command receipt is too large.");
      const temporary = path + "." + randomUUID() + ".tmp";
      try {
        const file = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(contents);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
        // Node cannot open a directory on Windows to flush it.
        if (windows) return;
        const directory = await open(dirname(path), constants.O_RDONLY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}
