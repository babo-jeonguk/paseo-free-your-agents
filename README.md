# Free Your Agents for Paseo

**Reclaim memory from idle agents without losing the conversation.**

Every open Codex or Claude conversation in Paseo keeps its CLI process running, even while idle. Across many open tabs, those idle processes quickly add up—in our measurements, an idle Codex process used around 60 MB and an idle Claude process around 120 MB (PSS) after a short exchange, and longer sessions use significantly more.

**Free Your Agents** shows which open conversations hold memory on your host and lets you stop idle agent processes on demand or on a schedule. Stopping a process frees its native memory while keeping the conversation, its history, and its tab open. Sending your next message automatically starts the process again and resumes the same session.

![Free Your Agents overview with process memory totals, filters, and open conversations](assets/free-your-agents.png)

## Features

- **See where memory goes**: View every open conversation across all windows and devices connected to the same host, with its provider, runtime status, and process-tree memory (plus host totals).
- **Filter what you can free**: Filter open conversations by **Idle**, **Working**, **No process**, or **Unknown** (combined with **OR**), and search by session title or workspace.
- **Stop now or on a schedule**: Stop an idle process immediately, or schedule a one-time stop after a chosen duration (`1 hour` by default, with presets for `30 min`, `1 hour`, `2 hours`, `4 hours`, and `8 hours`, or any custom duration from `15 minutes` to `7 days`). Update or cancel a pending schedule at any time.
- **Never interrupt active work**: Scheduled and manual stops automatically wait while an agent is responding, waiting on a permission prompt, running background tasks or goals, or holding scheduled activity.
- **Seamless resume**: Stopped conversations keep their history and open tab. Sending a new message restarts the native CLI and continues the same session.
- **One-click navigation**: Jump directly to any open conversation from its row.

![Open conversations showing Idle and No process states with a scheduled stop](assets/conversations.png)

![Process control dialog for a single conversation](assets/stop-menu.png)

> Screenshot provenance and capture environment details are documented in [`assets/README.md`](assets/README.md).

## Requirements

- **OS**: **Linux** or **Windows** for active process controls. On macOS, the Free Your Agents screen loads normally and reports that process controls are unavailable. On Windows, Claude controls need Node.js on `PATH`, because Paseo starts Claude without a shell.
- **Paseo**: **Paseo daemon and app `0.11.2` or a later `0.11.x` release (`>=0.11.2 <0.12.0`)**, with plugins enabled in the daemon configuration.
- **Agent CLIs**: Process control is validated with **Codex `0.162.1`** and **Claude `2.1.299`**. Other CLI versions continue to work normally for chat, with process termination safely disabled until validated.

## Installation & Setup

### 1. Enable plugins in Paseo

Make sure plugins are enabled on your target daemon (**Settings → Plugins → Enable plugins** in the app, or `"pluginsEnabled": true` in the daemon's `config.json`).

### 2. Install the plugin

Install from GitHub (or paste the source into **Settings → Plugins → Plugin source** in the app):

```sh
paseo plugin install github:babo-jeonguk/paseo-free-your-agents
```

For a local checkout on the daemon host:

```sh
paseo plugin install /absolute/path/to/paseo-free-your-agents
```

The installed plugin ID is `free-your-agents`.

### 3. Enable provider controls

1. Open **Settings → Plugins → free-your-agents → Settings** in Paseo.
2. Turn on the **Codex** and/or **Claude** switches. Changes save immediately.

Turning on a provider updates only that provider's launch command via Paseo's public configuration API (`paseo.config.get` / `paseo.config.patch`) so conversations launch through Free Your Agents' lightweight CLI bridge. No Paseo installation files or Claude settings files are modified.

- **Extended provider profiles**: Profiles that extend `codex` or `claude` without defining a custom command (such as `claude-main`) automatically inherit the bridge and appear under their own profile name.
- **When controls take effect**: New conversations use process controls immediately. Existing conversations keep their prior launch settings until the next natural **Paseo daemon restart**—the plugin never restarts the daemon or interrupts running sessions to force adoption.

## Using Free Your Agents

- **Manage a conversation's process**: Click **Control** in the **Process control** column to inspect the conversation's current state and memory, schedule a stop (`Schedule stop` / `Update schedule`), or cancel an existing schedule (`Cancel scheduled stop`). Canceling a schedule leaves a running process untouched and never starts a stopped one.
- **Stop immediately or after work finishes**: Selecting **Stop process now** opens a confirmation step (`Back` returns to the panel with your duration draft intact). If the agent is currently busy, the action becomes **Stop when finished…** and waits until all active work completes.
- **Categories & filters**: Every open conversation belongs to exactly one status category—**Idle**, **Working** (which includes background tasks), **No process**, or **Unknown**—whose counts sum to **All**. Category filters combine with **OR**; clicking **All** clears active category filters while preserving your search query. Scheduled stops are shown in the **Process control** column and do not change a row's status category.
- **Summary totals**: The summary cards display total measured native memory and running process counts across open conversations. When some open conversations are not yet measured (for example, sessions created before process controls were enabled), totals are shown as lower bounds (such as `296+ MB`).
- **Tab & window synchronization**: Open tabs are aggregated across all connected windows and devices on the same host. Closing the last open tab of a conversation removes its row; stopping a process keeps the row and tab open. Shared provider-subagent tabs are grouped into their parent conversation's row so the shared process is counted once. If a window disconnects, its last reported tabs remain visible as **Sync pending** until it reconnects.
- **Safety guards**: An empty Codex conversation becomes stoppable after its first completed message saves native history. A Claude conversation that has not yet launched its CLI shows **Status unavailable** until its first managed launch. If process ownership cannot be verified, Free Your Agents never terminates the process.

## Compatibility, Security & Data Handling

- **Graceful fallback**: Unrecognized native protocols or disabled Claude hooks leave normal chat functionality untouched and simply disable process termination for that session.
- **Tab discovery**: The client uses the host's tab observer when available and otherwise falls back to a read-only React/Fabric layout adapter to inspect open tab IDs without mutating host stores. Web tab reporting is verified against the stock production app; native iOS and Android device validation is still pending. If tab discovery fails, the plugin preserves uncertainty rather than reporting a false empty tab list.
- **Memory measurement**: Memory figures report the Linux process-tree PSS of each conversation's native CLI process and its child processes where available, falling back to RSS estimates otherwise. On Windows they report the process-tree working set, read for all conversations from one process table query per refresh. The lightweight Node bridge (~15 MB per conversation) stays resident after a stop to hold the Paseo transport and is excluded from native process totals. After releasing a native process, the standalone bridge reclaims large history allocations without altering daemon or app GC flags.
- **Encrypted temporary replay cache**: To replay long Codex histories after a process stop without retaining them in heap memory, the bridge writes private encrypted temporary files (`0700` directories and `0600` files on Linux; per-user profile permissions on Windows) using a per-bridge, memory-only AES-256-GCM key, independently authenticated 64 KiB chunks, and a verified manifest (capped at 256 MiB per artifact and 512 MiB per bridge). Any storage or verification failure leaves the native process running. Owned replay files are deleted on resume or normal exit, and later launches conservatively sweep files from proven-dead PIDs while preserving active or uncertain files. This provides OS-user isolation (not protection against untrusted code already running as the same OS user).

## Restore & Uninstall

Before uninstalling Free Your Agents, open **Settings → Plugins → free-your-agents → Settings** and turn off **Codex** and **Claude**:

- Turning a switch off restores that provider's original launch command. Custom `argv` arrays are restored verbatim; providers that originally had no custom command are set to explicit `["codex"]` or `["claude"]` (because Paseo's public config patch API cannot delete an individual override key). Later command changes made outside Free Your Agents are detected and preserved.
- If the plugin is uninstalled before turning the switches off, small immutable launcher shims and ownership receipts in `plugin-data` ensure that existing sessions keep working and new sessions transparently delegate to the native CLI. Do not delete the plugin's `plugin-data` directory while a provider launch command or active session still references those launchers.

## Roadmap

Paseo `0.11` does not yet provide public plugin APIs for observing open tabs across workspaces, releasing an idle provider process without archiving the conversation, or lazily resuming a stopped provider process on the next message. Free Your Agents bridges those gaps today with its lightweight CLI wrappers and read-only tab adapter, and is designed to swap in official Paseo APIs as they become available.

## Development

Run checks from the repository root:

```sh
npm ci
npm run build:runtime
npm run check
```

`server/runtime-assets.generated.ts` bundles the auditable, Node-only bridge scripts from `server/runtime/`. Run `npm run build:runtime` after editing files in `server/runtime/`; `npm run check` verifies that the committed bundle matches its sources, runs TypeScript typechecking, and executes the test suite. Because Paseo installs Git plugins directly without running a build step, the generated bundle is committed to the repository and performs no runtime downloads.

## License

[MIT](LICENSE) — see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for third-party notices.
