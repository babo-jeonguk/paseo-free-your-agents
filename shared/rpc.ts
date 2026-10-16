import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { HoursSchema, InventorySchema } from "./model";

export const SetupSchema = z.object({
  official: z.boolean(),
  supported: z.boolean(),
  providers: z.array(
    z.object({
      provider: z.enum(["codex", "claude"]),
      state: z.enum(["not-installed", "installed", "pending", "changed", "restored"]),
      explicitDefaultOnRestore: z.boolean(),
    }),
  ),
});
export const setupStatusRpc = defineRpc({
  name: "free-your-agents.setup.status",
  input: z.object({}),
  output: SetupSchema,
});
export const setupChangeRpc = defineRpc({
  name: "free-your-agents.setup.change",
  input: z.object({ provider: z.enum(["codex", "claude"]), action: z.enum(["enable", "restore"]) }),
  output: SetupSchema,
});

export const registerOwnerRpc = defineRpc({
  name: "free-your-agents.tabs.register",
  input: z.object({ ownerId: z.string().min(1).max(200) }),
  output: z.object({ epoch: z.string() }),
});
export const publishTabsRpc = defineRpc({
  name: "free-your-agents.tabs.publish",
  input: z.object({
    ownerId: z.string().min(1).max(200),
    epoch: z.string(),
    revision: z.number().int().nonnegative(),
    agentIds: z.array(z.string().min(1)).max(10000),
    sharedAgentIds: z.array(z.string().min(1)).max(10000).default([]),
  }),
  output: z.object({ accepted: z.boolean() }),
});
export const listRpc = defineRpc({
  name: "free-your-agents.list",
  input: z.object({}),
  output: InventorySchema,
});
export const changeStopRpc = defineRpc({
  name: "free-your-agents.stop.change",
  input: z.object({
    agentId: z.string(),
    expectedGeneration: z.string().nullable(),
    expectedStopId: z.string().nullable(),
    action: z.enum(["now", "schedule", "cancel"]),
    hours: HoursSchema.optional(),
  }),
  output: z.object({ changed: z.boolean(), reason: z.string().nullable() }),
});
