import { createStore, entries, get, set } from "idb-keyval";

import { isUserOwnedStorageKey } from "../../constants/profileKeys";

import { createIndexedDbProfile } from "./indexedDbBackend";
import { createLocalStorageProfile } from "./localStorageBackend";
import type {
  ProfileChange,
  ProfileStorage,
  ProfileStorageBackendId,
} from "./types";

export type {
  ProfileChange,
  ProfileChangeOrigin,
  ProfileStorage,
  ProfileStorageBackendId,
} from "./types";

const PROFILE_DB = "phase-profile";

/**
 * Reserved IndexedDB record marking a completed localStorage→IndexedDB
 * migration. Kept inside the profile store (rather than in localStorage) so
 * the marker cannot outlive the data it describes: wiping site data clears
 * both together, and a fresh browser profile re-runs the migration against
 * whatever localStorage holds.
 */
const MIGRATION_META_KEY = "__phase_profile_meta__";

interface MigrationMeta {
  readonly version: 1;
  readonly migratedAt: string;
  readonly migratedKeys: number;
}

export interface ProfileMigrationReport {
  /** Legacy localStorage entries copied into IndexedDB by this boot. */
  readonly imported: number;
  /** Legacy entries whose IndexedDB copy could not be verified; left in place. */
  readonly unverified: readonly string[];
}

export interface ProfileHydrationResult {
  readonly backend: ProfileStorageBackendId;
  readonly entries: number;
  readonly migration: ProfileMigrationReport;
}

const EMPTY_MIGRATION: ProfileMigrationReport = { imported: 0, unverified: [] };

/**
 * Listener registry lives at module scope, not inside an implementation, so
 * subscriptions taken before `hydrateProfileStorage` (module-init time) still
 * fire after the backend swaps underneath them.
 */
const listeners = new Set<(change: ProfileChange) => void>();

/**
 * Pre-hydration default. Reads and writes go to localStorage until hydration
 * resolves a durable backend, so a module that touches the profile at import
 * time sees the same data it always did rather than an empty store.
 */
let impl: Omit<ProfileStorage, "subscribe"> = createLocalStorageProfile(listeners);
let hydration: Promise<ProfileHydrationResult> | null = null;

/**
 * The application's durable profile store. A stable object that delegates to
 * whichever backend hydration selected — callers may capture it at import time.
 */
export const profileStorage: ProfileStorage = {
  get backend() {
    return impl.backend;
  },
  getItem: (key) => impl.getItem(key),
  setItem: (key, value) => impl.setItem(key, value),
  removeItem: (key) => impl.removeItem(key),
  keys: () => impl.keys(),
  subscribe: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  flush: () => impl.flush(),
};

function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

/** Snapshot every portable-profile entry currently in localStorage. */
function readLegacyProfile(): Map<string, string> {
  const legacy = new Map<string, string>();
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key === null || !isUserOwnedStorageKey(key)) continue;
    const value = localStorage.getItem(key);
    if (value !== null) legacy.set(key, value);
  }
  return legacy;
}

/**
 * Copy `pending` into IndexedDB, then delete each legacy localStorage entry
 * whose copy reads back byte-identical from a *fresh* read of the store.
 *
 * The read-back is the whole point: a write that silently failed (quota,
 * corrupted store, a backend that accepted the transaction but lost it) leaves
 * the localStorage original untouched, so the next boot migrates it again.
 * Nothing is ever deleted on the strength of an un-verified write.
 */
async function migrateLegacyProfile(
  pending: ReadonlyMap<string, string>,
  store: ReturnType<typeof createStore>,
): Promise<ProfileMigrationReport> {
  if (pending.size === 0) return EMPTY_MIGRATION;

  for (const [key, value] of pending) await set(key, value, store);

  const committed = new Map(
    (await entries(store)).map(([key, value]) => [String(key), value as string]),
  );

  const unverified: string[] = [];
  let imported = 0;
  for (const [key, value] of pending) {
    if (committed.get(key) === value) {
      localStorage.removeItem(key);
      imported += 1;
    } else {
      unverified.push(key);
    }
  }
  return { imported, unverified };
}

/**
 * Resolve the durable backend and hydrate the in-memory mirror. Must be
 * awaited before React mounts: every synchronous profile read after this point
 * is served from the mirror it fills.
 *
 * Migration rules, in one place:
 * - **No completed migration yet** — localStorage is the authority for every
 *   key it still holds, and its value overwrites whatever an earlier aborted
 *   attempt left in IndexedDB. Records IndexedDB holds that localStorage does
 *   not are kept, not pruned: the only way to produce one is an aborted run,
 *   and keeping a stale deck costs far less than a pruning rule that would
 *   also wipe a real migration whose marker write happened to fail.
 * - **Migration already completed** — IndexedDB is the authority. The app no
 *   longer writes profile data to localStorage, so anything still sitting
 *   there came from an older bundle; it is adopted only for keys IndexedDB
 *   does not already hold.
 *
 * Any failure along the way leaves the store on localStorage with the user's
 * data untouched, because deletion happens only after a verified read-back.
 */
export function hydrateProfileStorage(): Promise<ProfileHydrationResult> {
  hydration ??= (async (): Promise<ProfileHydrationResult> => {
    if (!isIndexedDbAvailable()) {
      return { backend: "localstorage", entries: impl.keys().length, migration: EMPTY_MIGRATION };
    }

    try {
      const store = createStore(PROFILE_DB, PROFILE_DB);
      const meta = await get<MigrationMeta>(MIGRATION_META_KEY, store);

      const mirror = new Map<string, string>();
      for (const [key, value] of await entries(store)) {
        const name = String(key);
        if (name !== MIGRATION_META_KEY) mirror.set(name, value as string);
      }

      const legacy = readLegacyProfile();
      const pending = new Map(
        meta === undefined
          ? legacy
          : [...legacy].filter(([key]) => !mirror.has(key)),
      );
      const migration = await migrateLegacyProfile(pending, store);
      for (const [key, value] of pending) {
        if (!migration.unverified.includes(key)) mirror.set(key, value);
      }

      // Only claim the initial scan is done when every legacy entry made it.
      // Leaving the marker unwritten keeps localStorage the wholesale authority
      // for one more boot, which is the conservative side of the ambiguity.
      if (meta === undefined && migration.unverified.length === 0) {
        await set(
          MIGRATION_META_KEY,
          {
            version: 1,
            migratedAt: new Date().toISOString(),
            migratedKeys: migration.imported,
          } satisfies MigrationMeta,
          store,
        );
      }

      impl = createIndexedDbProfile(mirror, store, listeners);
      return { backend: "indexeddb", entries: mirror.size, migration };
    } catch (err) {
      // IndexedDB missing, blocked, or mid-migration failure. localStorage
      // still holds everything that was not verified as copied, so staying on
      // it is lossless — the next boot retries the migration.
      console.warn("[profileStorage] falling back to localStorage:", err);
      return { backend: "localstorage", entries: impl.keys().length, migration: EMPTY_MIGRATION };
    }
  })();
  return hydration;
}

/**
 * Flush pending writes when the page is being hidden or torn down. `pagehide`
 * is the reliable signal on mobile Safari, where `beforeunload` may never
 * fire; `visibilitychange` covers tab switches that precede a background kill.
 */
export function installProfileFlushHandlers(): () => void {
  const flush = (): void => void profileStorage.flush();
  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") flush();
  };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("pagehide", flush);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/** @internal Reset the store to its pre-hydration state. Tests only. */
export function _resetProfileStorageForTests(): void {
  listeners.clear();
  impl = createLocalStorageProfile(listeners);
  hydration = null;
}
