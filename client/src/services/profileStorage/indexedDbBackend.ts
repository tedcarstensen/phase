import { createStore, del, set } from "idb-keyval";

import type { ProfileChange, ProfileStorage, ProfileStorageBackendId } from "./types";

/** Cross-tab replication channel. One message per profile mutation. */
const BROADCAST_CHANNEL = "phase-profile-storage";

type ProfileBroadcast =
  | { readonly type: "set"; readonly key: string; readonly value: string }
  | { readonly type: "remove"; readonly key: string };

function isProfileBroadcast(data: unknown): data is ProfileBroadcast {
  if (data == null || typeof data !== "object") return false;
  const msg = data as Record<string, unknown>;
  if (typeof msg.key !== "string") return false;
  if (msg.type === "remove") return true;
  return msg.type === "set" && typeof msg.value === "string";
}

/**
 * IndexedDB-backed profile store: an in-memory mirror serves every synchronous
 * read, and each mutation is written through to IndexedDB on a serialized
 * queue so writes land in the order they were issued.
 *
 * Durability trade-off, stated plainly: `setItem` returns before the IndexedDB
 * transaction commits, so a tab killed within that window loses the last
 * write. `installProfileFlushHandlers` closes the realistic case by flushing
 * on page-hide, and the queue drains on a microtask, so the exposure is
 * milliseconds. In exchange the profile escapes localStorage's ~5MB origin
 * quota — a limit a few hundred saved decks reach, and which fails writes
 * outright rather than degrading.
 *
 * Cross-tab replication rides a `BroadcastChannel`: localStorage's `storage`
 * event is what other tabs used to observe, and IndexedDB has no equivalent.
 */
export function createIndexedDbProfile(
  mirror: Map<string, string>,
  store: ReturnType<typeof createStore>,
  listeners: ReadonlySet<(change: ProfileChange) => void>,
): Omit<ProfileStorage, "subscribe"> {
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (op: () => Promise<void>, key: string): void => {
    queue = queue.then(op).catch((err: unknown) => {
      console.warn(`[profileStorage] IndexedDB write failed for "${key}":`, err);
    });
  };

  const notify = (change: ProfileChange): void => {
    for (const listener of listeners) listener(change);
  };

  const channel =
    typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(BROADCAST_CHANNEL);
  if (channel) {
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (!isProfileBroadcast(event.data)) return;
      // The peer tab already committed this to the shared IndexedDB store;
      // this tab only needs to catch its mirror up and tell its own views.
      if (event.data.type === "set") mirror.set(event.data.key, event.data.value);
      else mirror.delete(event.data.key);
      notify({ key: event.data.key, origin: "remote" });
    };
  }

  const broadcast = (message: ProfileBroadcast): void => {
    try {
      channel?.postMessage(message);
    } catch (err) {
      console.warn("[profileStorage] cross-tab broadcast failed:", err);
    }
  };

  return {
    backend: "indexeddb" satisfies ProfileStorageBackendId,
    getItem: (key) => mirror.get(key) ?? null,
    setItem: (key, value) => {
      if (mirror.get(key) === value) return;
      mirror.set(key, value);
      enqueue(() => set(key, value, store), key);
      broadcast({ type: "set", key, value });
      notify({ key, origin: "local" });
    },
    removeItem: (key) => {
      if (!mirror.has(key)) return;
      mirror.delete(key);
      enqueue(() => del(key, store), key);
      broadcast({ type: "remove", key });
      notify({ key, origin: "local" });
    },
    keys: () => [...mirror.keys()],
    // Returning the queue tail captures every write issued before this call;
    // writes issued afterwards chain onto a new tail and are not awaited here.
    flush: () => queue,
  };
}
