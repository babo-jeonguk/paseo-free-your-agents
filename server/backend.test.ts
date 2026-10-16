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
