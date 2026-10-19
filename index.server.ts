import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { setFlagsFromString } from "node:v8";
import { createControl } from "./server/control";
import { createFileStore } from "./server/store";
import { runtimeApi } from "./shared/model";
import { createBackend } from "./server/backend";
import { needsMaglevWorkaround } from "./server/host-compatibility";
import {
  changeStopRpc,
  listRpc,
  publishTabsRpc,
  registerOwnerRpc,
  setupStatusRpc,
  setupChangeRpc,
  managementReadRpc,
  managementChangeRpc,
} from "./shared/rpc";

// Paseo 0.12 splits the protocol validator; older hosts still need this workaround.
if (needsMaglevWorkaround()) setFlagsFromString("--no-maglev");

export default function contribute(server: PluginServerContext) {
  const control = createControl(createFileStore());
  const backend = createBackend();
  const attach = (paseo: PluginHandlerContext["paseo"]) =>
    control.attach(backend.attach(paseo), backend.managedAgentIds);
  if ("paseo" in server) control.attach(runtimeApi(server.paseo));
  server.handle(registerOwnerRpc, async ({ ownerId }, { paseo }) => {
    attach(paseo);
    return { epoch: await control.register(ownerId) };
  });
  server.handle(publishTabsRpc, async (input, { paseo }) => {
    attach(paseo);
    return { accepted: await control.publish(input) };
  });
  server.handle(listRpc, async (_input, { paseo }) => {
    attach(paseo);
    return control.list();
  });
  server.handle(changeStopRpc, async (input, { paseo }) => {
    attach(paseo);
    return control.change(input);
  });
  server.handle(setupStatusRpc, async (_, { paseo }) => {
    attach(paseo);
    return backend.status();
  });
  server.handle(setupChangeRpc, async (input, { paseo }) => {
    attach(paseo);
    return backend.change(input.provider, input.action);
  });
  server.handle(managementReadRpc, async (_, { paseo }) => {
    attach(paseo);
    return control.management();
  });
  server.handle(managementChangeRpc, async (input, { paseo }) => {
    attach(paseo);
    return control.changeManagement(input);
  });
  const stopHook = server.before("agent.session_open", async ({ request }, { paseo }) => {
    attach(paseo);
    return backend.prepareSession(request);
  });
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void control
      .tick()
      .catch((error: unknown) => console.error("[free-your-agents] scheduler", error))
      .finally(() => {
        ticking = false;
      });
  }, 5000);
  return async () => {
    clearInterval(timer);
    stopHook();
    await control.drain();
  };
}
