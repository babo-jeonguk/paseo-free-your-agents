# Runtime Control

**Free agent memory without losing the conversation.**

Codex can keep its app-server alive while idle. Runtime Control lets you stop native Codex and Claude processes while preserving conversations and open tabs. Send a message to resume the same session.

Use **Stop process now**, a one-time **Stop process in…** schedule (one hour by default), or **Cancel scheduled stop**. Active work, permissions, background tasks, goals, and scheduled activity defer termination. Shared subagent tabs retain the parent runtime row. Disconnected windows keep **Sync pending** tab inventories.

The English interface uses Paseo's sidebar header and in-app conversation navigation. Category filters combine with OR.

Enable providers in the Runtime Control screen. New conversations use the controls immediately; existing conversations adopt them after the next natural Paseo daemon restart. No app/daemon installation files are modified. Restore provider commands here before uninstalling.

Linux, Paseo 0.11.2, Codex 0.162.1, and Claude 2.1.299 are validated. The temporary read-only tab adapter uses private host internals; native mobile device validation remains pending. Unsupported protocols or disabled Claude hooks disable termination. Long-history replay uses private encrypted temporary files with keys held only in bridge memory. Lightweight bridges remain resident after native process termination.
