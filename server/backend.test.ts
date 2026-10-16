import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { createBackend } from "./backend";
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
