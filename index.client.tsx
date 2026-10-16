import type {
  PluginClientContext,
  PluginScreenProps,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useCallback, useSyncExternalStore } from "react";
import { View } from "react-native";
import { z } from "zod";
import { RuntimeScreen } from "./client/screen";
import { ProcessSettingsScreen } from "./client/settings";
import { startReporter, type ReporterRpc } from "./client/reporter";
import { createPrivateTabs } from "./client/private-tabs";
import { getWindowOwnerId } from "./client/window-owner";
import { publishTabsRpc, registerOwnerRpc } from "./shared/rpc";

const LocalStateSchema = z.object({
  status: z.enum(["loading", "ready"]),
  ownerId: z.string(),
  revision: z.number().int().nonnegative(),
  agentIds: z.array(z.string()),
  sharedAgentIds: z.array(z.string()).default([]),
});
const SCREEN_ID = "runtimes";
const noopSubscribe = () => () => {};
const supportedTabs = () => true;

export default function contribute(client: PluginClientContext) {
  const sources = new Map<string, ReturnType<typeof createPrivateTabs>>();
  const reporters: Array<() => void> = [];
  let observeHostTabs: ((listener: (state: unknown) => void) => () => void) | null = null;
  if (
    "localTabs" in client &&
    typeof client.localTabs === "object" &&
    client.localTabs !== null &&
    "observe" in client.localTabs &&
    typeof client.localTabs.observe === "function"
  ) {
    const observe = client.localTabs.observe.bind(client.localTabs);
    observeHostTabs = (listener) => observe(listener);
  }
  const hasHostTabs = observeHostTabs !== null;
  const rpc: ReporterRpc = {
    register: async (ownerId) => (await client.rpc(registerOwnerRpc, { ownerId })).epoch,
    publish: async (input) => (await client.rpc(publishTabsRpc, input)).accepted,
  };
  function sourceForHost(hostId: string) {
    if (hasHostTabs) return null;
    let source = sources.get(hostId);
    if (!source) {
      source = createPrivateTabs({
        hostId,
        owner: getWindowOwnerId,
        onError: (message) => console.error("[free-your-agents]", message),
      });
      sources.set(hostId, source);
      reporters.push(
        startReporter(source.api, rpc, (error) =>
          console.error("[free-your-agents] tab synchronization failed", error),
        ),
      );
    }
    return source;
  }
  function RuntimeEntry(props: PluginScreenProps) {
    const source = sourceForHost(props.host.id);
    const ready = useSyncExternalStore(
      source?.subscribeStatus ?? noopSubscribe,
      source?.supported ?? supportedTabs,
      source?.supported ?? supportedTabs,
    );
    const ref = useCallback((value: unknown) => source?.attach(value), [source]);
    return (
      <View ref={ref} collapsable={false} style={{ flex: 1 }}>
        <RuntimeScreen {...props} tabsSupported={ready} />
      </View>
    );
  }
  function RuntimeItem({ host, currentScreen, openScreen }: PluginSidebarItemProps) {
    const source = sourceForHost(host.id);
    const ref = useCallback((value: unknown) => source?.attach(value), [source]);
    return (
      <View ref={ref} collapsable={false}>
        <SidebarRow
          icon="MemoryStick"
          active={currentScreen?.screenId === SCREEN_ID}
          onPress={() => openScreen({ screenId: SCREEN_ID })}
        />
      </View>
    );
  }
  const stopSettings = client.addSettingsScreen({
    id: "process-controls",
    title: "Settings",
    icon: "MemoryStick",
    Component: ProcessSettingsScreen,
  });
  const stopScreen = client.addScreen({
    id: SCREEN_ID,
    title: "Free Your Agents",
    Component: RuntimeEntry,
  });
  const stopSidebar = client.addSidebarHeaderItem({
    id: SCREEN_ID,
    title: "Free Your Agents",
    Component: RuntimeItem,
  });
  if (observeHostTabs) {
    const observe = observeHostTabs;
    reporters.push(
      startReporter(
        {
          observe: (listener) =>
            observe((state: unknown) => listener(LocalStateSchema.parse(state))),
        },
        rpc,
        (error) => console.error("[free-your-agents] tab synchronization", error),
      ),
    );
  }
  return async () => {
    for (const stop of reporters) stop();
    for (const source of sources.values()) source.dispose();
    await stopSettings();
    await stopSidebar();
    await stopScreen();
  };
}
