import assert from "node:assert/strict";
import { test } from "node:test";
import { baseProvider, bridgeProvider } from "./provider-profiles";

test("display identity follows profile ancestry independently of command overrides", () => {
  const providers = {
    "claude-main": { extends: "claude" },
    "claude-sub": { extends: "claude-main" },
    "codex-sub": { extends: "codex" },
    "custom-name": { extends: "claude-sub", command: ["/custom/cli"] },
    "claude-lookalike": {},
    cycleA: { extends: "cycleB" },
    cycleB: { extends: "cycleA" },
    broken: { extends: "missing" },
  };
  assert.equal(baseProvider(providers, "claude"), "claude");
  assert.equal(baseProvider(providers, "codex"), "codex");
  assert.equal(baseProvider(providers, "claude-main"), "claude");
  assert.equal(baseProvider(providers, "claude-sub"), "claude");
  assert.equal(baseProvider(providers, "codex-sub"), "codex");
  assert.equal(baseProvider(providers, "custom-name"), "claude");
  assert.equal(bridgeProvider(providers, "custom-name"), null);
  for (const provider of ["claude-lookalike", "cycleA", "broken", "missing"])
    assert.equal(baseProvider(providers, provider), null);
});

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
