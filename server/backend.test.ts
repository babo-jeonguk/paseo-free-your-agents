import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { createBackend } from "./backend";
import { createCommandReceiptStore } from "./command-setup";
import { launcherBuild } from "./runtime-assets";
import { controlSupported } from "./platform.mjs";

test("process control is on by default and stays off once turned off", { skip: !controlSupported }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fya-backend-"));
  try {
    const config = MutableDaemonConfigSchema.parse({
      relay: { enabled: false },
      mcp: { enabled: false, injectIntoAgents: false },
      providers: {},
    });
    const paseo = {
      config: {
        get: async () => ({ requestId: "get", config: structuredClone(config) }),
        patch: async (patch: { providers: typeof config.providers }) => {
          for (const [name, value] of Object.entries(patch.providers))
            config.providers[name] = { ...config.providers[name], ...value };
          return { requestId: "patch", config: structuredClone(config) };
        },
      },
      agents: { list: async () => ({ entries: [], hasMore: false }) },
    } as unknown as PluginHandlerContext["paseo"];
    const states = async (backend: ReturnType<typeof createBackend>) =>
      Object.fromEntries((await backend.status()).providers.map((p) => [p.provider, p.state]));

    // snapshot waits for the first attach to finish its default setup.
    const first = createBackend(directory);
    await first.attach(paseo).snapshot({ agentIds: [] });
    assert.deepEqual(await states(first), { codex: "installed", claude: "installed" });
    assert.match(String(config.providers.codex?.command), /launchers/);

    await first.change("claude", "restore");
    // A daemon or plugin reload must respect the user's choice.
    const reloaded = createBackend(directory);
    await reloaded.attach(paseo).snapshot({ agentIds: [] });
    assert.deepEqual(await states(reloaded), { codex: "installed", claude: "restored" });
    assert.deepEqual(config.providers.claude!.command, ["claude"]);

    // An update moves a command an older version installed to this version's
    // launcher, and keeps the original command for turning it off.
    config.providers.codex = { ...config.providers.codex, command: ["/old/launcher"] };
    const receipts = createCommandReceiptStore(join(directory, "setup", "codex.json"));
    await receipts.write({
      version: 1,
      id: randomUUID(),
      provider: "codex",
      originalCommand: null,
      installedCommand: ["/old/launcher"],
      phase: "installed",
    });
    const updated = createBackend(directory);
    updated.attach(paseo);
    // Settings read right after attach already see the update.
    assert.deepEqual(await states(updated), { codex: "installed", claude: "restored" });
    assert.match(String(config.providers.codex?.command), /launchers/);
    assert.equal((await receipts.read())!.launcher, launcherBuild);
    await updated.change("codex", "restore");
    assert.deepEqual(config.providers.codex!.command, ["codex"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("profile inventory carries inherited provider identity without granting process control", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fya-profile-identity-"));
  const profiles = {
    "claude-main": { extends: "claude" },
    "claude-sub": { extends: "claude-main" },
    "codex-sub": { extends: "codex" },
    "custom-worker": { extends: "claude-sub", command: ["/custom/claude"] },
    "claude-lookalike": {},
    cycle: { extends: "cycle" },
  };
  try {
    // Existing opt-out receipts keep this read-only identity test from enabling
    // provider commands. Identity must still work when control is unavailable.
    for (const provider of ["codex", "claude"] as const) {
      await createCommandReceiptStore(join(directory, "setup", provider + ".json")).write({
        version: 1, id: randomUUID(), provider, originalCommand: null,
        installedCommand: ["/unused"], phase: "cancelled",
      });
    }
    const api = {
      config: {
        get: async () => ({ config: { providers: profiles } }),
        patch: async () => { throw new Error("Identity lookup must not change provider commands"); },
      },
      agents: { list: async () => ({
        entries: Object.keys(profiles).map(id => ({ agent: { id, provider: id, title: id, cwd: "/workspace" } })),
        pageInfo: { hasMore: false },
      }) },
    } as unknown as PluginHandlerContext["paseo"];
    const rows = await createBackend(directory).attach(api).snapshot({ agentIds: Object.keys(profiles) });
    assert.deepEqual(rows.map(row => [row.provider, Reflect.get(row, "baseProvider")]), [
      ["claude-main", "claude"], ["claude-sub", "claude"], ["codex-sub", "codex"],
      ["custom-worker", "claude"], ["claude-lookalike", undefined], ["cycle", undefined],
    ]);
    assert.equal(rows.find(row => row.provider === "custom-worker")!.controlStatus, "unsupported");
    assert.ok(rows.every(row => !row.releasable));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
