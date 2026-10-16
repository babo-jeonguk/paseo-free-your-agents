import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, chmod, stat, readFile, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import type { PaseoApi } from "@getpaseo/client";
import {
  createCommandSetup,
  createCommandReceiptStore,
  type CommandReceipt,
  type CommandReceiptStore,
} from "./command-setup";

function fixture(originalCommand?: string[], provider: "codex" | "claude" = "codex") {
  let receipt: CommandReceipt | null = null;
  const config = MutableDaemonConfigSchema.parse({
    relay: { enabled: false },
    mcp: { enabled: false, injectIntoAgents: false },
    providers: { [provider]: { command: originalCommand, env: { KEEP: "fixture" } } },
  });
  const writes: unknown[] = [];
  let lostResponse = false;
  const api: PaseoApi["config"] = {
    get: async () => ({ requestId: "get", config: structuredClone(config) }),
    patch: async (patch) => {
      writes.push(structuredClone(patch));
      config.providers[provider]!.command = structuredClone(patch.providers![provider]!.command);
      if (lostResponse) {
        lostResponse = false;
        throw new Error("Fixture response lost after persistence");
      }
      return { requestId: "patch", config: structuredClone(config) };
    },
  };
  const store: CommandReceiptStore = {
    read: async () => structuredClone(receipt),
    write: async (value) => {
      receipt = structuredClone(value);
    },
  };
  const options = {
    provider,
    config: api,
    store,
    installedCommand: ["/fixture/node", "/fixture/proxy.mjs"],
  };
  return {
    config,
    writes,
    options,
    manager: createCommandSetup(options),
    receipt: () => receipt,
    loseResponse: () => {
      lostResponse = true;
    },
  };
}

test("command setup restores custom argv or an explicit default using narrow public patches", async () => {
  for (const provider of ["codex", "claude"] as const) {
    for (const original of [
      undefined,
      ["/fixture/custom codex", "--flag", "literal $(not-a-shell)"],
    ]) {
      const f = fixture(original, provider);
      assert.equal((await f.manager.status()).state, "not-installed");
      const installed = await f.manager.enable();
      assert.equal(installed.state, "installed");
      assert.equal(installed.explicitDefaultOnRestore, original === undefined);
      assert.deepEqual(f.config.providers[provider]!.command, f.options.installedCommand);
      assert.deepEqual(f.receipt()!.originalCommand, original ?? null);
      f.config.providers[provider]!.env = { LATER: "user-edit" };
      assert.equal((await f.manager.restore()).state, "restored");
      assert.deepEqual(f.config.providers[provider]!.command, original ?? [provider]);
      assert.deepEqual(f.config.providers[provider]!.env, { LATER: "user-edit" });
      assert.deepEqual(f.writes, [
        { providers: { [provider]: { command: f.options.installedCommand } } },
        { providers: { [provider]: { command: original ?? [provider] } } },
      ]);
    }
  }
});

test("a command receipt cannot be used to restore another provider", async () => {
  const f = fixture();
  await f.manager.enable();
  await assert.rejects(
    createCommandSetup({ ...f.options, provider: "claude" }).restore(),
    /another provider/,
  );
  assert.equal(f.writes.length, 1);
});

test("runtime preparation receives the journaled original command and rechecks changes before patch", async () => {
  const f = fixture(["/fixture/custom", "--literal"]);
  let captured: string[] | null | undefined;
  const setup = createCommandSetup({
    ...f.options,
    installedCommand: undefined,
    prepareCommand: async (original) => {
      captured = structuredClone(original);
      return ["/fixture/prepared-launcher"];
    },
  });
  await setup.enable();
  assert.deepEqual(captured, ["/fixture/custom", "--literal"]);
  assert.deepEqual(f.receipt()!.originalCommand, captured);
  assert.deepEqual(f.config.providers.codex!.command, ["/fixture/prepared-launcher"]);
  await setup.restore();
  assert.deepEqual(f.config.providers.codex!.command, captured);
  const race = fixture();
  const changed = createCommandSetup({
    ...race.options,
    installedCommand: undefined,
    prepareCommand: async () => {
      race.config.providers.codex!.command = ["/fixture/later-command"];
      return ["/fixture/prepared-launcher"];
    },
  });
  assert.equal((await changed.enable()).state, "changed");
  assert.equal(race.writes.length, 0);
});

test("observed user changes win before install, after install, and before restore", async () => {
  for (const stage of ["install-intent", "installed", "restore-intent"]) {
    const f = fixture();
    const store = {
      ...f.options.store,
      write: async (value: CommandReceipt) => {
        await f.options.store.write(value);
        if (
          (stage === "install-intent" && value.phase === "installing") ||
          (stage === "restore-intent" && value.phase === "restoring")
        )
          f.config.providers.codex!.command = ["/fixture/user-choice"];
      },
    };
    const manager = createCommandSetup({ ...f.options, store });
    const installed = await manager.enable();
    if (stage === "install-intent") assert.equal(installed.state, "changed");
    else {
      if (stage === "installed") f.config.providers.codex!.command = ["/fixture/user-choice"];
      assert.equal((await manager.restore()).state, "changed");
    }
    assert.deepEqual(f.config.providers.codex!.command, ["/fixture/user-choice"]);
    assert.equal(f.writes.length, stage === "install-intent" ? 0 : 1);
  }
});

test("lost responses reconcile across controller recreation without repeating patches", async () => {
  const f = fixture();
  f.loseResponse();
  await assert.rejects(f.manager.enable(), /response lost/);
  assert.equal(f.receipt()!.phase, "installing");
  const reloaded = createCommandSetup(f.options);
  assert.equal((await reloaded.status()).state, "installed");
  assert.equal((await reloaded.enable()).state, "installed");
  assert.equal(f.writes.length, 1);
  f.loseResponse();
  await assert.rejects(reloaded.restore(), /response lost/);
  assert.equal(f.receipt()!.phase, "restoring");
  assert.equal((await createCommandSetup(f.options).status()).state, "restored");
  assert.equal((await reloaded.restore()).state, "restored");
  assert.equal(f.writes.length, 2);
});

test("failed or unowned installation cannot manufacture a rollback command", async () => {
  const f = fixture();
  const unwritable = createCommandSetup({
    ...f.options,
    store: {
      ...f.options.store,
      write: async () => {
        throw new Error("Disk unavailable");
      },
    },
  });
  await assert.rejects(unwritable.enable(), /Disk unavailable/);
  assert.equal(f.writes.length, 0);
  f.config.providers.codex!.command = [...f.options.installedCommand];
  await assert.rejects(f.manager.enable(), /without its original installation receipt/);
  assert.equal((await f.manager.restore()).state, "not-installed");
  assert.equal(f.writes.length, 0);
});

test("cancel an interrupted install before the config patch without introducing an override", async () => {
  const f = fixture();
  const manager = createCommandSetup({
    ...f.options,
    config: {
      ...f.options.config,
      patch: async () => {
        throw new Error("Not admitted");
      },
    },
  });
  await assert.rejects(manager.enable(), /Not admitted/);
  assert.equal((await manager.status()).state, "pending");
  assert.equal((await manager.restore()).state, "not-installed");
  assert.equal((await manager.status()).state, "not-installed");
  assert.equal(f.config.providers.codex!.command, undefined);
  assert.equal((await f.manager.enable()).state, "installed");
});

test(
  "Windows receipts persist under the user profile without journaling provider settings",
  { skip: process.platform !== "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "command-receipt-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const store = createCommandReceiptStore(join(directory, "setup", "codex.json"));
    const f = fixture();
    await createCommandSetup({ ...f.options, store }).enable();
    assert.equal((await store.read())!.phase, "installed");
    assert.ok(!(await readFile(join(directory, "setup", "codex.json"), "utf8")).includes("KEEP"));
    assert.equal((await createCommandSetup({ ...f.options, store }).restore()).state, "restored");
  },
);

test(
  "ownership receipts persist privately and reject unsafe files",
  { skip: process.platform !== "linux" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "command-receipt-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "receipt.json");
    const store = createCommandReceiptStore(path);
    const f = fixture();
    await createCommandSetup({ ...f.options, store }).enable();
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await store.read())!.phase, "installed");
    const saved = await readFile(path, "utf8");
    assert.ok(!saved.includes("KEEP"), "Provider environment is never journaled");
    await chmod(path, 0o644);
    await assert.rejects(store.read(), /not private/);
    await unlink(path);
    await symlink(join(directory, "outside.json"), path);
    await assert.rejects(store.read());
  },
);
