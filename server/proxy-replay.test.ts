import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  open,
  truncate,
  chmod,
  rename,
  writeFile,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createEncryptedReplay, encodeJson, ReplayInterrupted } from "./proxy-replay.mjs";

// Windows has no owner-only mode bits, and symlinks need extra privileges there.
const posix = process.platform !== "win32";

async function setup(t: { after(fn: () => Promise<void>): void }, options = {}) {
  const parentDirectory = await mkdtemp(join(tmpdir(), "fya-replay-test-"));
  const store = await createEncryptedReplay({ parentDirectory, ...options });
  t.after(async () => {
    await store.close().catch(() => {});
    await rm(parentDirectory, { recursive: true, force: true });
  });
  const file = async () =>
    join(store.directory, (await readdir(store.directory)).find((name) => name.endsWith(".bin"))!);
  return { store, file, parentDirectory };
}
const response = (write: (chunk: Uint8Array) => Promise<void>) => ({
  prefix: Buffer.from('{"id":7,"result":'),
  suffix: Buffer.from("}\n"),
  write,
});
async function replay(store: Awaited<ReturnType<typeof createEncryptedReplay>>, key: string) {
  const chunks: Buffer[] = [];
  const ok = await store.replay(
    key,
    response(async (chunk) => {
      chunks.push(Buffer.from(chunk));
    }),
  );
  return { ok, chunks, wire: Buffer.concat(chunks).toString("utf8") };
}

test("encrypted replay supports history above the old RAM limit with bounded authenticated chunks", async (t) => {
  const { store, file } = await setup(t);
  const marker = "PRIVATE_RUNTIME_HISTORY_";
  const history = {
    thread: { id: "root", turns: [{ items: [{ text: marker + "한😀\u2028".repeat(900000) }] }] },
  };
  assert.equal(await store.capture("generation:root", encodeJson(history)), true);
  const path = await file();
  if (posix) {
    assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  const disk = await readFile(path);
  assert.ok(disk.length > 8 * 1024 * 1024);
  assert.equal(disk.includes(Buffer.from(marker)), false, "No plaintext transcript copy at rest");
  assert.equal(await store.verifyAll(), true);
  const got = await replay(store, "generation:root");
  assert.equal(got.ok, true);
  assert.deepEqual(JSON.parse(got.wire), { id: 7, result: history });
  assert.ok(Math.max(...got.chunks.map((chunk) => chunk.length)) <= 65536);
  assert.equal(store.has("other-generation:root"), false);
  await store.close();
  await assert.rejects(stat(store.directory), { code: "ENOENT" });
  await store.close();
});

test("streamed JSON preserves escapes and surrogate pairs at encoder slice boundaries", async () => {
  const value = {
    text: "x".repeat(8191) + '😀\u0000"\\\n한\ud800',
    array: [null, true, 1.2, { 'a"b': "\u2029" }],
  };
  const chunks = [...encodeJson(value)];
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), value);
  assert.throws(() => [...encodeJson({ invalid: undefined })], /native JSON values/);
});

test("streamed JSON stays in bounded pieces for large and multibyte histories", () => {
  const value = {
    turns: Array.from({ length: 3000 }, (_, index) => ({
      id: index,
      text: index % 2 ? "한".repeat(9000) : "\u0000".repeat(index % 7),
      done: index % 3 === 0,
      nothing: null,
    })),
  };
  const chunks = [...encodeJson(value)];
  assert.ok(chunks.length > 100);
  assert.ok(chunks.every((chunk) => chunk.length > 0 && chunk.length < 100 * 1024));
  assert.equal(Buffer.concat(chunks).toString("utf8"), JSON.stringify(value));
});

test("tampering, truncation, reordered chunks and corrupted manifest fail before any output", async (t) => {
  for (const mode of ["ciphertext", "truncate", "reorder", "manifest"]) {
    const { store, file } = await setup(t, { chunkBytes: 64 });
    assert.equal(await store.capture("root", encodeJson({ text: "fixture".repeat(50) })), true);
    const path = await file(),
      original = await readFile(path),
      changed = Buffer.from(original);
    if (mode === "truncate") await truncate(path, original.length - 1);
    else {
      if (mode === "ciphertext") changed[33] ^= 1;
      if (mode === "manifest") changed[original.length - 1] ^= 1;
      if (mode === "reorder") {
        // First two data records have equal lengths but are bound to indexes.
        original.copy(changed, 0, 97, 194);
        original.copy(changed, 97, 0, 97);
      }
      await writeFile(path, changed);
    }
    assert.equal(await store.verifyAll(), false, mode);
    const got = await replay(store, "root");
    assert.equal(got.ok, false, mode);
    assert.equal(got.wire, "", mode);
  }
});

test("artifact identity prevents swapping replies between conversations or stores", async (t) => {
  const { store } = await setup(t);
  assert.equal(await store.capture("root", encodeJson({ text: "root" })), true);
  const first = (await readdir(store.directory)).find((name) => name.endsWith(".bin"))!;
  assert.equal(await store.capture("child", encodeJson({ text: "child" })), true);
  const second = (await readdir(store.directory)).find(
    (name) => name !== first && name.endsWith(".bin"),
  )!;
  const firstPath = join(store.directory, first),
    secondPath = join(store.directory, second);
  const bytes = await readFile(secondPath);
  await writeFile(firstPath, bytes);
  assert.equal((await replay(store, "root")).ok, false);
  assert.equal((await replay(store, "child")).ok, true);
  const other = await setup(t);
  assert.equal(other.store.has("child"), false, "Keys and indexes are process-local");
});

test("quotas and interrupted capture never publish partial or stale successful responses", async (t) => {
  const { store } = await setup(t, { maxBytes: 700, maxEntryBytes: 600, chunkBytes: 64 });
  assert.equal(await store.capture("root", encodeJson({ text: "x".repeat(100) })), true);
  assert.equal(await store.capture("child", encodeJson({ text: "x".repeat(100) })), false);
  assert.equal(store.has("root"), true);
  assert.equal(await store.capture("root", encodeJson({ text: "x".repeat(2000) })), false);
  assert.equal(store.has("root"), false, "Failed replacement must not serve stale history");
  assert.deepEqual(await readdir(store.directory), ["owner.json"]);
  async function* broken() {
    yield Buffer.from("x".repeat(128));
    throw new Error("fixture input failure");
  }
  assert.equal(await store.capture("broken", broken()), false);
  assert.deepEqual(await readdir(store.directory), ["owner.json"]);
  assert.equal(store.stats().bytes, 0);
});

test("unsafe permissions and symlink replacement cannot leak or delete another file", { skip: !posix }, async (t) => {
  const { store, file, parentDirectory } = await setup(t);
  assert.equal(await store.capture("root", encodeJson({ text: "fixture" })), true);
  const path = await file();
  await chmod(path, 0o644);
  assert.equal((await replay(store, "root")).ok, false);
  await chmod(path, 0o600);
  const displaced = join(parentDirectory, "displaced.bin");
  await rename(path, displaced);
  const target = join(parentDirectory, "keep.txt");
  await writeFile(target, "preserve this unrelated file", { mode: 0o600 });
  await symlink(target, path);
  assert.equal((await replay(store, "root")).ok, false);
  await assert.rejects(store.close(), /replaced/);
  assert.equal(await readFile(target, "utf8"), "preserve this unrelated file");
  assert.ok((await stat(displaced)).size > 0);
});

test("corruption after preflight interrupts the response instead of emitting unauthenticated history", async (t) => {
  const { store, file } = await setup(t, { chunkBytes: 64 });
  assert.equal(await store.capture("root", encodeJson({ text: "fixture".repeat(50) })), true);
  const path = await file();
  let writes = 0;
  await assert.rejects(
    store.replay(
      "root",
      response(async () => {
        if (writes++ === 0) {
          const file = await open(path, "r+");
          try {
            const byte = Buffer.alloc(1);
            await file.read(byte, 0, 1, 33);
            byte[0] ^= 1;
            await file.write(byte, 0, 1, 33);
          } finally {
            await file.close();
          }
        }
      }),
    ),
    ReplayInterrupted,
  );
  assert.equal(writes, 1, "No unauthenticated data or successful JSON suffix is sent");
});

test("next launch removes crashed encrypted artifacts while preserving other live stores", async (t) => {
  const { store, parentDirectory } = await setup(t);
  assert.equal(await store.capture("live", encodeJson({ text: "keep live history" })), true);
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {createEncryptedReplay,encodeJson} from ${JSON.stringify(
      new URL("./proxy-replay.mjs", import.meta.url).href,
    )};
    const store=await createEncryptedReplay({parentDirectory:${JSON.stringify(parentDirectory)}});
    await store.capture("orphan",encodeJson({text:"crash fixture only"}));
    process.send({directory:store.directory});
    setInterval(()=>{},1000);
  `,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  });
  const [message] = (await once(child, "message", { signal: AbortSignal.timeout(5000) })) as [
    { directory: string },
  ];
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  assert.ok((await stat(message.directory)).isDirectory());
  const next = await createEncryptedReplay({ parentDirectory });
  t.after(() => next.close().catch(() => {}));
  await assert.rejects(stat(message.directory), { code: "ENOENT" });
  assert.equal((await replay(store, "live")).ok, true);
  await next.close();
});
