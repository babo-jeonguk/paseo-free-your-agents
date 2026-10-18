import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { ConversationMetadata } from "./proxy-runtime";

// Listing directory metadata projects already-known runtime state. Do not replace
// this with session.refresh(), getRuntimeInfo(), timeline, or provider RPCs: those
// can create a native process merely to display a row. No subscription is opened
// here because that also enables additional host observation producers.
export function createConversationMetadata(input: {
  agents: Pick<PluginHandlerContext["paseo"]["agents"], "list">;
  includeBackground?: boolean;
  now?: () => number;
  cacheMs?: number;
}) {
  const now = input.now ?? Date.now;
  const cacheMs = input.cacheMs ?? 15_000;
  type Directory = { values: Map<string, ConversationMetadata>; archived: boolean };
  let cached: Directory | null = null;
  let expiresAt = 0;
  const pending = new Map<boolean, Promise<Directory>>();

  async function refresh(includeArchived: boolean): Promise<Directory> {
    const values = new Map<string, ConversationMetadata>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      // Validated stock accepts includeBackground; the published 0.11.2 client
      // declaration predates that optional wire flag. Keep it additive so older
      // hosts can ignore it without enabling a provider/timeline observation.
      const options = {
        includeBackground: input.includeBackground ?? true,
        filter: { includeArchived },
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      };
      const result = await input.agents.list(options);
      for (const { agent } of result.entries) {
        values.set(agent.id, {
          agentId: agent.id,
          title: agent.title?.trim() || "Untitled conversation",
          provider: agent.provider,
          workspace: agent.cwd,
        });
      }
      if (!result.pageInfo.hasMore) {
        cached = { values, archived: includeArchived };
        expiresAt = now() + cacheMs;
        return cached;
      }
      cursor = result.pageInfo.nextCursor ?? undefined;
      if (!cursor || cursors.has(cursor))
        throw new Error("Conversation metadata pagination could not be verified.");
      cursors.add(cursor);
    }
    // A partial directory never becomes authoritative cached metadata. Missing
    // metadata also never means the corresponding tab has closed.
    throw new Error("Conversation metadata exceeded the supported page limit.");
  }
  function load(includeArchived: boolean) {
    let request = pending.get(includeArchived);
    if (!request) {
      request = refresh(includeArchived).finally(() => pending.delete(includeArchived));
      pending.set(includeArchived, request);
    }
    return request;
  }
  return async (agentIds: string[]): Promise<ConversationMetadata[]> => {
    if (!agentIds.length) return [];
    const ids = [...new Set(agentIds)];
    let directory = cached && now() < expiresAt ? cached : await load(false);
    // Every host page lists and sorts the whole directory, archived included.
    // Open tabs rarely belong to archived conversations: list those only when
    // a requested conversation is missing from the active ones.
    if (!directory.archived && ids.some((id) => !directory.values.has(id)))
      directory = await load(true);
    return ids.flatMap((id) => {
      const value = directory.values.get(id);
      return value ? [{ ...value }] : [];
    });
  };
}
