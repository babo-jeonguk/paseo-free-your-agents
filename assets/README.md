# Screenshot provenance

Captured on October 22, 2026 from the real Paseo 0.12.0 bundled web app and the Free Your Agents v1.1.1 candidate, with Codex 0.163.0 and Claude 2.1.301, using Chromium through Playwright at a 1440 × 960 desktop viewport.

- `free-your-agents.png` shows the screen opened from the sidebar, with process control on for Codex and Claude by default and five open demo conversations (three Codex, two Claude).
- `conversations.png` shows the same list scrolled down and sorted by memory, highest first: provider logos with status badges, four idle processes, one stopped process, and a stop scheduled two hours ahead.
- `stop-menu.png` shows the process control dialog opened with an idle conversation's Control button.
- `bulk-selection.png` shows three selected conversations and their combined process memory, including one conversation whose process is already stopped. Checkboxes replace the logos in the same position, keeping titles aligned with the unselected list.
- `bulk-control.png` shows the bulk controls for that selection, including eligible counts for each action.
- `bulk-results.png` shows two accepted stop requests and one skipped conversation with no process to stop. Both selected native processes were confirmed stopped through the plugin's inventory before capture.

The conversations ran in an isolated daemon and demo workspace. Each received one fixture message answered by a local loopback model server, so no request reached a model provider. Memory values are real measurements of those processes. Stops and schedules were made through the plugin; bulk scheduling, cancellation and stopping were exercised through its actual web interface.

No production conversation content, account emails or credentials are included. The screenshots are direct browser captures; the displayed interface was not retouched.
