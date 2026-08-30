import "fake-indexeddb/auto";

import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { STORAGE_KEY_PREFIX } from "../../../constants/profileKeys";
import {
  _resetProfileStorageForTests,
  hydrateProfileStorage,
  profileStorage,
} from "..";

const DECK_A = `${STORAGE_KEY_PREFIX}Azorius Control`;
const DECK_B = `${STORAGE_KEY_PREFIX}Gruul Aggro`;

beforeEach(() => {
  // A fresh factory gives every test its own empty IndexedDB.
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  _resetProfileStorageForTests();
});

describe("profileStorage backend resolution", () => {
  it("hydrates onto IndexedDB when it is available", async () => {
    const result = await hydrateProfileStorage();
    expect(result.backend).toBe("indexeddb");
    expect(profileStorage.backend).toBe("indexeddb");
  });

  it("falls back to localStorage when IndexedDB is missing", async () => {
    const original = globalThis.indexedDB;
    // @ts-expect-error deliberately removing the global for the fallback path
    delete globalThis.indexedDB;
    try {
      const result = await hydrateProfileStorage();
      expect(result.backend).toBe("localstorage");
      profileStorage.setItem(DECK_A, "{}");
      expect(localStorage.getItem(DECK_A)).toBe("{}");
    } finally {
      globalThis.indexedDB = original;
    }
  });

  it("falls back to localStorage without touching data when IndexedDB throws", async () => {
    localStorage.setItem(DECK_A, '{"name":"a"}');
    vi.spyOn(globalThis.indexedDB, "open").mockImplementation(() => {
      throw new Error("blocked");
    });

    const result = await hydrateProfileStorage();

    expect(result.backend).toBe("localstorage");
    expect(profileStorage.getItem(DECK_A)).toBe('{"name":"a"}');
    expect(localStorage.getItem(DECK_A)).toBe('{"name":"a"}');
  });
});

describe("profileStorage reads and writes", () => {
  it("round-trips values through the durable store, not localStorage", async () => {
    await hydrateProfileStorage();

    profileStorage.setItem(DECK_A, '{"name":"a"}');
    await profileStorage.flush();

    expect(profileStorage.getItem(DECK_A)).toBe('{"name":"a"}');
    // The whole point of the move: profile data no longer occupies the
    // ~5MB localStorage origin quota.
    expect(localStorage.getItem(DECK_A)).toBeNull();
  });

  it("survives a reload by rehydrating from IndexedDB", async () => {
    await hydrateProfileStorage();
    profileStorage.setItem(DECK_A, '{"name":"a"}');
    profileStorage.setItem(DECK_B, '{"name":"b"}');
    await profileStorage.flush();

    _resetProfileStorageForTests();
    const result = await hydrateProfileStorage();

    expect(result.entries).toBe(2);
    expect(profileStorage.getItem(DECK_A)).toBe('{"name":"a"}');
    expect(profileStorage.getItem(DECK_B)).toBe('{"name":"b"}');
  });

  it("removes entries durably", async () => {
    await hydrateProfileStorage();
    profileStorage.setItem(DECK_A, "{}");
    profileStorage.removeItem(DECK_A);
    await profileStorage.flush();

    _resetProfileStorageForTests();
    await hydrateProfileStorage();

    expect(profileStorage.getItem(DECK_A)).toBeNull();
    expect(profileStorage.keys()).toEqual([]);
  });

  it("reports missing keys as null and lists only stored keys", async () => {
    await hydrateProfileStorage();
    profileStorage.setItem(DECK_B, "{}");

    expect(profileStorage.getItem(DECK_A)).toBeNull();
    expect(profileStorage.keys()).toEqual([DECK_B]);
  });

  it("never surfaces the migration marker as a profile key", async () => {
    await hydrateProfileStorage();
    _resetProfileStorageForTests();
    await hydrateProfileStorage();

    expect(profileStorage.keys()).toEqual([]);
  });
});

describe("profileStorage change notifications", () => {
  it("notifies subscribers registered before hydration", async () => {
    const seen: string[] = [];
    profileStorage.subscribe((change) => seen.push(`${change.origin}:${change.key}`));

    await hydrateProfileStorage();
    profileStorage.setItem(DECK_A, "{}");
    profileStorage.removeItem(DECK_A);

    expect(seen).toEqual([`local:${DECK_A}`, `local:${DECK_A}`]);
  });

  it("stops notifying after unsubscribe", async () => {
    await hydrateProfileStorage();
    const listener = vi.fn();
    const unsubscribe = profileStorage.subscribe(listener);
    unsubscribe();

    profileStorage.setItem(DECK_A, "{}");

    expect(listener).not.toHaveBeenCalled();
  });

  it("does not notify when a write does not change the value", async () => {
    await hydrateProfileStorage();
    profileStorage.setItem(DECK_A, "{}");
    const listener = vi.fn();
    profileStorage.subscribe(listener);

    profileStorage.setItem(DECK_A, "{}");
    profileStorage.removeItem(DECK_B);

    expect(listener).not.toHaveBeenCalled();
  });

  it("applies the same no-op rule on the localStorage fallback", async () => {
    const original = globalThis.indexedDB;
    // @ts-expect-error deliberately removing the global for the fallback path
    delete globalThis.indexedDB;
    try {
      await hydrateProfileStorage();
      profileStorage.setItem(DECK_A, "{}");
      const listener = vi.fn();
      profileStorage.subscribe(listener);

      profileStorage.setItem(DECK_A, "{}");
      profileStorage.removeItem(DECK_B);
      expect(listener).not.toHaveBeenCalled();

      profileStorage.setItem(DECK_A, '{"changed":true}');
      expect(listener).toHaveBeenCalledWith({ key: DECK_A, origin: "local" });
    } finally {
      globalThis.indexedDB = original;
    }
  });
});
