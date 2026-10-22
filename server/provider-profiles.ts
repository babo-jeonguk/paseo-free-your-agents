import type { RuntimeProvider } from "./proxy-runtime";

export type ProviderEntries = Record<string, Record<string, unknown> | undefined>;

// Display identity follows ancestry even when a profile overrides its command.
// That override still prevents bridgeProvider from granting runtime control.
export function baseProvider(providers: ProviderEntries, provider: string): RuntimeProvider | null {
  const visited = new Set<string>();
  let id = provider;
  while (!visited.has(id)) {
    if (id === "codex" || id === "claude") return id;
    visited.add(id);
    const parent = providers[id]?.extends;
    if (typeof parent !== "string") return null;
    id = parent;
  }
  return null;
}

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
