import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Text } from "react-native";
import { setupChangeRpc, setupStatusRpc } from "../shared/rpc";

export function ProcessSettingsScreen({ theme, host }: PluginSurfaceProps) {
  const status = useRpc(setupStatusRpc);
  const change = useRpc(setupChangeRpc);
  const queryClient = useQueryClient();
  const queryKey = ["free-your-agents", "setup", host.id];
  const setup = useQuery({
    queryKey,
    queryFn: () => status({}),
    refetchInterval: 15_000,
    retry: 1,
  });
  const mutation = useMutation({
    mutationFn: async (input: Parameters<typeof change>[0]) => {
      const result = await change(input);
      queryClient.setQueryData(queryKey, result);
      const state = result.providers.find((row) => row.provider === input.provider)?.state;
      if (
        input.action === "enable"
          ? state !== "installed"
          : state !== "restored" && state !== "not-installed"
      )
        throw new Error(
          "Couldn’t confirm the change. Check this provider’s status and try again.",
        );
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey });
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["free-your-agents", "inventory", host.id] });
    },
  });
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 };

  return (
    <ScrollView
      contentContainerStyle={{ padding: 24, gap: 16, maxWidth: 600, width: "100%", alignSelf: "center" }}
    >
      <SettingsSection title="Process controls">
        {setup.isPending ? (
          <Text style={muted}>Loading process control setup…</Text>
        ) : setup.isError ? (
          <SettingsCard>
            <SettingsAction
              label="Process control settings could not be read"
              hint={setup.error.message}
              actionLabel="Retry"
              onPress={() => void setup.refetch()}
            />
          </SettingsCard>
        ) : setup.data.official ? (
          <Text style={muted}>Process controls are provided by Paseo. No command setup is needed.</Text>
        ) : (
          <>
            <Text style={muted}>
              Stop idle processes without closing your conversations.
            </Text>
            {!setup.data.supported && (
              <Text style={muted}>Process controls currently require Linux or Windows.</Text>
            )}
            <SettingsCard>
              {setup.data.providers.map((provider) => {
                const name = provider.provider === "codex" ? "Codex" : "Claude";
                const changing = mutation.isPending && mutation.variables.provider === provider.provider;
                const error = mutation.isError && mutation.variables.provider === provider.provider
                  ? mutation.error.message
                  : null;
                const disabled = mutation.isPending || !setup.data.supported;
                if (provider.state === "changed")
                  return (
                    <SettingsRow
                      key={provider.provider}
                      label={name}
                      hint="Managed outside Free Your Agents"
                      error={error}
                    />
                  );
                if (provider.state === "pending")
                  return (
                    <SettingsAction
                      key={provider.provider}
                      label={name}
                      hint={changing ? "Turning off…" : "Setup incomplete"}
                      error={error}
                      actionLabel="Turn off"
                      disabled={disabled}
                      onPress={() => mutation.mutate({ provider: provider.provider, action: "restore" })}
                    />
                  );
                return (
                  <SettingsSwitch
                    key={provider.provider}
                    label={name}
                    hint={changing
                      ? mutation.variables.action === "enable" ? "Turning on…" : "Turning off…"
                      : provider.state === "installed" ? "On" : "Off"}
                    value={provider.state === "installed"}
                    disabled={disabled}
                    error={error}
                    onValueChange={(value) => mutation.mutate({
                      provider: provider.provider,
                      action: value ? "enable" : "restore",
                    })}
                  />
                );
              })}
            </SettingsCard>
            <Text style={muted}>
              New chats: immediately · Existing chats: after Paseo restarts
            </Text>
          </>
        )}
      </SettingsSection>
    </ScrollView>
  );
}
