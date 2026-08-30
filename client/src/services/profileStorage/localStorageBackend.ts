import { isUserOwnedStorageKey } from "../../constants/profileKeys";

import type { ProfileChange, ProfileStorage, ProfileStorageBackendId } from "./types";

/**
 * Fallback profile store that delegates straight to `localStorage`.
 *
 * Used when IndexedDB is unavailable or refuses to open (private-browsing
 * modes, hardened profiles, the happy-dom test environment). It carries the
 * pre-existing fragility — a ~5MB origin quota and synchronous writes — but
 * the alternative is losing the user's decks entirely, so degrade rather than
 * fail. Reads go straight through rather than through a mirror so that data
 * written to `localStorage` by anything outside this module is still visible.
 */
export function createLocalStorageProfile(
  listeners: ReadonlySet<(change: ProfileChange) => void>,
): Omit<ProfileStorage, "subscribe"> {
  const notify = (key: string): void => {
    for (const listener of listeners) listener({ key, origin: "local" });
  };

  return {
    backend: "localstorage" satisfies ProfileStorageBackendId,
    getItem: (key) => localStorage.getItem(key),
    // Both backends notify only on an actual change, so a rewrite of an
    // identical value never marks the profile dirty for cloud sync.
    setItem: (key, value) => {
      if (localStorage.getItem(key) === value) return;
      localStorage.setItem(key, value);
      notify(key);
    },
    removeItem: (key) => {
      if (localStorage.getItem(key) === null) return;
      localStorage.removeItem(key);
      notify(key);
    },
    keys: () => {
      const found: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key !== null && isUserOwnedStorageKey(key)) found.push(key);
      }
      return found;
    },
    flush: () => Promise.resolve(),
  };
}
