import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useEffect, useState, type Ref } from "react";
import { Platform, Pressable, View } from "react-native";

export function useTouchSelection() {
  const [touch, setTouch] = useState(Platform.OS !== "web");
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const media = window.matchMedia("(hover: none), (pointer: coarse)");
    const update = () => setTouch(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return touch;
}

export function SelectionCheckbox({
  label, checked, onPress, theme, revealed = true, disabled = false, buttonRef, inertWhenHidden = false,
  onFocusChange,
}: {
  label: string;
  checked: boolean | "mixed";
  onPress(): void;
  theme: PluginScreenProps["theme"];
  revealed?: boolean;
  disabled?: boolean;
  buttonRef?: Ref<View>;
  inertWhenHidden?: boolean;
  onFocusChange?(focused: boolean): void;
}) {
  const [focused, setFocused] = useState(false);
  const c = theme.colors;
  const visible = revealed || focused || checked;
  function changeFocus(value: boolean) {
    setFocused(value);
    onFocusChange?.(value);
  }
  return (
    <Pressable
      ref={buttonRef}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      aria-checked={checked}
      disabled={disabled}
      pointerEvents={inertWhenHidden && !visible ? "none" : "auto"}
      onPress={onPress}
      onFocus={(event) => {
        // Touch focus must not keep an unchecked box visible after selection ends.
        const target = event.currentTarget as unknown as { matches?(selector: string): boolean };
        changeFocus(Platform.OS !== "web" || target.matches?.(":focus-visible") === true);
      }}
      onBlur={() => changeFocus(false)}
      // RN Web Pressable handles Enter, but only handles Space for button roles.
      {...(Platform.OS === "web" ? { onKeyDown: (event: {
        key: string; repeat: boolean; preventDefault(): void;
      }) => {
        if (event.key === " " || event.key === "Spacebar") {
          event.preventDefault();
          changeFocus(true);
          if (!disabled && !event.repeat) onPress();
        }
      } } : {})}
      style={{
        width: 44, height: 44, flexShrink: 0, alignItems: "center", justifyContent: "center",
        borderRadius: 6, borderWidth: 2, borderColor: focused ? c.accent : "transparent",
      }}
    >
      <View aria-hidden style={{
        width: 18, height: 18, borderRadius: 4, borderWidth: 1.5,
        borderColor: checked ? c.foreground : c.foregroundMuted,
        backgroundColor: checked ? c.foreground : c.surface1,
        alignItems: "center", justifyContent: "center",
        opacity: visible ? disabled ? 0.4 : 1 : 0,
      }}>
        {checked === "mixed" ? (
          <View style={{ width: 10, height: 2, backgroundColor: c.surface0 }} />
        ) : checked ? (
          <View style={{
            width: 5, height: 9, borderRightWidth: 2, borderBottomWidth: 2,
            borderColor: c.surface0, transform: [{ rotate: "45deg" }], marginTop: -2,
          }} />
        ) : null}
      </View>
    </Pressable>
  );
}
