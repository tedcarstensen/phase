/**
 * Which durable backend the profile store resolved to at boot.
 *
 * `indexeddb` is the intended path: no practical size limit, not subject to
 * localStorage's ~5MB origin quota. `localstorage` is the graceful-degradation
 * path for environments where IndexedDB is missing or blocked (some private
 * browsing modes, hardened enterprise profiles, test environments).
 */
export type ProfileStorageBackendId = "indexeddb" | "localstorage";

/**
 * Where a change originated. Typed rather than a boolean so callers can
 * dispatch on it: cloud sync marks the profile dirty only for `local` writes
 * (a `remote` change is another tab of this same origin, which is already
 * pushing it), while view-refresh listeners react to both.
 */
export type ProfileChangeOrigin = "local" | "remote";

export interface ProfileChange {
  readonly key: string;
  readonly origin: ProfileChangeOrigin;
}

/**
 * Durable, synchronous key/value store for the user's portable profile —
 * saved decks, deck organization, preferences, feed subscriptions.
 *
 * The read/write surface is deliberately `localStorage`-shaped (synchronous
 * `getItem`/`setItem`/`removeItem`) because it is consumed from React render
 * paths and from Zustand's `persist` middleware, neither of which can await.
 * Durability is provided by an asynchronous write-through to IndexedDB behind
 * an in-memory mirror that is hydrated once, before the app mounts.
 */
export interface ProfileStorage {
  /** Backend actually in use after hydration. */
  readonly backend: ProfileStorageBackendId;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** Every profile key currently held, in unspecified order. */
  keys(): string[];
  /**
   * Observe profile mutations. This is the single chokepoint that replaces
   * patching `Storage.prototype`: every write to the user's profile goes
   * through `setItem`/`removeItem` here, including writes replicated from
   * another tab. Returns an unsubscribe function.
   */
  subscribe(listener: (change: ProfileChange) => void): () => void;
  /**
   * Resolve once every write issued so far has been committed to the durable
   * backend. Called on page-hide and by tests; normal call sites never need it.
   */
  flush(): Promise<void>;
}
