# Changelog

## 1.2.1 — 2026-10-29

### Changed

- End development following Paseo 0.14's introduction of built-in idle runtime cleanup. No further updates are planned.
- Limit Paseo compatibility to `>=0.11.0 <0.14.0-0`, excluding 0.14 prereleases and later versions. Existing process-control features remain available on Paseo 0.11–0.13.
- Document how to restore provider launch commands and uninstall before upgrading to Paseo 0.14. Built-in cleanup covers automatic idle release and saved-session resume; manual stops, custom schedules and memory reporting are not equivalent features.

## 1.2.0 — 2026-10-27

### Changed

- Support Paseo 0.13 while continuing to support Paseo 0.11 and 0.12.
- Decide whether Codex and Claude can be stopped from their live safety evidence instead of a fixed CLI version list. Compatible CLI updates can work without a plugin update; incomplete or unknown evidence keeps the process running.
- Prevent disconnected or abandoned tab owners from authorizing stale process-control requests.

### Fixed

- Follow Claude's real lifecycle when stopping a process. Background and notification work can finish, the process remains interruptible while draining, and a new message resumes the same conversation.

### Upgrade notes

- Restart the Paseo daemon when no agent is working so existing conversations use the updated bridge. New conversations use it immediately.

## 1.1.1 — 2026-10-22

### Fixed

- Keep conversation titles in place when selection checkboxes appear. Each row now shows a provider logo with a status badge in the same fixed position.
- Show the correct Claude or Codex logo for custom provider profiles that inherit through `extends`.

## 1.1.0 — 2026-10-21

### Added

- Checkbox selection and bulk process controls for Codex and Claude conversations: schedule, update or cancel stops, or request a stop for the selection. ([#7](https://github.com/babo-jeonguk/paseo-free-your-agents/pull/7))
- Selected conversation count and combined process memory.
- Bulk operation progress and per-conversation results for successes, failures and skips.

## 1.0.1 — 2026-10-19

### Added

- Schedule, update or cancel a stop while Claude is working. The timer starts when the schedule is saved. Finishing early does not stop the process early; work that continues past the deadline keeps the process running until it is safe to stop. This also works on Paseo 0.11. ([#5](https://github.com/babo-jeonguk/paseo-free-your-agents/pull/5))
- **Include background conversations** in the plugin's Settings. It is off by default and applies to every window and device connected to the host. Enabling it includes open tabs in background workspaces. ([#4](https://github.com/babo-jeonguk/paseo-free-your-agents/pull/4))

### Changed

- Manage conversations opened as tabs only; mobile conversation sheets are excluded. Background workspaces are excluded from the list, memory totals and process controls unless enabled in Settings. Turning the setting off cancels their pending stops without stopping their processes; turning it back on does not restore those stops. ([#4](https://github.com/babo-jeonguk/paseo-free-your-agents/pull/4))
- Omit the `--no-maglev` workaround on Paseo 0.12 and later, where the upstream validator fix is included. Keep it on Paseo 0.11 and hosts whose version cannot be determined. ([#4](https://github.com/babo-jeonguk/paseo-free-your-agents/pull/4))

### Upgrade notes

- Paseo 0.11 remains supported. The validated agent CLI versions are unchanged: Codex 0.162.1 and 0.163.0, and Claude 2.1.299 and 2.1.301.
- After updating, restart the Paseo daemon when no agent is working so existing conversations use the updated bridge. New conversations use it immediately.
- Existing installations default to excluding background workspaces. Pending stops for conversations outside the managed scope are cancelled when the scope is reconciled. Enable **Include background conversations** and schedule them again if needed.

## 1.0.0 — 2026-10-16

First stable release: memory totals and sorting, status filters, immediate and scheduled stops, and same-session resume for Codex and Claude.

[Release notes](https://github.com/babo-jeonguk/paseo-free-your-agents/releases/tag/v1.0.0).
