import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeProvider } from "./provider-profiles";

test("profiles without their own command share their base provider's bridge", () => {
  const providers = {
    claude: { command: ["/launchers/claude.launch"] },
    "claude-main": { extends: "claude", label: "Claude Main" },
    "claude-nested": { extends: "claude-main" },
    "codex-reserve": { extends: "codex" },
    "claude-custom": { extends: "claude", command: ["/opt/other-claude"] },
    opencode: {},
    loop: { extends: "loop" },
  };
  assert.equal(bridgeProvider(providers, "claude"), "claude");
  assert.equal(bridgeProvider(providers, "codex"), "codex");
  assert.equal(bridgeProvider(providers, "claude-main"), "claude");
  assert.equal(bridgeProvider(providers, "claude-nested"), "claude");
  assert.equal(bridgeProvider(providers, "codex-reserve"), "codex");
  // Its own command bypasses the configured bridge.
  assert.equal(bridgeProvider(providers, "claude-custom"), null);
  assert.equal(bridgeProvider(providers, "opencode"), null);
  assert.equal(bridgeProvider(providers, "missing"), null);
  assert.equal(bridgeProvider(providers, "loop"), null);
});
