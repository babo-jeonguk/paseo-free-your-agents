# Runtime Control for Paseo

**Free agent memory without losing the conversation.**

Every open Codex or Claude conversation in Paseo keeps its CLI process running, even when it is idle. With many open tabs those processes add up. In our measurements an idle Codex process used about 60 MB and an idle Claude process about 120 MB (PSS) after a short conversation; longer conversations use more.

Runtime Control shows which conversations hold that memory and stops the idle processes for you. The conversation, its history and its tab stay open. Sending the next message starts the process again and continues the same session.

![Runtime Control with process memory, provider setup and open conversations](assets/runtime-control.png)

## What you can do

- **See where memory goes.** Every open conversation across your windows and devices on one host is listed with its agent, status and process memory, plus totals.
- **Find what you can free.** Filter by **Idle**, **Working**, **No process** or **Unknown**, and search by title or workspace.
- **Stop an idle process now**, or **schedule a stop** after a chosen time (1 hour by default, from 15 minutes to 7 days). Cancel a schedule at any time.
- **Never interrupt work.** A stop waits while the agent is working, waiting for a permission, running background tasks or goals, or has scheduled activity.
- **Resume by sending a message.** The stopped conversation keeps its history and tab, and its next message starts the process again.
- **Open a conversation** from its row.

![Open conversations grouped as Idle and No process, with a scheduled stop](assets/conversations.png)

![Process control menu for one conversation](assets/stop-menu.png)

## Requirements

- **Linux or Windows.** Process controls work on Linux and Windows. On macOS the screen opens but reports that controls are unavailable. On Windows, Claude controls need Node.js on `PATH`, because Paseo starts Claude without a shell.
- **Paseo daemon and app 0.11.2**, with plugins enabled in the daemon configuration.
- Validated with **Codex 0.162.1** and **Claude 2.1.299**. Other versions keep working normally, but process control stays disabled for them.

## Install and enable

```sh
paseo plugin install github:babo-jeonguk/paseo-runtime-control
```

The plugin ID is `runtime-control`. A local checkout can also be installed with `paseo plugin install /absolute/path/to/paseo-runtime-control`.

Open **Settings → Plugins → runtime-control → Settings** and turn on the **Codex** and/or **Claude** switches. Changes are saved immediately. This changes only that provider's launch command through Paseo's public configuration API, so the plugin's lightweight CLI bridge can stop and restart the process. No Paseo installation files or Claude settings files are patched.

Provider profiles that extend Codex or Claude without their own command, such as `claude-main`, use the same command and get the same controls under their own name.

New conversations use the controls immediately. Existing conversations keep their current launch settings until the next natural **Paseo daemon restart**. The plugin never restarts the daemon or interrupts existing work to adopt them.

## Details

- Open **Control** beside a conversation’s process status to see its current state and memory. Choose a duration and press **Schedule stop**, or **Update schedule** to replace an existing deadline. The delay counts from when you save it, with 30 min and 1, 2, 4 and 8-hour presets or a custom 0.25 to 168 hours. **Cancel scheduled stop** appears with a pending stop and never starts a stopped process.
- **Stop process now** has a separate confirmation. During active work it becomes **Stop when finished…** and waits for that work to finish. **Back** returns to the panel with the entered duration intact.
- Each conversation is in exactly one category, by process and work status. **Working** includes background work. Counts sum to **All**. Selected categories combine with **OR**; **All** clears them and keeps the search text. Stop schedules appear under **Process control** and never change a category.
- Closing the last tab of a conversation removes its row; stopping its process keeps the row. Shared provider-subagent tabs stay on their parent's row and count its process once.
- A window that disconnects keeps its last reported tabs, marked **Sync pending**, until it reports again.
- An empty Codex conversation can be stopped after its first completed message saves its history. A Claude conversation that has not started its CLI yet shows **Status unavailable** until it does. If the plugin cannot confirm which process belongs to a conversation, it never stops it.

## Compatibility and data

Unknown native protocols or disabled Claude hooks keep normal messages usable but disable process control. Web tab reporting is verified with the stock production app. The read-only React/Fabric layout adapter is private and version-dependent; iOS/Android device validation is still required. When discovery fails, it preserves uncertainty instead of reporting an empty tab list.

Memory shows the PSS of each conversation's native process and its child processes where available, with RSS estimates otherwise. On Windows it shows the process tree's working set. The lightweight bridge, about 15 MB per conversation, stays running after a stop and is not included. Native full-JSON parsing can create temporary peaks; the standalone bridge collects released history allocations after stopping, without changing daemon/app GC settings.

Long Codex history is replayed from private encrypted temporary files: memory-only AES-256-GCM keys, authenticated chunks and a complete manifest. Defaults are 256 MiB per artifact and 512 MiB per bridge. Storage/verification failure keeps native running. Resume/normal exit remove owned files; a later launch conservatively removes proven-dead owners' encrypted files. Uncertain or replaced files are preserved. This isolates OS users; it does not defend against malicious code already running as your OS user.

## Restore and uninstall

In **Settings → Plugins → runtime-control → Settings**, turn off **Codex** and **Claude** before uninstalling. Turning a switch off restores that provider’s original launch command. Custom argv is restored exactly; an originally default command becomes explicit `["codex"]` or `["claude"]`, because Paseo cannot delete just that override. Observed later user command changes are preserved. Public configuration has no compare-and-swap, so simultaneous edits of the same field can still race.

If removal happens before restoration, retained private launchers forward new sessions to the original CLI without a session recipe. Existing bridge-backed sessions also remain usable. These small immutable assets and ownership receipts are deliberately retained because captured sessions/configuration may still refer to them. Do not delete their plugin-data directory while a launch command or existing session still uses it.

## Roadmap

Paseo does not yet offer public APIs for discovering open tabs, stopping a conversation's provider process, or restoring a stopped process when the next message arrives. The CLI bridges and the read-only tab adapter fill those gaps. When Paseo supports these capabilities, Runtime Control will replace the corresponding implementation with the official APIs.

## Development

```sh
npm ci
npm run build:runtime
npm run check
```

`server/runtime-assets.generated.ts` bundles the Node-only bridge sources in `server/runtime/`. Rebuild it with `npm run build:runtime` after changing those sources; `npm run check` fails when the committed bundle no longer matches them. Paseo installs from Git without running a build, so the generated file is committed. There are no runtime downloads.
