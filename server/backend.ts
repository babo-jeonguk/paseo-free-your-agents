import type {
  PluginHandlerContext,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";
import { join } from "node:path";
import { homedir } from "node:os";
import { createCommandSetup, createCommandReceiptStore } from "./command-setup";
import { createConversationMetadata } from "./conversation-metadata";
import { prepareRuntimeCommand } from "./runtime-assets";
import { createProxyRuntime } from "./proxy-runtime";
import { runtimeApi, type RuntimeApi } from "../shared/model";

type Paseo = PluginHandlerContext["paseo"];
export function createBackend(
  directory = join(
    process.env.PASEO_HOME || join(homedir(), ".paseo"),
    "plugin-data",
    "runtime-control",
  ),
) {
  let paseo: Paseo | null = null,
    metadata: ReturnType<typeof createConversationMetadata> | null = null;
  let official: RuntimeApi | null = null,
    usingCompatibility = false,
    ready: Promise<unknown> = Promise.resolve();
  let readinessError: unknown = null;
  const setups = new Map<
    "codex" | "claude",
    ReturnType<typeof createCommandSetup>
  >();
  const proxy = createProxyRuntime({
    directory: join(directory, "runtime"),
    metadata: (ids) => (metadata ? metadata(ids) : Promise.resolve([])),
  });
  function attach(api: Paseo) {
    if (!paseo) {
      paseo = api;
      metadata = createConversationMetadata({ agents: api.agents });
      if (process.platform === "linux")
        for (const provider of ["codex", "claude"] as const)
          setups.set(
            provider,
            createCommandSetup({
              provider,
              config: api.config,
              store: createCommandReceiptStore(
                join(directory, "setup", provider + ".json"),
              ),
              prepareCommand: (original) =>
                prepareRuntimeCommand(
                  join(directory, "launchers"),
                  provider,
                  original,
                ),
            }),
          );
      official = runtimeApi(api);
      ready = status().catch((error) => {
        readinessError = error;
      });
    }
    return selected;
  }
  async function status() {
    const providers = await Promise.all(
      [...setups].map(async ([provider, setup]) => ({
        provider,
        ...(await setup.status()),
      })),
    );
    usingCompatibility =
      providers.some((provider) =>
        ["installed", "pending", "changed"].includes(provider.state),
      ) ||
      (process.platform === "linux" && (await proxy.hasConnections()));
    readinessError = null;
    return {
      official: !!official?.supported() && !usingCompatibility,
      supported: process.platform === "linux",
      providers,
    };
  }
  const current = () =>
    !usingCompatibility && official?.supported() ? official : proxy.api;
  const selected: RuntimeApi = {
    supported: () => process.platform === "linux" || !!official?.supported(),
    snapshot: async (input) => {
      await ready;
      if (readinessError) throw readinessError;
      return current().snapshot(input);
    },
    releaseIfIdle: async (input) => {
      await ready;
      if (readinessError) throw readinessError;
      return current().releaseIfIdle(input);
    },
  };
  return {
    attach,
    status,
    async change(provider: "codex" | "claude", action: "enable" | "restore") {
      const setup = setups.get(provider);
      if (!setup)
        throw new Error(
          "Process control setup is currently supported on Linux only.",
        );
      usingCompatibility = true;
      await setup[action]();
      return status();
    },
    async prepareSession(request: PluginSessionOpenRequest) {
      const setup = setups.get(request.provider as "codex" | "claude");
      if (!setup) return request;
      try {
        if ((await setup.status()).state !== "installed") return request;
      } catch {
        return request;
      }
      try {
        return {
          ...request,
          env: { ...request.env, ...(await proxy.prepareSession(request)) },
        };
      } catch {
        console.error(
          "[runtime-control] Control preparation failed; preserving normal CLI startup.",
        );
        const env = { ...request.env };
        delete env.RUNTIME_PROXY_RECIPE_FILE;
        return { ...request, env };
      }
    },
  };
}
