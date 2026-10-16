import type { RuntimeProvider } from "./proxy-runtime";

export type ProviderEntries = Record<string, Record<string, unknown> | undefined>;

// A profile that extends Codex or Claude without its own command launches
// through that provider's command, and therefore through its bridge.
export function bridgeProvider(
  providers: ProviderEntries,
  provider: string,
): RuntimeProvider | null {
  let id = provider;
  for (let depth = 0; depth <= 8; depth++) {
    if (id === "codex" || id === "claude") return id;
    const entry = providers[id];
    if (typeof entry?.extends !== "string" || entry.command !== undefined) return null;
    id = entry.extends;
  }
  return null;
}
