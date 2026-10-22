import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Image, View } from "react-native";
import type { Row } from "../shared/model";
import { category } from "./filter";
import { providerLogos } from "./provider-logos";

// Decorative identity only: the Agent and Status text remain available during
// selection, when this entire mark is replaced by the checkbox.
export function ConversationIcon({ row, theme }: {
  row: Row;
  theme: PluginScreenProps["theme"];
}) {
  const c = theme.colors;
  const provider = row.runtime.baseProvider ?? row.runtime.provider;
  const logo = Object.hasOwn(providerLogos, provider) ? providerLogos[provider] : undefined;
  const status = category(row);
  return (
    <View aria-hidden accessible={false} importantForAccessibility="no-hide-descendants"
      style={{ width: 20, height: 20 }}>
      {logo ? (
        <Image testID="provider-logo" source={{ uri: logo }}
          style={{ width: 20, height: 20, tintColor: c.foregroundMuted }} />
      ) : <Icon name="MessageCircle" size={20} color={c.foregroundMuted} />}
      <View style={{
        position: "absolute", right: -7, bottom: -6, width: 16, height: 16,
        borderRadius: 8, borderWidth: 2, borderColor: c.surface1, backgroundColor: c.surface1,
        alignItems: "center", justifyContent: "center",
      }}>
        <View testID="runtime-status-badge" style={{
          width: 12, height: 12, alignItems: "center", justifyContent: "center",
        }}>
          {status === "idle" ? (
            <View style={{
              width: 10.2, height: 10.2, borderRadius: 5.1,
              borderWidth: 1.5, borderColor: c.foregroundMuted,
            }} />
          ) : status === "working" ? (
            <View style={{
              width: 10.2, height: 10.2, borderRadius: 5.1, backgroundColor: c.accent,
              flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 1.1,
            }}>
              {[0, 1, 2].map(dot => <View key={dot} style={{
                width: 1.4, height: 1.4, borderRadius: 0.7, backgroundColor: c.surface0,
              }} />)}
            </View>
          ) : status === "absent" ? (
            <View style={{
              width: 10.2, height: 10.2, borderRadius: 5.1,
              borderWidth: 1.2, borderColor: c.foregroundMuted,
              alignItems: "center", justifyContent: "center",
            }}>
              <View style={{ width: 9, height: 1.2, backgroundColor: c.foregroundMuted, transform: [{ rotate: "45deg" }] }} />
            </View>
          ) : <Icon name="CircleHelp" size={12} color={c.statusWarning} />}
        </View>
      </View>
    </View>
  );
}
