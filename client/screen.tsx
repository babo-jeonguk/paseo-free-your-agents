import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState, type Ref } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import type { Row } from "../shared/model";
import { HoursSchema } from "../shared/model";
import { changeStopRpc, listRpc } from "../shared/rpc";
import { BulkControls } from "./bulk-control";
import { SelectionCheckbox, useTouchSelection } from "./selection";
import {
  controlNote,
  filters,
  matches,
  memoryTotal,
  processTotal,
  pendingStop,
  memoryLabel,
  memorySortLabels,
  nextMemorySort,
  providerLabel,
  sortByMemory,
  statusLabel,
  visible,
  type Filter,
  type MemorySort,
} from "./filter";

type Theme = PluginScreenProps["theme"];
type Dialog = { kind: "menu" | "stop"; row: Row } | null;
interface ViewState {
  query: string;
  selected: Filter[];
  checked: string[];
  sort: MemorySort;
  // Set only by a press, so polling re-sorts rows without announcing.
  sortNotice: string;
  dialog: Dialog;
  hours: string;
  error: string | null;
  notice: string | null;
  now: number;
}
type Action =
  | { type: "query"; value: string }
  | { type: "filter"; value: Filter | "all" }
  | { type: "sort" }
  | { type: "check"; id: string }
  | { type: "checks"; ids: string[] }
  | { type: "dialog"; value: Dialog }
  | { type: "hours"; value: string }
  | { type: "error"; value: string | null }
  | { type: "success"; value: string }
  | { type: "clock"; value: number };
function reducer(state: ViewState, action: Action): ViewState {
  switch (action.type) {
    case "query":
      return { ...state, query: action.value, checked: [] };
    case "filter": {
      const value = action.value;
      if (value === "all") return { ...state, selected: [], checked: [] };
      const selected = state.selected.includes(value)
        ? state.selected.filter((id) => id !== value)
        : [...state.selected, value];
      return { ...state, selected, checked: [] };
    }
    case "check":
      return { ...state, checked: state.checked.includes(action.id)
        ? state.checked.filter(id => id !== action.id) : [...state.checked, action.id] };
    case "checks":
      return { ...state, checked: action.ids };
    case "sort": {
      const sort = nextMemorySort(state.sort);
      const sortNotice = sort
        ? `Sorted by memory, ${memorySortLabels[sort].state}.`
        : "Default order.";
      return { ...state, sort, sortNotice };
    }
    case "dialog":
      return {
        ...state,
        dialog: action.value,
        hours:
          action.value &&
          state.dialog &&
          action.value.row.runtime.agentId === state.dialog.row.runtime.agentId
            ? state.hours
            : "1",
        error: null,
        now: Date.now(),
      };
    case "hours":
      return { ...state, hours: action.value, error: null };
    case "error":
      return { ...state, error: action.value };
    case "success":
      return { ...state, dialog: null, error: null, notice: action.value };
    case "clock":
      return { ...state, now: action.value };
  }
}

function createStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  return {
    scroll: { flex: 1, backgroundColor: c.surface0 },
    content: {
      padding: compact ? 16 : 28,
      paddingBottom: 48,
      gap: 20,
      width: "100%" as const,
      maxWidth: 1440,
      alignSelf: "center" as const,
    },
    title: { fontSize: 25, fontWeight: "600" as const, color: c.foreground },
    muted: { fontSize: 13, color: c.foregroundMuted, lineHeight: 20 },
    text: { fontSize: 14, color: c.foreground, lineHeight: 20 },
    strong: { fontSize: 14, color: c.foreground, fontWeight: "600" as const },
    line: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 10,
    },
    header: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: 12,
    },
    summary: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: 10,
    },
    metric: {
      flexGrow: 1,
      flexBasis: compact ? ("45%" as const) : ("20%" as const),
      padding: 16,
      gap: 6,
      borderRadius: 9,
      borderColor: c.border,
      borderWidth: 1,
      backgroundColor: c.surface1,
    },
    number: {
      fontSize: 24,
      fontWeight: "600" as const,
      color: c.foreground,
      fontVariant: ["tabular-nums" as const],
    },
    toolbar: {
      flexDirection: compact ? ("column" as const) : ("row" as const),
      gap: 12,
      alignItems: compact ? ("stretch" as const) : ("center" as const),
      flexWrap: "wrap" as const,
    },
    search: {
      minHeight: 44,
      minWidth: 180,
      flexGrow: 1,
      flexShrink: 1,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 7,
      color: c.foreground,
      backgroundColor: c.surface1,
      fontSize: 14,
    },
    segments: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: 4,
      padding: 4,
      borderRadius: 8,
      backgroundColor: c.surface2,
    },
    filter: {
      minHeight: 44,
      flexBasis: compact ? ("47%" as const) : ("auto" as const),
      flexGrow: compact ? 1 : 0,
      justifyContent: "center" as const,
      alignItems: "center" as const,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 5,
      borderWidth: 1,
      borderColor: "transparent",
    },
    selected: { backgroundColor: c.surface1, borderColor: c.border },
    panel: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 9,
      backgroundColor: c.surface1,
      overflow: "hidden" as const,
    },
    tableHeader: {
      flexDirection: "row" as const,
      paddingHorizontal: 16,
      paddingVertical: 12,
      gap: 14,
      backgroundColor: c.surface2,
    },
    row: {
      flexDirection: compact ? ("column" as const) : ("row" as const),
      alignItems: compact ? ("stretch" as const) : ("center" as const),
      padding: 16,
      gap: compact ? 12 : 14,
      borderTopWidth: 1,
      borderColor: c.border,
    },
    session: { flex: compact ? undefined : 3, minWidth: 0, gap: 4 },
    agent: { flex: compact ? undefined : 1, minWidth: 0 },
    status: { flex: compact ? undefined : 1.6, minWidth: 0 },
    memory: { flex: compact ? undefined : 1, minWidth: 0 },
    // Fills the header's height so the whole cell is a 44 px target.
    sortButton: {
      minHeight: 44,
      marginVertical: -12,
      marginHorizontal: -6,
      paddingHorizontal: 6,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      alignSelf: compact ? ("flex-start" as const) : undefined,
      gap: 6,
      borderRadius: 6,
    },
    sorted: { color: c.foreground, fontWeight: "600" as const },
    visuallyHidden: {
      position: "absolute" as const,
      width: 1,
      height: 1,
      overflow: "hidden" as const,
      opacity: 0,
    },
    control: {
      flex: compact ? undefined : 2.3,
      minWidth: 0,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
    },
    iconButton: {
      width: 44,
      height: 44,
      borderRadius: 6,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    pressed: { backgroundColor: c.surface2 },
    disabled: { opacity: 0.45 },
    button: {
      minHeight: 44,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 6,
      borderColor: c.border,
      borderWidth: 1,
      justifyContent: "center" as const,
      alignItems: "center" as const,
    },
    primary: { backgroundColor: c.foreground },
    primaryText: {
      color: c.surface0,
      fontSize: 14,
      fontWeight: "600" as const,
    },
    dangerButton: { borderColor: c.statusDanger },
    dangerPrimary: {
      backgroundColor: c.statusDanger,
      borderColor: c.statusDanger,
    },
    dangerPrimaryText: {
      color: c.surface0,
      fontSize: 14,
      fontWeight: "600" as const,
    },
    danger: { color: c.statusDanger, fontSize: 14, lineHeight: 20 },
    banner: {
      padding: 14,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 7,
      gap: 8,
      backgroundColor: c.surface1,
    },
    empty: { padding: 40, alignItems: "center" as const, gap: 10 },
    controlButton: {
      minHeight: 44,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 7,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 7,
      backgroundColor: c.surface1,
    },
    actions: { gap: 20 },
    identity: {
      padding: 16,
      gap: 10,
      borderRadius: 10,
      backgroundColor: c.surface2,
    },
    dialogTitle: {
      fontSize: 17,
      lineHeight: 24,
      fontWeight: "600" as const,
      color: c.foreground,
    },
    section: { gap: 12 },
    badge: {
      borderRadius: 5,
      paddingHorizontal: 8,
      paddingVertical: 3,
      backgroundColor: c.surface1,
    },
    scheduleStatus: {
      padding: 14,
      gap: 10,
      borderRadius: 8,
      borderColor: c.border,
      borderWidth: 1,
    },
    presets: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: 4,
    },
    preset: {
      minHeight: 44,
      flexGrow: 1,
      flexBasis: "17%" as const,
      paddingHorizontal: 4,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      borderRadius: 7,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface1,
    },
    presetSelected: {
      backgroundColor: c.foreground,
      borderColor: c.foreground,
    },
    duration: {
      minHeight: 44,
      width: 88,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 7,
      color: c.foreground,
      backgroundColor: c.surface1,
      fontSize: 14,
    },
    divider: {
      borderTopWidth: 1,
      borderColor: c.border,
      paddingTop: 20,
      gap: 12,
    },
    footer: {
      flexDirection: "row" as const,
      justifyContent: "flex-end" as const,
      gap: 8,
      flexWrap: "wrap" as const,
    },
  };
}
type Styles = ReturnType<typeof createStyles>;

function ControlButton({
  label,
  onPress,
  styles,
  disabled = false,
  primary = false,
  danger = false,
  buttonRef,
}: {
  label: string;
  onPress(): void;
  styles: Styles;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  buttonRef?: Ref<View>;
}) {
  return (
    <Pressable
      ref={buttonRef}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary && styles.primary,
        danger && styles.dangerButton,
        danger && primary && styles.dangerPrimary,
        pressed && !primary && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Text
        style={
          danger
            ? primary
              ? styles.dangerPrimaryText
              : styles.danger
            : primary
            ? styles.primaryText
            : styles.text
        }
      >
        {label}
      </Text>
    </Pressable>
  );
}
// Unsorted shows a faint pair and a sort shows one solid triangle, so the state
// differs in shape, not only in color. Border triangles avoid font differences.
function SortIcon({ sort, theme }: { sort: MemorySort; theme: Theme }) {
  const triangle = (up: boolean, color: string) => (
    <View
      style={{
        width: 0,
        height: 0,
        borderLeftWidth: 4,
        borderRightWidth: 4,
        borderLeftColor: "transparent",
        borderRightColor: "transparent",
        ...(up
          ? { borderBottomWidth: 5, borderBottomColor: color }
          : { borderTopWidth: 5, borderTopColor: color }),
      }}
    />
  );
  return (
    <View aria-hidden style={{ width: 8, height: 12, gap: 2, justifyContent: "center" }}>
      {sort === null && triangle(true, theme.colors.foregroundMuted)}
      {sort === null && triangle(false, theme.colors.foregroundMuted)}
      {sort === "ascending" && triangle(true, theme.colors.foreground)}
      {sort === "descending" && triangle(false, theme.colors.foreground)}
    </View>
  );
}
function stopLabel(row: Row, now: number): string {
  if (!row.stop) return "No stop scheduled";
  if (row.stop.state === "deferred") return "Waiting for work to finish";
  if (row.stop.state === "stopping") return "Stopping process…";
  if (row.stop.state === "failed") return "Stop failed";
  const remaining = Math.max(0, Math.ceil((row.stop.dueAt - now) / 60_000));
  if (remaining === 0) return "Stop due";
  if (remaining < 60) return `Stop in ${remaining} min`;
  return `Stop in ${Math.ceil(remaining / 60)} hours`;
}
function stopTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
// Polling replaces only changed rows (React Query structural sharing), so memoized
// rows with stable callbacks skip re-rendering unchanged conversations.
const ConversationRow = memo(function ConversationRow({
  row,
  compact,
  styles,
  theme,
  now,
  open,
  menu,
  checked,
  selecting,
  touchSelection,
  check,
}: {
  row: Row;
  compact: boolean;
  styles: Styles;
  theme: Theme;
  now: number;
  open?: (id: string) => void;
  menu(row: Row): void;
  checked: boolean;
  selecting: boolean;
  touchSelection: boolean;
  check(id: string): void;
}) {
  const [hovered, setHovered] = useState(false);
  const [checkboxFocused, setCheckboxFocused] = useState(false);
  const runtime = row.runtime;
  const Container = touchSelection ? Pressable : View;
  const showSelection = selecting || checkboxFocused || (!touchSelection && hovered);
  return (
    <Container
      style={[styles.row, compact && { paddingLeft: showSelection ? 68 : 16 }, checked && { backgroundColor: theme.colors.surface2 }]}
      testID={`conversation-${runtime.agentId}`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      {...(touchSelection ? {
        accessible: false,
        focusable: false,
        delayLongPress: 500,
        onLongPress: () => { if (!checked) check(runtime.agentId); },
        onPress: () => { if (selecting) check(runtime.agentId); },
      } : {})}
    >
      <View style={compact
        ? { position: "absolute", left: 8, top: 16 }
        : !showSelection ? { position: "absolute", left: 16 } : undefined}>
        <SelectionCheckbox
          label={`Select conversation: ${runtime.title}`}
          checked={checked}
          onPress={() => check(runtime.agentId)}
          theme={theme}
          revealed={selecting || (!touchSelection && hovered)}
          inertWhenHidden={touchSelection}
          onFocusChange={setCheckboxFocused}
        />
      </View>
      <View style={styles.session}>
        <View style={styles.line}>
          <Text style={[styles.strong, { flexShrink: 1 }]}>{runtime.title}</Text>
          {open && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open conversation: ${runtime.title}`}
              onPress={() => open(runtime.agentId)}
              style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
            >
              <Icon name="ArrowUpRight" size={16} color={theme.colors.foregroundMuted} />
            </Pressable>
          )}
        </View>
        <Text style={styles.muted}>
          {runtime.workspace || "Workspace unavailable"} · {row.ownerCount}{" "}
          {row.ownerCount === 1 ? "window" : "windows"}
        </Text>
        {row.syncPending && <Text style={styles.muted}>Sync pending</Text>}
        {row.hasSharedTabs && <Text style={styles.muted}>Includes shared subagent tabs</Text>}
      </View>
      <View style={styles.agent}>
        {compact && <Text style={styles.muted}>Agent</Text>}
        <Text style={styles.text}>{providerLabel(runtime.provider)}</Text>
      </View>
      <View style={styles.status}>
        {compact && <Text style={styles.muted}>Status</Text>}
        <Text style={styles.text}>{statusLabel(row)}</Text>
        {controlNote(row) && <Text style={styles.muted}>{controlNote(row)}</Text>}
      </View>
      <View style={styles.memory}>
        {compact && <Text style={styles.muted}>Memory</Text>}
        <Text style={styles.text}>{memoryLabel(runtime.memoryBytes)}</Text>
      </View>
      <View style={styles.control}>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          {compact && <Text style={styles.muted}>Process control</Text>}
          <Text style={styles.text}>{stopLabel(row, now)}</Text>
          {row.stop && <Text style={styles.muted}>{stopTime(row.stop.dueAt)}</Text>}
          {row.stop?.error && <Text style={styles.danger}>{row.stop.error}</Text>}
          {runtime.unavailableReason && runtime.presence !== "absent" && (
            <Text style={styles.muted}>{runtime.unavailableReason}</Text>
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Process controls: ${runtime.title}`}
          accessibilityHint="Schedule a process stop or stop it now."
          onPress={() => menu(row)}
          style={({ pressed }) => [styles.controlButton, pressed && styles.pressed]}
        >
          <Icon name="SlidersHorizontal" size={16} color={theme.colors.foreground} />
          <Text style={styles.strong}>Control</Text>
        </Pressable>
      </View>
    </Container>
  );
});

export function RuntimeScreen({
  theme,
  host,
  layout,
  navigation,
  tabsSupported,
}: PluginScreenProps & { tabsSupported: boolean }) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const [view, dispatch] = useReducer(reducer, {
    query: "",
    selected: [],
    checked: [],
    sort: null,
    sortNotice: "",
    dialog: null,
    hours: "1",
    error: null,
    notice: null,
    now: Date.now(),
  });
  const list = useRpc(listRpc);
  const change = useRpc(changeStopRpc);
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["free-your-agents", "inventory", host.id], [host.id]);
  const query = useQuery({
    queryKey,
    queryFn: () => list({}),
    refetchInterval: 5_000,
    retry: 1,
  });
  useEffect(() => {
    const timer = setInterval(() => dispatch({ type: "clock", value: Date.now() }), 15_000);
    return () => clearInterval(timer);
  }, []);
  const mutation = useMutation({
    mutationFn: async (input: Parameters<typeof change>[0]) => {
      const result = await change(input);
      if (!result.changed) throw new Error(result.reason ?? "Could not update the stop policy.");
      return input.action;
    },
    onSuccess: async (action) => {
      await queryClient.invalidateQueries({ queryKey });
      let notice = "Stop requested. Active work is protected.";
      if (action === "schedule")
        notice = "Stop scheduled. Your conversation and tab stay available.";
      if (action === "cancel") notice = "Scheduled stop cancelled.";
      dispatch({ type: "success", value: notice });
    },
    onError: (error) =>
      dispatch({
        type: "error",
        value: error instanceof Error ? error.message : String(error),
      }),
  });
  const rows = query.data?.rows ?? [];
  const shown = sortByMemory(visible(rows, view.selected, view.query), view.sort);
  const checkedIds = new Set(view.checked);
  const selectedRows = shown.filter(row => checkedIds.has(row.runtime.agentId));
  const touchSelection = useTouchSelection();
  const selectionRef = useRef<View>(null);
  const [selectAllFocused, setSelectAllFocused] = useState(false);
  useEffect(() => { dispatch({ type: "checks", ids: [] }); }, [host.id]);
  // Remove vanished IDs so closing and reopening a tab cannot silently reselect it.
  useEffect(() => {
    if (!query.data) return;
    const present = new Set(visible(query.data.rows, view.selected, view.query).map(row => row.runtime.agentId));
    const retained = view.checked.filter(id => present.has(id));
    if (retained.length !== view.checked.length) dispatch({ type: "checks", ids: retained });
  }, [query.data, view.checked, view.selected, view.query]);
  const check = useCallback((id: string) => dispatch({ type: "check", id }), []);
  const sortLabels = memorySortLabels[view.sort ?? "none"];
  const sortTitle = layout.compact ? "Sort by memory" : "Memory";
  const scheduled = rows.filter(pendingStop).length;
  const count = (label: string, value: number) => ({
    label,
    value: String(value),
    caption: null,
    accessibilityLabel: `${label}: ${value}`,
  });
  const metrics = [
    { label: "Process memory", ...memoryTotal(rows) },
    { label: "Processes", ...processTotal(rows) },
    count("Pending stops", scheduled),
    count("Open conversations", rows.length),
  ];
  const dialog = view.dialog;
  const presetRef = useRef<View>(null);
  const backRef = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (dialog?.kind === "stop") backRef.current?.focus();
    else if (dialog?.kind === "menu") presetRef.current?.focus();
  }, [dialog?.kind, dialog?.row.runtime.agentId]);
  const currentRow = dialog
    ? rows.find((row) => row.runtime.agentId === dialog.row.runtime.agentId)
    : null;
  const canStop =
    currentRow?.stop?.state !== "stopping" &&
    query.data?.supported === true &&
    currentRow?.runtime.releasable === true &&
    currentRow.runtime.presence === "running";
  const canSchedule =
    currentRow?.stop?.state !== "stopping" &&
    query.data?.supported === true &&
    currentRow?.runtime.presence === "running" &&
    currentRow.runtime.generation !== null &&
    (currentRow.runtime.schedulable ?? currentRow.runtime.releasable);
  const panelRow = currentRow ?? dialog?.row;
  const hasPendingStop = currentRow ? pendingStop(currentRow) : false;
  const canCancel = hasPendingStop && currentRow?.stop?.state !== "stopping";
  const working = currentRow?.runtime.activity !== "idle";
  const validHours = HoursSchema.safeParse(Number(view.hours));
  function submit(action: "now" | "schedule" | "cancel") {
    if (!dialog) return;
    if (action === "schedule" && !validHours.success) {
      dispatch({
        type: "error",
        value: "Enter a duration from 0.25 to 168 hours.",
      });
      return;
    }
    const row = dialog.row;
    mutation.mutate({
      agentId: row.runtime.agentId,
      expectedGeneration: row.runtime.generation,
      expectedStopId: row.stop?.id ?? null,
      action,
      ...(action === "schedule" && validHours.success ? { hours: validHours.data } : {}),
    });
  }
  function close() {
    if (!mutation.isPending) dispatch({ type: "dialog", value: null });
  }
  const open = useMemo(
    () =>
      navigation
        ? (agentId: string) => {
            // TODO: When Paseo supports detaching a single conversation into a popup,
            // use it to open a conversation preview.
            navigation.openAgent({ agentId });
          }
        : undefined,
    [navigation]
  );
  const menu = useCallback(
    (row: Row) => dispatch({ type: "dialog", value: { kind: "menu", row } }),
    []
  );
  function moveFilter(event: {
    key: string;
    preventDefault(): void;
    currentTarget: {
      parentElement: {
        querySelectorAll(selector: string): NodeListOf<HTMLElement>;
      } | null;
    };
  }) {
    if (Platform.OS !== "web") return;
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const buttons = Array.from(
      event.currentTarget.parentElement?.querySelectorAll("[role=button]") ?? []
    );
    const index = buttons.findIndex((button) => button === event.currentTarget);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % buttons.length;
    if (event.key === "ArrowLeft") next = (index + buttons.length - 1) % buttons.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = buttons.length - 1;
    event.preventDefault();
    buttons[next]?.focus();
  }
  return (
    <>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        {...(Platform.OS === "web" ? { onKeyDown: (event: {
          key: string; preventDefault(): void;
          target: { closest?(selector: string): unknown };
        }) => {
          // Modal events can bubble through this scroll view, including portals.
          // Let the dialog own Escape so it can go back or finish pending work.
          if (event.target.closest?.('dialog, [role="dialog"], [aria-modal="true"]')) return;
          if (event.key === "Escape" && !view.dialog && selectedRows.length) {
            event.preventDefault();
            dispatch({ type: "checks", ids: [] });
            selectionRef.current?.focus();
          }
        } } : {})}
      >
        <View style={styles.header}>
          <View style={{ gap: 5, flex: 1 }}>
            <Text accessibilityRole="header" style={styles.title}>
              Free Your Agents
            </Text>
            <Text style={styles.muted}>Reclaim memory from idle agents without losing the conversation.</Text>
          </View>
          <ControlButton
            label={query.isFetching ? "Refreshing…" : "Refresh"}
            styles={styles}
            disabled={query.isFetching}
            onPress={() => void query.refetch()}
          />
        </View>
        {query.isPending && (
          <ActivityIndicator
            color={theme.colors.foregroundMuted}
            accessibilityLabel="Loading open conversations"
          />
        )}
        {query.isError && (
          <View style={styles.banner} accessibilityRole="alert">
            <Text style={styles.strong}>Couldn’t load runtime status</Text>
            <Text style={styles.danger}>{query.error.message}</Text>
            <ControlButton label="Try again" onPress={() => void query.refetch()} styles={styles} />
          </View>
        )}
        {(!tabsSupported || (query.data && !query.data.supported)) && (
          <View style={styles.banner}>
            <Text style={styles.strong}>Compatibility unavailable</Text>
            {!tabsSupported && (
              <Text style={styles.muted}>
                This Paseo app cannot report its open tabs. This window’s last confirmed tabs are
                kept until synchronization can resume.
              </Text>
            )}
            {query.data && !query.data.supported && (
              <Text style={styles.muted}>{query.data.reason}</Text>
            )}
          </View>
        )}
        {view.notice && (
          <Text accessibilityRole="alert" style={styles.muted}>
            {view.notice}
          </Text>
        )}
        <View style={styles.summary}>
          {metrics.map((metric) => (
            <View
              key={metric.label}
              style={styles.metric}
              // A plain web element must not carry a label; native reads it instead
              // of announcing the "+" symbol.
              accessible={Platform.OS !== "web"}
              accessibilityLabel={Platform.OS !== "web" ? metric.accessibilityLabel : undefined}
            >
              <Text style={styles.muted}>{metric.label}</Text>
              <Text style={styles.number}>{metric.value}</Text>
              {metric.caption && <Text style={styles.muted}>{metric.caption}</Text>}
            </View>
          ))}
        </View>
        <Text style={styles.muted}>
          Memory covers native agent processes: PSS where available, otherwise an RSS estimate
          (the working set on Windows).
          Lightweight CLI bridges remain while conversations are open. A conversation is measured
          once its process starts with process controls enabled.
        </Text>
        <View style={{ gap: 8 }}>
          <View style={styles.toolbar}>
            <TextInput
              accessibilityLabel="Search conversations and workspaces"
              placeholder="Search conversations"
              placeholderTextColor={theme.colors.foregroundMuted}
              value={view.query}
              onChangeText={(value) => dispatch({ type: "query", value })}
              style={styles.search}
            />
            <View
              style={styles.segments}
              accessibilityLabel="Conversation categories: match any selected category"
            >
              {[{ id: "all" as const, label: "All" }, ...filters].map((filter) => {
                const pressed =
                  filter.id === "all"
                    ? view.selected.length === 0
                    : view.selected.includes(filter.id);
                const count =
                  filter.id === "all"
                    ? rows.length
                    : rows.filter((row) => matches(row, filter.id as Filter)).length;
                return (
                  <Pressable
                    key={filter.id}
                    accessibilityRole="button"
                    aria-pressed={pressed}
                    accessibilityLabel={filter.label}
                    accessibilityHint={
                      filter.id === "all"
                        ? "Clear category selections and keep search."
                        : filter.description
                    }
                    onPress={() => dispatch({ type: "filter", value: filter.id })}
                    {...(Platform.OS === "web" ? { onKeyDown: moveFilter } : {})}
                    style={[styles.filter, pressed && styles.selected]}
                  >
                    <Text style={pressed ? styles.strong : styles.muted}>
                      {filter.label} · {count}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
          <Text style={styles.muted}>
            Each conversation belongs to one category. Select any combination. All clears filters.
          </Text>
        </View>
        <View style={styles.header}>
          <Text style={styles.strong}>
            {shown.length} {shown.length === 1 ? "conversation" : "conversations"}
          </Text>
          <Text style={[styles.muted, { flexShrink: 1 }]}>
            {view.selected
              .map((id) => filters.find((filter) => filter.id === id)!.label)
              .join(" OR ") || "All managed conversations"}
          </Text>
        </View>
        <BulkControls
          key={host.id}
          rows={selectedRows}
          theme={theme}
          supported={query.data?.supported === true}
          queryKey={queryKey}
          clear={() => dispatch({ type: "checks", ids: [] })}
          focusSelection={() => selectionRef.current?.focus()}
          complete={(result, action) => {
            const succeeded = new Set(result.succeeded);
            dispatch({ type: "checks", ids: view.checked.filter(id => !succeeded.has(id)) });
            const operation = action === "schedule" ? "Stops scheduled" : action === "cancel" ? "Schedules cancelled" : "Stop requests accepted";
            dispatch({ type: "success", value: `${operation}: ${result.succeeded.length}. Failed: ${result.failed.length}. Skipped: ${result.skipped.length}.` });
          }}
        />
        {touchSelection && selectedRows.length === 0 && shown.length > 0 && (
          <Text style={styles.muted}>Touch and hold a conversation to select multiple.</Text>
        )}
        <View style={styles.panel}>
          <View style={styles.tableHeader}>
            <View style={[
              { flexDirection: "row", alignItems: "center", marginVertical: -12, gap: 4 },
              touchSelection && selectedRows.length === 0 && !selectAllFocused && { position: "absolute", left: 16 },
            ]}>
              <SelectionCheckbox
                buttonRef={selectionRef}
                label="Select all visible conversations"
                checked={selectedRows.length === 0 ? false : selectedRows.length === shown.length ? true : "mixed"}
                disabled={shown.length === 0}
                theme={theme}
                revealed={!touchSelection || selectedRows.length > 0}
                inertWhenHidden={touchSelection}
                onFocusChange={setSelectAllFocused}
                onPress={() => dispatch({ type: "checks", ids: selectedRows.length === shown.length
                  ? [] : shown.map(row => row.runtime.agentId) })}
              />
              {layout.compact && (!touchSelection || selectedRows.length > 0) && <Text style={styles.muted}>Select all</Text>}
            </View>
            {[
              { label: "Session", style: styles.session },
              { label: "Agent", style: styles.agent },
              { label: "Status", style: styles.status },
              { label: "Memory", style: styles.memory },
              { label: "Process control", style: styles.control },
            ].map((column) =>
              column.label === "Memory" ? (
                // Cards have no column headers, so the compact strip keeps only
                // this button and spells out the order.
                <Pressable
                  key={column.label}
                  accessibilityRole="button"
                  accessibilityLabel={`${sortTitle}, ${sortLabels.state}`}
                  accessibilityHint={sortLabels.next}
                  onPress={() => dispatch({ type: "sort" })}
                  style={({ pressed }) => [
                    column.style,
                    styles.sortButton,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={[styles.muted, view.sort && styles.sorted]}>
                    {sortTitle}
                  </Text>
                  <SortIcon sort={view.sort} theme={theme} />
                  {layout.compact && (
                    <Text style={styles.muted}>
                      {sortLabels.state[0].toUpperCase() + sortLabels.state.slice(1)}
                    </Text>
                  )}
                </Pressable>
              ) : (
                !layout.compact && (
                  <Text key={column.label} style={[styles.muted, column.style]}>
                    {column.label}
                  </Text>
                )
              )
            )}
          </View>
          <Text aria-live="polite" style={styles.visuallyHidden}>
            {view.sortNotice}
          </Text>
          {shown.map((row) => (
            <ConversationRow
              key={row.runtime.agentId}
              row={row}
              compact={layout.compact}
              theme={theme}
              styles={styles}
              now={row.stop?.state === "scheduled" ? view.now : 0}
              open={open}
              menu={menu}
              checked={checkedIds.has(row.runtime.agentId)}
              selecting={selectedRows.length > 0}
              touchSelection={touchSelection}
              check={check}
            />
          ))}
          {!query.isPending && shown.length === 0 && (
            <View style={styles.empty}>
              <Icon name="MemoryStick" size={28} color={theme.colors.foregroundMuted} />
              <Text style={styles.strong}>
                {rows.length === 0 ? "No managed conversations reported" : "No matching conversations"}
              </Text>
              <Text style={styles.muted}>
                {rows.length === 0
                  ? "Open a conversation tab, or check which conversations are included in Settings."
                  : "No open conversations match your search and selected categories."}
              </Text>
              {view.query !== "" && (
                <ControlButton
                  label="Clear search"
                  styles={styles}
                  onPress={() => dispatch({ type: "query", value: "" })}
                />
              )}
            </View>
          )}
        </View>
        <Text style={styles.muted}>
          Open tabs across this host’s windows and devices. Stopping a process keeps its
          conversation and tab.
        </Text>
      </ScrollView>
      <Modal
        open={dialog !== null}
        title={dialog?.kind === "stop" ? "Stop process" : "Process control"}
        icon={<Icon name="SlidersHorizontal" size={18} color={theme.colors.foregroundMuted} />}
        onOpenChange={(isOpen) => {
          if (!isOpen && !mutation.isPending) {
            if (dialog?.kind === "stop")
              dispatch({ type: "dialog", value: { ...dialog, kind: "menu" } });
            else close();
          }
        }}
      >
        <Modal.Content>
          {dialog && panelRow && (
            <View style={styles.actions}>
              <View style={styles.identity}>
                <Text style={styles.dialogTitle}>{panelRow.runtime.title}</Text>
                <Text style={styles.muted}>
                  {providerLabel(panelRow.runtime.provider)} ·{" "}
                  {panelRow.runtime.workspace || "Workspace unavailable"}
                </Text>
                <View style={[styles.line, { flexWrap: "wrap" }]}>
                  <View style={styles.badge}>
                    <Text style={styles.strong}>{statusLabel(panelRow)}</Text>
                  </View>
                  <Text style={styles.muted}>
                    Memory · {memoryLabel(panelRow.runtime.memoryBytes)}
                  </Text>
                </View>
              </View>
              {dialog.kind === "menu" && (
                <>
                  {hasPendingStop && currentRow?.stop && (
                    <View style={styles.scheduleStatus}>
                      <View style={styles.line}>
                        <Icon name="Clock3" size={17} color={theme.colors.accent} />
                        <Text style={styles.strong}>{stopLabel(currentRow, view.now)}</Text>
                      </View>
                      <Text style={styles.muted}>{stopTime(currentRow.stop.dueAt)}</Text>
                      {canCancel && (
                        <ControlButton
                          label={
                            mutation.isPending && mutation.variables?.action === "cancel"
                              ? "Cancelling…"
                              : "Cancel scheduled stop"
                          }
                          styles={styles}
                          disabled={mutation.isPending}
                          onPress={() => submit("cancel")}
                        />
                      )}
                    </View>
                  )}
                  {canSchedule ? (
                    <View style={styles.section}>
                      <View style={styles.line}>
                        <Icon name="Clock3" size={18} color={theme.colors.foregroundMuted} />
                        <Text style={styles.strong}>
                          {hasPendingStop ? "Reschedule stop" : "Schedule a stop"}
                        </Text>
                      </View>
                      <Text style={styles.muted}>
                        The timer starts when you schedule. If work is still running at the
                        scheduled time, the stop waits for it to finish.
                      </Text>
                      <View style={styles.presets}>
                        {[
                          { label: "30 min", value: "0.5" },
                          { label: "1 hour", value: "1" },
                          { label: "2 hours", value: "2" },
                          { label: "4 hours", value: "4" },
                          { label: "8 hours", value: "8" },
                        ].map((preset) => {
                          const selected = Number(view.hours) === Number(preset.value);
                          return (
                            <Pressable
                              key={preset.value}
                              ref={preset.value === "1" ? presetRef : undefined}
                              accessibilityRole="button"
                              accessibilityLabel={preset.label}
                              accessibilityState={{
                                disabled: mutation.isPending,
                                ...(Platform.OS !== "web" ? { selected } : {}),
                              }}
                              aria-pressed={selected}
                              disabled={mutation.isPending}
                              onPress={() => dispatch({ type: "hours", value: preset.value })}
                              style={({ pressed }) => [
                                styles.preset,
                                selected && styles.presetSelected,
                                pressed && !selected && styles.pressed,
                                mutation.isPending && styles.disabled,
                              ]}
                            >
                              <Text
                                style={[
                                  selected ? styles.primaryText : styles.text,
                                  { fontSize: 13 },
                                ]}
                              >
                                {preset.label}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                      <View style={[styles.line, { flexWrap: "wrap" }]}>
                        <Text style={styles.text}>Stop after</Text>
                        <TextInput
                          accessibilityLabel="Stop after (hours)"
                          accessibilityHint="Enter a duration from 0.25 to 168 hours."
                          value={view.hours}
                          onChangeText={(value) => dispatch({ type: "hours", value })}
                          keyboardType="decimal-pad"
                          editable={!mutation.isPending}
                          selectTextOnFocus
                          style={styles.duration}
                        />
                        <Text style={styles.muted}>hours</Text>
                      </View>
                      {validHours.success && (
                        <Text style={styles.muted}>
                          Earliest stop: {stopTime(view.now + validHours.data * 3_600_000)}
                        </Text>
                      )}
                      {view.error && (
                        <Text style={styles.danger} accessibilityRole="alert">
                          {view.error}
                        </Text>
                      )}
                      <ControlButton
                        label={
                          mutation.isPending && mutation.variables?.action === "schedule"
                            ? "Scheduling…"
                            : hasPendingStop
                            ? "Update schedule"
                            : "Schedule stop"
                        }
                        styles={styles}
                        primary
                        disabled={mutation.isPending}
                        onPress={() => submit("schedule")}
                      />
                    </View>
                  ) : (
                    <View style={styles.section}>
                      <Text style={styles.strong}>
                        {currentRow?.stop?.state === "stopping"
                          ? "Stopping process…"
                          : "Process controls unavailable"}
                      </Text>
                      <Text style={styles.muted}>
                        {!currentRow
                          ? "This conversation is no longer in the open tabs list."
                          : query.data?.supported === false
                          ? query.data.reason
                          : currentRow.stop?.state === "stopping"
                          ? "Waiting for the process to exit."
                          : currentRow.runtime.unavailableReason ??
                            "This conversation has no process to stop."}
                      </Text>
                      {view.error && (
                        <Text style={styles.danger} accessibilityRole="alert">
                          {view.error}
                        </Text>
                      )}
                    </View>
                  )}
                  {currentRow?.stop?.state === "failed" && (
                    <Text style={styles.danger} accessibilityRole="alert">
                      {currentRow.stop.error ?? "The previous stop failed. Try again."}
                    </Text>
                  )}
                  {canStop && (
                    <View style={styles.divider}>
                      <View style={styles.line}>
                        <Icon name="Square" size={16} color={theme.colors.statusDanger} />
                        <Text style={styles.strong}>
                          {working ? "Stop after active work" : "Free memory now"}
                        </Text>
                      </View>
                      <Text style={styles.muted}>
                        {working
                          ? "The process will stop when its current work finishes."
                          : "Stop the idle process and release its memory."}
                      </Text>
                      <ControlButton
                        label={working ? "Stop when finished…" : "Stop process now"}
                        styles={styles}
                        danger
                        disabled={mutation.isPending}
                        onPress={() =>
                          dispatch({
                            type: "dialog",
                            value: { ...dialog, kind: "stop" },
                          })
                        }
                      />
                    </View>
                  )}
                  <Text style={styles.muted}>
                    Your conversation and tab stay open. Send a message to resume.
                  </Text>
                </>
              )}
              {dialog.kind === "stop" && (
                <Text style={styles.text}>
                  Only the process will stop. If work is in progress, the stop request will wait.
                  Your conversation and tab will remain available. Send another message to resume
                  the agent.
                </Text>
              )}
              {dialog.kind === "stop" && view.error && (
                <Text style={styles.danger} accessibilityRole="alert">
                  {view.error}
                </Text>
              )}
              {dialog.kind === "stop" && (
                <View style={styles.footer}>
                  <ControlButton
                    label="Back"
                    buttonRef={backRef}
                    styles={styles}
                    disabled={mutation.isPending}
                    onPress={() =>
                      dispatch({
                        type: "dialog",
                        value: { ...dialog, kind: "menu" },
                      })
                    }
                  />
                  <ControlButton
                    label={
                      mutation.isPending
                        ? "Requesting stop…"
                        : working
                        ? "Stop when finished"
                        : "Stop process"
                    }
                    styles={styles}
                    primary
                    danger
                    disabled={mutation.isPending || !canStop}
                    onPress={() => submit("now")}
                  />
                </View>
              )}
            </View>
          )}
        </Modal.Content>
      </Modal>
    </>
  );
}
