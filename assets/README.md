# Screenshot provenance

Captured on October 19, 2026 from the real Paseo 0.12.0 bundled web app and Free Your Agents, with Codex 0.163.0 and Claude 2.1.301, using Chromium through Playwright at a 1440 × 960 desktop viewport.

- `free-your-agents.png` shows the screen opened from the sidebar, with process control on for Codex and Claude by default and five open demo conversations (three Codex, two Claude).
- `conversations.png` shows the same list scrolled down and sorted by memory, highest first: four idle processes, one stopped process, and a stop scheduled two hours ahead.
- `stop-menu.png` shows the process control dialog opened with an idle conversation's Control button.

The conversations ran in an isolated daemon and demo workspace. Each received one fixture message answered by a local loopback model server, so no request reached a model provider. Memory values are real measurements of those processes. The stop and the schedule were made through the plugin.

No production conversation content, account emails or credentials are included. The screenshots are direct browser captures; the displayed interface was not retouched.
