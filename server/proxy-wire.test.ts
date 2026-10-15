import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable, Writable } from "node:stream";
import { pumpJsonLines, writeJsonLine, createProtocolWriter } from "./proxy-wire.mjs";

test("protocol framing preserves split UTF-8, embedded separators, CRLF and final unterminated line", async () => {
  const wire = Buffer.from('{"text":"한\u2028글"}\r\n{"last":true}');
  const chunks = Array.from(wire, (byte) => Buffer.from([byte]));
  const messages: unknown[] = [],
    frames: string[] = [];
  await pumpJsonLines(Readable.from(chunks), async (message, frame) => {
    messages.push(message);
    frames.push(frame.toString("utf8"));
  });
  assert.deepEqual(messages, [{ text: "한\u2028글" }, { last: true }]);
  // Unchanged messages are forwarded as these exact newline-terminated bytes.
  assert.deepEqual(frames, ['{"text":"한\u2028글"}\r\n', '{"last":true}\n']);
});

test("slow destination consumes one protocol frame before the next handler is admitted", async () => {
  let consumed = 0,
    admitted = 0,
    finishWrite: (() => void) | undefined;
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      finishWrite = () => {
        consumed++;
        callback();
      };
    },
  });
  const pending = pumpJsonLines(
    Readable.from([Buffer.from('{"id":1}\n{"id":2}\n')]),
    async (message) => {
      admitted++;
      await writeJsonLine(output, message);
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(admitted, 1);
  assert.equal(consumed, 0);
  finishWrite!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(admitted, 2);
  assert.equal(consumed, 1);
  finishWrite!();
  await pending;
  assert.equal(consumed, 2);
  assert.equal(output.listenerCount("error"), 0);
  output.end();
});

test("malformed framing and writable failure reject without admitting subsequent frames", async () => {
  let admitted = 0;
  await assert.rejects(
    pumpJsonLines(Readable.from(['bad\n{"id":2}\n']), async () => {
      admitted++;
    }),
  );
  assert.equal(admitted, 0);
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("fixture failure"));
    },
  });
  await assert.rejects(writeJsonLine(output, { id: 1 }), /fixture failure/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(output.listenerCount("error"), 0);
});

test("streamed replay holds the entire response envelope against concurrent notifications", async () => {
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const writer = createProtocolWriter(output);
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const replay = writer.transaction(async (write) => {
    await write('{"id":1,"result":');
    await gate;
    await write('{"history":true}}\n');
  });
  const notification = writer.send({ method: "notification" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(Buffer.concat(chunks).toString(), '{"id":1,"result":');
  resume();
  await Promise.all([replay, notification]);
  assert.equal(
    Buffer.concat(chunks).toString(),
    '{"id":1,"result":{"history":true}}\n{"method":"notification"}\n',
  );
  await assert.rejects(
    writer.transaction(async () => {
      throw new Error("partial replay failure");
    }),
  );
  await assert.rejects(writer.send({ id: 2 }), /partial replay failure/);
  assert.equal(chunks.length, 3, "No output follows a failed streamed transaction");
  output.end();
});
