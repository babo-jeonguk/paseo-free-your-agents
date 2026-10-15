export function claimProxyConnection(
  recipeFile: string,
  expectedProvider?: "codex" | "claude",
): Promise<Record<string, string>>;
