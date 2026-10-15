// Plugin-owned identity only. No Paseo state or global host method is changed.
const KEY = Symbol.for("paseo.runtime-control.window-owner.v1");
const STORAGE = "@runtime-control:window-owner-v1";
const ownGlobal = globalThis as typeof globalThis & { [KEY]?: Promise<string> };
const fresh = () =>
  `window_${
    globalThis.crypto?.randomUUID?.() ??
    Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2)
  }`;

async function claim(): Promise<string> {
  const locks = globalThis.navigator?.locks;
  if (!locks || typeof sessionStorage === "undefined") return fresh();
  let candidate = fresh();
  try {
    candidate = sessionStorage.getItem(STORAGE) ?? candidate;
  } catch {
    /* Storage can be disabled. */
  }
  async function acquire(id: string, ifAvailable: boolean) {
    return new Promise<boolean>((resolve, reject) => {
      void locks!
        .request("runtime-control:" + id, { ifAvailable }, async (lock) => {
          resolve(lock !== null);
          if (lock) await new Promise<void>(() => {}); // Window lifetime, not plugin lifetime.
        })
        .catch(reject);
    });
  }
  if (!(await acquire(candidate, true))) {
    candidate = fresh();
    await acquire(candidate, false);
  }
  try {
    sessionStorage.setItem(STORAGE, candidate);
  } catch {
    /* Keep the live identity. */
  }
  return candidate;
}

export function getWindowOwnerId(): Promise<string> {
  return (ownGlobal[KEY] ??= claim());
}
