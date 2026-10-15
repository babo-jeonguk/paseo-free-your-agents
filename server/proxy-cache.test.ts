import assert from "node:assert/strict";
import { test } from "node:test";
import { createReplyCache } from "./proxy-cache.mjs";

test("reply retention accounts for UTF-8 keys and values, uses LRU, and returns isolated copies", () => {
  const cache = createReplyCache({ maxBytes: 50, maxEntryBytes: 40, maxEntries: 2 });
  assert.equal(cache.set("a", { text: "한" }), true);
  assert.equal(cache.stats().bytes, Buffer.byteLength('a{"text":"한"}'));
  assert.equal(cache.set("b", { text: "two" }), true);
  const read = cache.get<{ text: string }>("a")!;
  read.text = "changed";
  assert.equal(cache.get<{ text: string }>("a")!.text, "한");
  assert.equal(cache.set("c", { text: "three" }), true);
  assert.equal(cache.has("b"), false);
  assert.ok(cache.stats().bytes <= 50);
  assert.deepEqual(cache.keys(), ["a", "c"]);
});

test("required histories stay replayable; capacity failure never discards another required reply", () => {
  const cache = createReplyCache({ maxBytes: 26, maxEntryBytes: 26, maxEntries: 2 });
  assert.equal(cache.set("root", "history", { required: true }), true);
  assert.equal(cache.set("child", "12345", { required: true }), true);
  assert.equal(cache.set("other", "x"), false);
  assert.equal(cache.get("root"), "history");
  assert.equal(cache.get("child"), "12345");
  cache.unpin();
  assert.equal(cache.set("other", "x"), true);
  assert.ok(cache.stats().bytes <= 26);
  cache.clear();
  assert.deepEqual(cache.stats(), { entries: 0, bytes: 0, maxBytes: 26, maxEntryBytes: 26 });
});

test("oversized replacement invalidates the stale reply and limits keys/individual responses", () => {
  const cache = createReplyCache({ maxBytes: 50, maxEntryBytes: 16, maxKeyBytes: 4 });
  assert.equal(cache.set("root", "old", { required: true }), true);
  assert.equal(cache.set("root", "x".repeat(30), { required: true }), false);
  assert.equal(cache.has("root"), false);
  assert.equal(cache.set("12345", "x"), false);
  assert.equal(cache.set("root", undefined), false);
  assert.equal(cache.stats().bytes, 0);
  assert.throws(() => createReplyCache({ maxBytes: -1 }), /Invalid reply cache limit/);
});
