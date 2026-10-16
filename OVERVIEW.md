Free Your Agents shows memory use for open Codex and Claude conversations in Paseo. Stop an idle agent process now or schedule a one-time stop, while the conversation and its tab stay open. Sending another message resumes the same session. Stops wait while the agent is working, waiting for permission, or running background tasks or goals.

The screen lists every open conversation on the host, across windows and devices, with its status and process memory. Filter by Idle, Working, No process or Unknown, or search by title and workspace.

## Setup

Process control runs on Linux and Windows daemon hosts with Paseo v0.11 or later. On macOS the screen loads, but process controls are unavailable. It is validated with Codex v0.162.1 and Claude v2.1.299. With other versions, conversations work normally but process control stays off. On Windows, Claude needs Node.js on PATH.

When the plugin first runs, it turns on process control for Codex and Claude by changing each provider's launch command to a small bridge. New conversations use it right away. After installing or updating, restart the Paseo daemon so that conversations that were already open use it too; the plugin never restarts the daemon itself. To leave a provider unchanged, turn it off in Settings → Plugins → free-your-agents → Settings. Turning a provider off restores its original launch command, so do this before uninstalling.

## Data and limits

The plugin reads conversation titles, providers and workspaces through Paseo's API, open tab IDs from the app windows, and process memory from the operating system. It stores schedules, open-tab lists and original launch commands in its plugin data. After a stop, long Codex histories are replayed from encrypted temporary files that are deleted on resume. It makes no network requests of its own.

The bridge, about 15 MB per conversation, keeps running after a stop and is not counted in the totals. Memory is PSS on Linux and working set on Windows. Open tabs are read through a read-only adapter for the app's internals until Paseo offers a public API. It is tested in the web app; native iOS and Android apps are not validated yet.
