# Screenshot provenance

Captured on October 16, 2026 from the real Paseo 0.11.2 bundled web app and Free Your Agents, using Chromium through Playwright at a 1440 × 960 desktop viewport.

- `free-your-agents.png` shows the screen opened from the sidebar after enabling the Codex and Claude controls, with five open demo conversations (three Codex, two Claude).
- `conversations.png` shows the same list scrolled down: four idle processes, one stopped process, and a stop scheduled two hours ahead.
- `stop-menu.png` shows the process control dialog opened with an idle conversation's Control button.

The conversations ran in an isolated daemon and demo workspace. Each received one fixture message answered by a local loopback model server, so no request reached a model provider. Memory values are real measurements of those processes. The stop and the schedule were made through the plugin.

No production conversation content, account emails or credentials are included. The screenshots are direct browser captures; the displayed interface was not retouched.
