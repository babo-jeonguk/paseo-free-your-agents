// Consume one frame at a time. Awaiting the handler applies backpressure instead
// of retaining a promise/parsed payload for every incoming readline event.
// This bounds queued frames, NOT a single arbitrarily large JSON line. A future
// streaming envelope reader must preserve injected hook/RPC obligations too.
export async function pumpJsonLines(input, receive) {
  let parts = [],
    bytes = 0;
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    for (;;) {
      const newline = chunk.indexOf(10, offset);
      if (newline === -1) break;
      const fragment = chunk.subarray(offset, newline);
      let frame = parts.length
        ? Buffer.concat([...parts, fragment], bytes + fragment.length)
        : fragment;
      parts = [];
      bytes = 0;
      await receive(JSON.parse(frame.toString("utf8")));
      frame = null;
      offset = newline + 1;
    }
    if (offset < chunk.length) {
      const remainder = chunk.subarray(offset);
      parts.push(remainder);
      bytes += remainder.length;
    }
  }
  if (bytes) await receive(JSON.parse(Buffer.concat(parts, bytes).toString("utf8")));
}

// Resolve after the writable has consumed this frame; callers must await it.
// A write returning false is never followed by another frame from that caller
// while its first write remains buffered. Each frame is still serialized whole.
export async function writeJsonLine(output, value) {
  return writeProtocolBytes(output, JSON.stringify(value) + "\n");
}

export async function writeProtocolBytes(output, line) {
  await new Promise((resolve, reject) => {
    const failed = (error) => {
      output.off("close", closed);
      reject(error);
    };
    const closed = () => {
      output.off("error", failed);
      reject(new Error("Provider protocol output closed"));
    };
    output.once("error", failed);
    output.once("close", closed);
    output.write(line, (error) => {
      output.off("close", closed);
      if (error) {
        // Writable emits its error after invoking this callback. Keep the
        // one-shot error listener attached to consume that event as well.
        reject(error);
      } else {
        output.off("error", failed);
        resolve();
      }
    });
  });
}

// A streamed replay spans many writes. Hold one lane for its entire envelope so
// notifications/ordinary replies cannot appear inside the JSON response.
export function createProtocolWriter(output) {
  let tail = Promise.resolve(),
    failed = null;
  const transaction = (work) => {
    const result = tail.then(async () => {
      if (failed) throw failed;
      try {
        return await work((chunk) => writeProtocolBytes(output, chunk));
      } catch (error) {
        failed = error;
        throw error;
      }
    });
    tail = result.catch(() => {});
    return result;
  };
  return {
    transaction,
    send: (value) => transaction((write) => write(JSON.stringify(value) + "\n")),
  };
}
