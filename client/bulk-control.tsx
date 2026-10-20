import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { HoursSchema, type Row } from "../shared/model";
import { changeStopRpc } from "../shared/rpc";
import { controlReason, runBulkControl, type BulkResult, type ControlAction } from "./bulk";
import { memoryTotal, statusLabel } from "./filter";

type Theme = PluginScreenProps["theme"];
type Panel = { rows: Row[]; confirm: boolean };

export function BulkControls({ rows, theme, supported, queryKey, clear, complete, focusSelection }: {
  rows: Row[];
  theme: Theme;
  supported: boolean;
  queryKey: readonly string[];
  clear(): void;
  complete(result: BulkResult, action: ControlAction): void;
  focusSelection(): void;
}) {
  const c = theme.colors;
  const [panel, setPanel] = useState<Panel | null>(null);
  const [hours, setHours] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<BulkResult | null>(null);
  const busy = progress !== null;
  // A synchronous latch also prevents two presses in the same render frame.
  const running = useRef(false);
  const controlRef = useRef<View>(null);
  const backRef = useRef<View>(null);
  const presetRef = useRef<View>(null);
  const resultRef = useRef<View>(null);
  const change = useRpc(changeStopRpc);
  const queryClient = useQueryClient();
  const chosen = panel?.rows ?? [];
  const eligible = (action: ControlAction) => chosen.filter(row => !controlReason(row, action, supported));
  const canSchedule = eligible("schedule").length;
  const canCancel = eligible("cancel").length;
  const canStop = eligible("now").length;
  const validHours = HoursSchema.safeParse(Number(hours));
  const text = { fontSize: 14, lineHeight: 20, color: c.foreground };
  const muted = { fontSize: 13, lineHeight: 20, color: c.foregroundMuted };
  const strong = { ...text, fontWeight: "600" as const };
  const line = { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const };
  const section = { gap: 12, paddingTop: 16, borderTopWidth: 1, borderColor: c.border };

  useEffect(() => {
    if (Platform.OS !== "web" || !panel) return;
    if (panel.confirm) backRef.current?.focus();
    else presetRef.current?.focus();
  }, [panel?.confirm, panel !== null]);

  useEffect(() => {
    if (Platform.OS === "web" && result && !busy) resultRef.current?.focus();
  }, [result, busy]);

  function close() {
    if (running.current) return;
    setPanel(null);
    setTimeout(() => {
      if (controlRef.current) controlRef.current.focus();
      else focusSelection();
    }, 0);
  }

  function open() {
    setPanel({ rows: [...rows], confirm: false });
    setResult(null);
    setError(null);
    setHours("1");
  }

  async function submit(action: ControlAction) {
    if (!panel || running.current || result) return;
    if (action === "schedule" && !validHours.success) {
      setError("Enter a duration from 0.25 to 168 hours.");
      return;
    }
    running.current = true;
    setProgress(0);
    setError(null);
    try {
      const outcome = await runBulkControl(
        panel.rows, action, supported,
        action === "schedule" && validHours.success ? validHours.data : undefined,
        change, setProgress,
      );
      setResult(outcome);
      complete(outcome, action);
      // A refresh failure must not disguise changes that already succeeded.
      await queryClient.invalidateQueries({ queryKey }).catch(() => {});
    } finally {
      running.current = false;
      setProgress(null);
    }
  }

  function button(label: string, onPress: () => void, options: {
    disabled?: boolean; danger?: boolean; primary?: boolean; ref?: typeof controlRef;
  } = {}) {
    const disabled = busy || options.disabled;
    return (
      <Pressable
        ref={options.ref}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: !!disabled }}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => ({
          minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 7,
          justifyContent: "center", alignItems: "center", borderWidth: 1, flexShrink: 1,
          borderColor: options.danger ? c.statusDanger : c.border,
          backgroundColor: options.primary ? c.foreground : pressed ? c.surface2 : c.surface1,
          opacity: disabled ? 0.45 : 1,
        })}
      >
        <Text style={{ ...strong, color: options.primary ? c.surface0 : options.danger ? c.statusDanger : c.foreground }}>
          {label}
        </Text>
      </Pressable>
    );
  }

  return (
    <>
      {rows.length > 0 && (
        <View testID="bulk-toolbar" style={{
          ...line, justifyContent: "space-between", padding: 12, borderRadius: 8,
          backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border,
        }}>
          <View style={{ gap: 2, flexGrow: 1 }}>
            <Text style={strong} aria-live="polite">{rows.length} selected</Text>
            <Text style={muted}>Process memory · {memoryTotal(rows).value}</Text>
          </View>
          <View style={line}>
            {button("Clear selection", () => { clear(); focusSelection(); })}
            {button("Control selected", open, { primary: true, ref: controlRef })}
          </View>
        </View>
      )}
      <Modal
        open={panel !== null}
        title={result ? "Bulk control results" : panel?.confirm ? "Stop selected processes" : "Control selected conversations"}
        icon={<Icon name="SlidersHorizontal" size={18} color={c.foregroundMuted} />}
        onOpenChange={isOpen => {
          if (isOpen || running.current) return;
          if (panel?.confirm && !result) setPanel({ ...panel, confirm: false });
          else close();
        }}
      >
        <Modal.Content>
          {panel && (
            <View style={{ gap: 20 }}>
              {busy ? (
                <View style={{ gap: 12 }}>
                  <Text accessibilityLiveRegion="polite" aria-live="polite" style={strong}>
                    Applying changes… {progress} of {chosen.length}
                  </Text>
                  <Text style={muted}>Keep this panel open while each conversation is updated. Active work stays protected.</Text>
                </View>
              ) : result ? (
                <>
                  <Text accessibilityRole="alert" style={strong}>
                    {result.succeeded.length} updated · {result.failed.length} failed · {result.skipped.length} skipped
                  </Text>
                  <Text style={muted}>
                    Your conversations and tabs stay open. Stop requests wait for active work to finish.
                  </Text>
                  {(result.failed.length > 0 || result.skipped.length > 0) && (
                    <>
                      <Text style={muted}>Remaining conversations stay selected. Review their current status before trying again.</Text>
                      <ScrollView style={{ maxHeight: 240 }} contentContainerStyle={{ gap: 12 }}>
                        {[...result.failed.map(issue => ({ ...issue, kind: "Failed" })),
                          ...result.skipped.map(issue => ({ ...issue, kind: "Skipped" }))].map(issue => (
                          <View key={issue.agentId} style={{ gap: 3 }}>
                            <Text style={strong}>{issue.title}</Text>
                            <Text style={{ ...muted, color: issue.kind === "Failed" ? c.statusDanger : c.foregroundMuted }}>
                              {issue.kind} · {issue.reason}
                            </Text>
                          </View>
                        ))}
                      </ScrollView>
                    </>
                  )}
                  {button(result.failed.length || result.skipped.length ? "Review remaining" : "Done", close, { ref: resultRef })}
                </>
              ) : (
                <>
                  <View style={{ gap: 8, backgroundColor: c.surface2, padding: 14, borderRadius: 8 }}>
                    <Text style={strong}>{chosen.length} selected {chosen.length === 1 ? "conversation" : "conversations"}</Text>
                    <ScrollView style={{ maxHeight: 160 }} contentContainerStyle={{ gap: 6 }}>
                      {chosen.map(row => (
                        <View key={row.runtime.agentId} style={{ gap: 2 }}>
                          <Text style={text}>{row.runtime.title}</Text>
                          <Text style={muted}>{statusLabel(row)}</Text>
                        </View>
                      ))}
                    </ScrollView>
                  </View>
                  {panel.confirm ? (
                    <>
                      <Text style={text}>
                        Request a stop for {canStop} of {chosen.length} selected processes.
                        {chosen.length > canStop ? ` ${chosen.length - canStop} will be skipped.` : ""}
                        {" "}Active work will finish first. Your conversations and tabs stay open.
                      </Text>
                      {chosen.filter(row => controlReason(row, "now", supported)).map(row => (
                        <Text key={row.runtime.agentId} style={muted}>
                          {row.runtime.title} · {controlReason(row, "now", supported)}
                        </Text>
                      ))}
                      <View style={{ ...line, justifyContent: "flex-end" }}>
                        {button("Back", () => setPanel({ ...panel, confirm: false }), { ref: backRef })}
                        {button(`Stop ${canStop} ${canStop === 1 ? "process" : "processes"}`, () => void submit("now"), { danger: true, disabled: canStop === 0 })}
                      </View>
                    </>
                  ) : (
                    <>
                      <View style={section}>
                        <Text style={strong}>Schedule a stop · {canSchedule} eligible</Text>
                        <Text style={muted}>
                          The timer starts when applied to each process. Active work will finish before a stop.
                          {chosen.length > canSchedule ? ` ${chosen.length - canSchedule} will be skipped.` : ""}
                        </Text>
                        <View style={line}>
                          {[['30 min', '0.5'], ['1 hour', '1'], ['2 hours', '2'], ['4 hours', '4'], ['8 hours', '8']].map(([label, value]) => (
                            <Pressable key={value} ref={value === "1" ? presetRef : undefined}
                              accessibilityRole="button" accessibilityLabel={label}
                              aria-pressed={Number(hours) === Number(value)} disabled={busy}
                              accessibilityState={{ disabled: busy, ...(Platform.OS !== "web" ? { selected: Number(hours) === Number(value) } : {}) }}
                              onPress={() => { setHours(value); setError(null); }}
                              style={{
                                minHeight: 44, padding: 10, borderRadius: 7, borderWidth: 1, borderColor: c.border,
                                backgroundColor: Number(hours) === Number(value) ? c.foreground : c.surface1,
                              }}>
                              <Text style={{ ...text, color: Number(hours) === Number(value) ? c.surface0 : c.foreground }}>{label}</Text>
                            </Pressable>
                          ))}
                        </View>
                        <View style={line}>
                          <Text style={text}>Stop after</Text>
                          <TextInput accessibilityLabel="Stop after (hours)" accessibilityHint="Enter a duration from 0.25 to 168 hours."
                            value={hours} onChangeText={value => { setHours(value); setError(null); }}
                            keyboardType="decimal-pad" editable={!busy} selectTextOnFocus
                            style={{ ...text, minHeight: 44, width: 88, borderWidth: 1, borderColor: c.border, borderRadius: 7, paddingHorizontal: 12 }} />
                          <Text style={muted}>hours</Text>
                        </View>
                        {error && <Text accessibilityRole="alert" style={{ ...text, color: c.statusDanger }}>{error}</Text>}
                        {button(`Schedule ${canSchedule} ${canSchedule === 1 ? "stop" : "stops"}`, () => void submit("schedule"), { primary: true, disabled: canSchedule === 0 })}
                      </View>
                      <View style={section}>
                        <Text style={strong}>Cancel pending stops · {canCancel} eligible</Text>
                        <Text style={muted}>Only pending schedules are cancelled. Other conversations are skipped.</Text>
                        {button(`Cancel ${canCancel} scheduled ${canCancel === 1 ? "stop" : "stops"}`, () => void submit("cancel"), { disabled: canCancel === 0 })}
                      </View>
                      <View style={section}>
                        <Text style={strong}>Free memory · {canStop} eligible</Text>
                        <Text style={muted}>Stop idle processes now. Working processes stop when their current work finishes.</Text>
                        {button("Stop selected processes…", () => setPanel({ ...panel, confirm: true }), { danger: true, disabled: canStop === 0 })}
                      </View>
                      {button("Close", close)}
                    </>
                  )}
                </>
              )}
            </View>
          )}
        </Modal.Content>
      </Modal>
    </>
  );
}
