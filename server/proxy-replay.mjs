import { constants } from "node:fs";
import { mkdir, mkdtemp, open, lstat, unlink, rmdir, readdir, readFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HEADER_BYTES = 33; // kind, ciphertext length, nonce, authentication tag
const MANIFEST_LIMIT = 1024;
const privateFile = (info) =>
  info.isFile() && info.uid === process.getuid?.() && (info.mode & 0o777) === 0o600;
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
async function privateDirectory(path) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700
  )
    throw new Error("Replay directory is not private");
  return info;
}

async function processStart(pid) {
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const start = text
      .slice(text.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/)[19];
    return /^\d+$/.test(start ?? "") ? start : undefined;
  } catch (error) {
    return error.code === "ENOENT" ? null : undefined;
  }
}
async function ownerFile(directory) {
  const file = await open(join(directory, "owner.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const identity = await file.stat();
    if (!privateFile(identity) || identity.size > 512) throw new Error("Invalid replay owner");
    const buffer = Buffer.alloc(513),
      read = await file.read(buffer, 0, buffer.length, 0);
    if (read.bytesRead > 512) throw new Error("Invalid replay owner");
    const contents = buffer.subarray(0, read.bytesRead).toString("utf8"),
      value = JSON.parse(contents);
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      value.pid < 1 ||
      !/^\d+$/.test(value.start) ||
      typeof value.id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(value.id)
    )
      throw new Error("Invalid replay owner");
    return { identity, contents, value };
  } finally {
    await file.close();
  }
}
async function removeOwned(path, identity) {
  const info = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return;
  if (!privateFile(info) || !sameFile(info, identity)) throw new Error("Replay file was replaced");
  await unlink(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}
// Linux PID birth time prevents deleting another live facade's files when a PID
// was reused. Uncertain owners, unknown files, symlinks and active stores stay.
// No PID is killed and no key/history payload is needed for orphan cleanup.
async function sweepOrphans(parentDirectory) {
  const names = (await readdir(parentDirectory))
    .filter((name) => /^paseo-rc-replay-[a-zA-Z0-9]+$/.test(name))
    .slice(0, 256);
  for (const name of names) {
    try {
      const directory = join(parentDirectory, name),
        directoryIdentity = await privateDirectory(directory);
      const owner = await ownerFile(directory),
        liveStart = await processStart(owner.value.pid);
      if (liveStart === undefined || liveStart === owner.value.start) continue;
      const files = await readdir(directory);
      if (
        files.length > 129 ||
        files.some((file) => file !== "owner.json" && !/^[a-f0-9-]{36}\.bin$/.test(file))
      )
        continue;
      const identities = [];
      for (const file of files) {
        const path = join(directory, file),
          info = await lstat(path);
        if (!privateFile(info)) throw new Error("Unknown orphan content");
        identities.push({ path, info });
      }
      if (
        (await ownerFile(directory)).contents !== owner.contents ||
        !sameFile(directoryIdentity, await privateDirectory(directory))
      )
        continue;
      for (const { path, info } of identities.filter(
        (entry) => entry.path !== join(directory, "owner.json"),
      ))
        await removeOwned(path, info);
      await removeOwned(join(directory, "owner.json"), owner.identity);
      await rmdir(directory).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    } catch {
      /* A cleanup ambiguity must not prevent a new conversation. */
    }
  }
}

// Native responses are JSON values. Encode them in small pieces so encryption
// does not allocate another whole transcript string. Parsing the native line
// still has its own transient allocation; this module does not hide that fact.
export function* encodeJson(value) {
  function* string(value) {
    yield Buffer.from('"');
    for (let offset = 0; offset < value.length; offset += 8192)
      yield Buffer.from(JSON.stringify(value.slice(offset, offset + 8192)).slice(1, -1));
    yield Buffer.from('"');
  }
  function* visit(value) {
    if (typeof value === "string") yield* string(value);
    else if (value === null || typeof value === "number" || typeof value === "boolean")
      yield Buffer.from(JSON.stringify(value));
    else if (Array.isArray(value)) {
      yield Buffer.from("[");
      for (let index = 0; index < value.length; index++) {
        if (index) yield Buffer.from(",");
        yield* visit(value[index]);
      }
      yield Buffer.from("]");
    } else if (
      value &&
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      yield Buffer.from("{");
      let count = 0;
      for (const name of Object.keys(value)) {
        if (count++) yield Buffer.from(",");
        yield* string(name);
        yield Buffer.from(":");
        yield* visit(value[name]);
      }
      yield Buffer.from("}");
    } else throw new Error("Replay accepts native JSON values only");
  }
  yield* visit(value);
}

export class ReplayInterrupted extends Error {
  constructor() {
    super("Encrypted history replay was interrupted");
  }
}

export async function createEncryptedReplay({
  parentDirectory,
  maxBytes = 512 * 1024 * 1024,
  maxEntryBytes = 256 * 1024 * 1024,
  maxEntries = 128,
  chunkBytes = 64 * 1024,
} = {}) {
  for (const value of [maxBytes, maxEntryBytes, maxEntries, chunkBytes])
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid replay budget");
  if (chunkBytes > 1024 * 1024) throw new Error("Replay chunks must remain bounded");
  parentDirectory ??= join(tmpdir(), `paseo-rc-replays-${process.getuid?.()}`);
  await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
  await privateDirectory(parentDirectory);
  await sweepOrphans(parentDirectory);
  const start = await processStart(process.pid);
  if (!start) throw new Error("Replay ownership requires Linux process identity");
  const directory = await mkdtemp(join(parentDirectory, "paseo-rc-replay-"));
  const directoryIdentity = await privateDirectory(directory);
  const ownerPath = join(directory, "owner.json");
  const ownerHandle = await open(
    ownerPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let ownerIdentity;
  try {
    await ownerHandle.writeFile(
      JSON.stringify({ version: 1, pid: process.pid, start, id: randomUUID() }),
    );
    ownerIdentity = await ownerHandle.stat();
  } finally {
    await ownerHandle.close();
  }
  const secret = randomBytes(32); // Never persisted, returned, logged, or passed to a child.
  const entries = new Map();
  let bytes = 0,
    closed = false,
    tail = Promise.resolve();
  const serial = (work) => {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  };
  const assertOpen = async () => {
    if (closed || !sameFile(directoryIdentity, await privateDirectory(directory)))
      throw new Error("Replay store is closed or replaced");
  };
  const encodedKey = (key) => {
    if (typeof key !== "string" || Buffer.byteLength(key) > 4096)
      throw new Error("Invalid replay key");
    return createHash("sha256").update(key).digest("hex");
  };
  const pathFor = (entry) => join(directory, entry.id + ".bin");
  const aad = (entry, kind, index, length) =>
    Buffer.from(JSON.stringify([1, entry.id, entry.digest, kind, index, length]));
  async function remove(entry) {
    const path = pathFor(entry);
    const info = await lstat(path).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info && (!privateFile(info) || !sameFile(info, entry.identity)))
      throw new Error("Replay file was replaced");
    if (info) await unlink(path);
    entries.delete(entry.digest);
    bytes -= entry.bytes;
  }
  async function readExact(file, size, position) {
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const result = await file.read(buffer, offset, size - offset, position + offset);
      if (!result.bytesRead) throw new Error("Truncated replay");
      offset += result.bytesRead;
    }
    return buffer;
  }
  async function openEntry(entry) {
    await assertOpen();
    const file = await open(pathFor(entry), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!privateFile(info) || !sameFile(info, entry.identity) || info.size !== entry.bytes)
        throw new Error("Invalid replay file");
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  async function* decode(file, entry) {
    let position = 0,
      index = 0,
      plainBytes = 0;
    for (;;) {
      const header = await readExact(file, HEADER_BYTES, position);
      const kind = header[0],
        length = header.readUInt32BE(1);
      if (
        (kind !== 0 && kind !== 1) ||
        length < 1 ||
        length > (kind === 0 ? chunkBytes : MANIFEST_LIMIT)
      )
        throw new Error("Invalid replay record");
      position += HEADER_BYTES;
      if (position + length > entry.bytes) throw new Error("Truncated replay record");
      const encrypted = await readExact(file, length, position);
      position += length;
      const decipher = createDecipheriv("aes-256-gcm", secret, header.subarray(5, 17));
      decipher.setAAD(aad(entry, kind, index, length));
      decipher.setAuthTag(header.subarray(17, 33));
      // Do not yield decipher.update() output before final() authenticates it.
      const provisional = decipher.update(encrypted);
      let final;
      try {
        final = decipher.final();
      } catch (error) {
        provisional.fill(0);
        throw error;
      }
      const plain = final.length ? Buffer.concat([provisional, final]) : provisional;
      if (kind === 1) {
        const manifest = JSON.parse(plain.toString("utf8"));
        plain.fill(0);
        if (
          manifest.version !== 1 ||
          manifest.id !== entry.id ||
          manifest.digest !== entry.digest ||
          manifest.chunks !== index ||
          manifest.plainBytes !== plainBytes ||
          index !== entry.chunks ||
          plainBytes !== entry.plainBytes ||
          position !== entry.bytes
        )
          throw new Error("Incomplete replay manifest");
        const info = await file.stat();
        if (!privateFile(info) || !sameFile(info, entry.identity) || info.size !== entry.bytes)
          throw new Error("Replay changed during verification");
        return;
      }
      index++;
      plainBytes += plain.length;
      if (index > entry.chunks || plainBytes > entry.plainBytes) {
        plain.fill(0);
        throw new Error("Replay exceeds its manifest");
      }
      try {
        yield plain;
      } finally {
        plain.fill(0);
      }
    }
  }
  async function verify(file, entry) {
    for await (const _chunk of decode(file, entry)) {
      /* Authenticate all chunks and the final manifest. */
    }
  }
  async function clear() {
    await assertOpen();
    for (const entry of [...entries.values()]) await remove(entry);
  }
  return {
    directory,
    has(key) {
      return entries.has(encodedKey(key));
    },
    stats: () => ({ entries: entries.size, bytes, maxBytes, maxEntryBytes, chunkBytes }),
    capture: (key, source) =>
      serial(async () => {
        let file, entry, createdPath;
        try {
          await assertOpen();
          const digest = encodedKey(key);
          if (entries.has(digest)) await remove(entries.get(digest));
          if (entries.size >= maxEntries) return false;
          entry = { id: randomUUID(), digest, bytes: 0, plainBytes: 0, chunks: 0, identity: null };
          createdPath = pathFor(entry);
          file = await open(
            createdPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
          entry.identity = await file.stat();
          if (!privateFile(entry.identity)) throw new Error("Replay file is not private");
          async function record(kind, plain) {
            const total = HEADER_BYTES + plain.length;
            if (entry.bytes + total > maxEntryBytes || bytes + entry.bytes + total > maxBytes)
              throw new Error("Replay quota exceeded");
            const nonce = randomBytes(12),
              cipher = createCipheriv("aes-256-gcm", secret, nonce);
            cipher.setAAD(aad(entry, kind, entry.chunks, plain.length));
            const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
            const header = Buffer.alloc(HEADER_BYTES);
            header[0] = kind;
            header.writeUInt32BE(encrypted.length, 1);
            nonce.copy(header, 5);
            cipher.getAuthTag().copy(header, 17);
            await file.writeFile(header);
            await file.writeFile(encrypted);
            entry.bytes += total;
          }
          let pending = Buffer.alloc(chunkBytes),
            used = 0;
          for await (const input of source) {
            if (!(input instanceof Uint8Array)) throw new Error("Replay source must contain bytes");
            let offset = 0;
            while (offset < input.length) {
              const take = Math.min(chunkBytes - used, input.length - offset);
              pending.set(input.subarray(offset, offset + take), used);
              used += take;
              offset += take;
              if (used === chunkBytes) {
                await record(0, pending);
                entry.chunks++;
                entry.plainBytes += used;
                pending.fill(0);
                used = 0;
              }
            }
          }
          if (used) {
            await record(0, pending.subarray(0, used));
            entry.chunks++;
            entry.plainBytes += used;
          }
          pending.fill(0);
          if (!entry.chunks) throw new Error("Empty replay is invalid");
          await record(
            1,
            Buffer.from(
              JSON.stringify({
                version: 1,
                id: entry.id,
                digest: entry.digest,
                chunks: entry.chunks,
                plainBytes: entry.plainBytes,
              }),
            ),
          );
          await file.sync();
          await file.close();
          file = null;
          // Only a complete, authenticated container becomes visible in the
          // in-memory index. There is no persistent index or recoverable key.
          entries.set(digest, entry);
          bytes += entry.bytes;
          return true;
        } catch {
          if (file) await file.close().catch(() => {});
          if (createdPath && entry?.identity) {
            const info = await lstat(createdPath).catch(() => null);
            if (info && privateFile(info) && sameFile(info, entry.identity))
              await unlink(createdPath).catch(() => {});
          }
          return false;
        }
      }),
    verifyAll: () =>
      serial(async () => {
        try {
          await assertOpen();
          for (const entry of entries.values()) {
            const file = await openEntry(entry);
            try {
              await verify(file, entry);
            } finally {
              await file.close();
            }
          }
          return true;
        } catch {
          return false;
        }
      }),
    replay: (key, { prefix, suffix, write }) =>
      serial(async () => {
        let file,
          started = false;
        try {
          const entry = entries.get(encodedKey(key));
          if (!entry) return false;
          file = await openEntry(entry);
          // Complete preflight happens before emitting even the JSON prefix.
          await verify(file, entry);
          started = true;
          await write(prefix);
          for await (const chunk of decode(file, entry)) await write(chunk);
          await write(suffix);
          return true;
        } catch {
          if (started) throw new ReplayInterrupted();
          return false;
        } finally {
          if (file) await file.close();
        }
      }),
    clear: () => serial(clear),
    close: () =>
      serial(async () => {
        if (closed) return;
        try {
          await clear();
          await removeOwned(ownerPath, ownerIdentity);
          await rmdir(directory);
        } finally {
          closed = true;
          secret.fill(0);
        }
      }),
  };
}
