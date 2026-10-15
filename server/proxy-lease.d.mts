export function ownProxyLease(
  provider: "codex" | "claude",
  env?: Record<string, string | undefined>,
): Promise<() => Promise<void>>;
