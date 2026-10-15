import type { PluginServerContext } from "@getpaseo/plugin/server";
import { setFlagsFromString } from "node:v8";
import { createControl } from "./server/control";
import { createFileStore } from "./server/store";
import { runtimeApi } from "./shared/model";
import { createBackend } from "./server/backend";
import {
  changeStopRpc,
  listRpc,
  publishTabsRpc,
  registerOwnerRpc,
  setupStatusRpc,
  setupChangeRpc,
} from "./shared/rpc";

// Match Auto Resume: avoid a Maglev compilation spike for Paseo's large protocol validator.
setFlagsFromString("--no-maglev");

export default function contribute(server: PluginServerContext) {
  const control = createControl(createFileStore());
  const backend = createBackend();
  if ("paseo" in server) control.attach(runtimeApi(server.paseo));
  server.handle(registerOwnerRpc, async ({ ownerId }, { paseo }) => {
    control.attach(backend.attach(paseo));
    return { epoch: await control.register(ownerId) };
  });
  server.handle(publishTabsRpc, async (input, { paseo }) => {
    control.attach(backend.attach(paseo));
    return { accepted: await control.publish(input) };
  });
  server.handle(listRpc, async (_input, { paseo }) => {
    control.attach(backend.attach(paseo));
    return control.list();
  });
  server.handle(changeStopRpc, async (input, { paseo }) => {
    control.attach(backend.attach(paseo));
    return control.change(input);
  });
  server.handle(setupStatusRpc, async (_, { paseo }) => {
    control.attach(backend.attach(paseo));
    return backend.status();
  });
  server.handle(setupChangeRpc, async (input, { paseo }) => {
    control.attach(backend.attach(paseo));
    return backend.change(input.provider, input.action);
  });
  const stopHook = server.before("agent.session_open", async ({ request }, { paseo }) => {
    control.attach(backend.attach(paseo));
    return backend.prepareSession(request);
  });
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void control
      .tick()
      .catch((error: unknown) => console.error("[runtime-control] scheduler", error))
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
