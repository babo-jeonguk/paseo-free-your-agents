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
    // The launcher build installedCommand runs. Absent in receipts written
    // before updates replaced launchers.
    launcher: z.string().min(1).max(200).optional(),
    // Only while upgrading: the command being replaced.
    previousCommand: Command.optional(),
    phase: z.enum(["installing", "installed", "upgrading", "restoring", "restored", "cancelled"]),
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
// The command an interrupted install or update was replacing.
const replacedCommand = (receipt: CommandReceipt) =>
  receipt.phase === "upgrading" ? receipt.previousCommand! : receipt.originalCommand;
const settled = ({ previousCommand: _, ...receipt }: CommandReceipt): CommandReceipt => ({
  ...receipt,
  phase: "installed",
});

// No startup/cleanup side effects. The caller invokes enable, enableIfNew, upgrade
// or restore; none stops a daemon, conversation, or native process. This boundary
// can later be replaced by a first-class provider-command API.
export function createCommandSetup(input: {
  provider?: "codex" | "claude";
  config: Pick<PluginHandlerContext["paseo"]["config"], "get" | "patch">;
  store: CommandReceiptStore;
  installedCommand?: string[];
  prepareCommand?(originalCommand: string[] | null): Promise<string[]>;
  // Identifies the launcher build prepareCommand points at. When it changes,
  // upgrade() moves an installed command to the new build.
  launcher?: string;
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
    if (receipt.phase === "installing" || receipt.phase === "upgrading") {
      if (owned) {
        await input.store.write(settled(receipt));
        state = "installed";
      } else if (same(current, replacedCommand(receipt))) state = "pending";
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
  const prepare = async (originalCommand: string[] | null) =>
    Command.parse(
      input.prepareCommand ? await input.prepareCommand(originalCommand) : fixedCommand,
    );
  // Finishes an interrupted install or update; otherwise reports the state.
  async function resume(receipt: CommandReceipt) {
    const status = await describe(receipt);
    if (status.state !== "pending" || (receipt.phase !== "installing" && receipt.phase !== "upgrading"))
      return status;
    return patchIfUnchanged(receipt, replacedCommand(receipt), receipt.installedCommand);
  }
  async function enable(receipt: CommandReceipt | null) {
    if (receipt && receipt.phase !== "restored" && receipt.phase !== "cancelled")
      return resume(receipt);
    const originalCommand = await currentCommand();
    const installedCommand = await prepare(originalCommand);
    if (same(originalCommand, installedCommand))
      throw new Error("Cannot adopt a command without its original installation receipt.");
    receipt = {
      version: 1,
      id: randomUUID(),
      provider,
      originalCommand,
      installedCommand: [...installedCommand],
      ...(input.launcher && { launcher: input.launcher }),
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
    // After a plugin update, moves a command this plugin installed to the new
    // launcher. originalCommand is kept, so restore still returns to it. A
    // provider that is off, or whose command was changed elsewhere, is left alone.
    upgrade: () =>
      serial(async () => {
        let receipt = await read();
        if (!receipt) return describe(null);
        if (receipt.phase === "upgrading") return resume(receipt);
        const status = await describe(receipt);
        if (status.state !== "installed" || !input.launcher || receipt.launcher === input.launcher)
          return status;
        receipt = settled(receipt);
        const installedCommand = await prepare(receipt.originalCommand);
        if (same(installedCommand, receipt.installedCommand)) {
          await input.store.write({ ...receipt, launcher: input.launcher });
          return status;
        }
        receipt = {
          ...receipt,
          previousCommand: receipt.installedCommand,
          installedCommand,
          launcher: input.launcher,
          phase: "upgrading",
        };
        await input.store.write(receipt);
        return patchIfUnchanged(receipt, receipt.previousCommand!, installedCommand);
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
        // An update that never patched config still runs the previous command.
        if (receipt.phase === "upgrading" && status.state === "pending")
          receipt = { ...settled(receipt), installedCommand: receipt.previousCommand! };
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
