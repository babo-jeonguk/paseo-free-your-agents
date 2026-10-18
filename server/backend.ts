import type {
  PluginHandlerContext,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createCommandSetup, createCommandReceiptStore } from "./command-setup";
import { createConversationMetadata } from "./conversation-metadata";
import { launcherBuild, prepareRuntimeCommand, recordRuntime } from "./runtime-assets";
import { createProxyRuntime, type RuntimeProvider } from "./proxy-runtime";
import { bridgeProvider, type ProviderEntries } from "./provider-profiles";
import { runtimeApi, type RuntimeApi } from "../shared/model";
import { controlSupported } from "./platform.mjs";

type Paseo = PluginHandlerContext["paseo"];
export function createBackend(
  directory = join(
    process.env.PASEO_HOME || join(homedir(), ".paseo"),
    "plugin-data",
    "free-your-agents",
  ),
) {
  let paseo: Paseo | null = null,
    metadata: ReturnType<typeof createConversationMetadata> | null = null;
  let foregroundMetadata: ReturnType<typeof createConversationMetadata> | null = null;
  let official: RuntimeApi | null = null,
    usingCompatibility = false,
    ready: Promise<unknown> = Promise.resolve(),
    // The first attach's default setup and update. Settings wait for it, so they
    // never show the command it is about to replace.
    defaults: Promise<unknown> = Promise.resolve();
  let readinessError: unknown = null;
  const setups = new Map<
    "codex" | "claude",
    ReturnType<typeof createCommandSetup>
  >();
  let profiles: { expiresAt: number; providers: ProviderEntries } | null = null;
  async function runtimeProvider(provider: string): Promise<RuntimeProvider | null> {
    if (provider === "codex" || provider === "claude") return provider;
    if (!paseo) return null;
    if (!profiles || Date.now() >= profiles.expiresAt)
      profiles = {
        expiresAt: Date.now() + 15_000,
        providers: (await paseo.config.get()).config.providers ?? {},
      };
    return bridgeProvider(profiles.providers, provider);
  }
  const proxy = createProxyRuntime({
    directory: join(directory, "runtime"),
    metadata: (ids) => (metadata ? metadata(ids) : Promise.resolve([])),
    runtimeProvider,
  });
  const launchers = join(directory, "launchers");
  // Launchers exist only after a command was enabled; loading never creates them.
  const refreshRuntime = () =>
    access(launchers)
      .then(
        () => recordRuntime(launchers),
        () => {},
      )
      .catch((error: unknown) =>
        console.error("[free-your-agents] runtime pointer", error),
      );
  void refreshRuntime();
  function attach(api: Paseo) {
    if (!paseo) {
      paseo = api;
      metadata = createConversationMetadata({ agents: api.agents });
      // Let the host classify workspace visibility. Older hosts have no
      // background workspaces and ignore this additive false flag.
      foregroundMetadata = createConversationMetadata({ agents: api.agents, includeBackground: false });
      if (controlSupported)
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
                prepareRuntimeCommand(launchers, provider, original),
              launcher: launcherBuild,
            }),
          );
      official = runtimeApi(api);
      // Process control is on by default: the first attach turns on providers
      // that were never set up. Turning one off leaves a receipt that keeps it off.
      // After an update, new conversations start this version's bridge.
      defaults = Promise.all(
        [...setups].map(([provider, setup]) =>
          setup
            .enableIfNew()
            .then(() => setup.upgrade())
            .catch((error: unknown) =>
              console.error(`[free-your-agents] default ${provider} setup`, error),
            ),
        ),
      );
      ready = defaults.then(status).catch((error) => {
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
      (controlSupported && (await proxy.hasConnections()));
    readinessError = null;
    return {
      official: !!official?.supported() && !usingCompatibility,
      supported: controlSupported,
      providers,
    };
  }
  const current = () =>
    !usingCompatibility && official?.supported() ? official : proxy.api;
  const selected: RuntimeApi = {
    supported: () => controlSupported || !!official?.supported(),
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
    async managedAgentIds(agentIds: string[]) {
      if (!foregroundMetadata) throw new Error("Conversation visibility is not available yet.");
      return (await foregroundMetadata(agentIds)).map((entry) => entry.agentId);
    },
    async status() {
      await defaults;
      return status();
    },
    async change(provider: "codex" | "claude", action: "enable" | "restore") {
      const setup = setups.get(provider);
      if (!setup)
        throw new Error(
          "Process control setup is currently supported on Linux and Windows only.",
        );
      usingCompatibility = true;
      await setup[action]();
      return status();
    },
    async prepareSession(request: PluginSessionOpenRequest) {
      const provider = await runtimeProvider(request.provider).catch(() => null);
      const setup = provider ? setups.get(provider) : undefined;
      if (!provider || !setup) return request;
      try {
        if ((await setup.status()).state !== "installed") return request;
      } catch {
        return request;
      }
      await refreshRuntime();
      try {
        return {
          ...request,
          env: {
            ...request.env,
            ...(await proxy.prepareSession({ ...request, provider })),
          },
        };
      } catch {
        console.error(
          "[free-your-agents] Control preparation failed; preserving normal CLI startup.",
        );
        const env = { ...request.env };
        delete env.RUNTIME_PROXY_RECIPE_FILE;
        return { ...request, env };
      }
    },
  };
}
