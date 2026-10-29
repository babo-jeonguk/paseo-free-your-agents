**Development has ended. Supports Paseo 0.11–0.13 only. Paseo 0.14 and later, including 0.14 prereleases, are unsupported; no further updates are planned.**

Paseo 0.14 introduces built-in idle runtime cleanup, releasing eligible runtimes after one idle hour and resuming the saved session on the next message. This covers the plugin's original memory-reclamation goal. Manual stops, custom schedules and the memory display remain plugin-specific features. See the [official release notes](https://github.com/getpaseo/paseo/releases/tag/v0.14.0-beta.2#improved).

Before upgrading to Paseo 0.14, turn off Codex and Claude in the plugin's Settings to restore their launch commands, uninstall the plugin, and restart the daemon when no agents are working. Complete this on Paseo 0.11–0.13, while the plugin's settings are accessible. On 0.14, built-in cleanup is enabled by default under Settings → your host → Agents → Release idle agents.

Free Your Agents shows memory use for open Codex and Claude conversations in Paseo. Stop an idle agent process now or schedule a one-time stop. Reservations can be made while the agent is working, and their timer starts when saved. Stops wait while the agent is working, waiting for permission, or running background tasks or goals. The conversation and its tab stay open; sending another message resumes the same session.

The screen lists managed conversation tabs on the host, across windows and devices, with their status and process memory. Filter by Idle, Working, No process or Unknown, search by title and workspace, or sort by memory. Mobile sheets are excluded. Background workspaces are excluded by default; enable **Include background conversations** in the plugin's Settings to include their open tabs. Turning it off cancels their pending stops.

Checkbox selection adds bulk process controls: schedule or update stops, cancel pending schedules, or request stops for several conversations together. The selection shows combined process memory, and each operation reports successes, failures and skipped conversations separately.

## Setup

Process control runs on Linux and Windows daemon hosts with Paseo v0.11–v0.13 (`>=0.11.0 <0.14.0-0`). On macOS the screen loads, but process controls are unavailable. Compatibility is established from the live Codex or Claude protocol contract rather than an exact CLI version list; missing or unknown evidence keeps the process running. On Windows, Claude needs Node.js on PATH.

When the plugin first runs, it turns on process control for Codex and Claude by changing each provider's launch command to a small bridge. New conversations use it right away. After installing, or when an update changes the bridge, restart the Paseo daemon so that conversations that were already open use it too; the plugin never restarts the daemon itself. Interface-only updates leave existing bridges in place. To leave a provider unchanged, turn it off in Settings → Plugins → free-your-agents → Settings. Turning a provider off restores its original launch command, so do this before uninstalling.

## Data and limits

The plugin reads conversation titles, providers and workspaces through Paseo's API, open tab IDs from the app windows, and process memory from the operating system. It stores management settings, schedules, open-tab lists and original launch commands in its plugin data. After a stop, long Codex histories are replayed from encrypted temporary files that are deleted on resume. It makes no network requests of its own.

The bridge, about 20 MB per conversation, keeps running after a stop and is not counted in the totals. Memory is PSS on Linux and working set on Windows. Open tabs are read through a read-only adapter for the app's internals until Paseo offers a public API. It is tested in the web app; native iOS and Android apps are not validated yet.
