import "fake-indexeddb/auto";

import { createStore, get, set } from "idb-keyval";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVE_DECK_KEY,
  DECK_METADATA_KEY,
  PREFERENCES_KEY,
  STORAGE_KEY_PREFIX,
} from "../../../constants/profileKeys";
import {
  _resetProfileStorageForTests,
  hydrateProfileStorage,
  profileStorage,
} from "..";

const DECK_A = `${STORAGE_KEY_PREFIX}Azorius Control`;
const DECK_B = `${STORAGE_KEY_PREFIX}Gruul Aggro`;

function profileStore(): ReturnType<typeof createStore> {
  return createStore("phase-profile", "phase-profile");
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  _resetProfileStorageForTests();
});

describe("localStorage → IndexedDB migration", () => {
  it("imports every portable-profile key and clears the legacy copies", async () => {
    localStorage.setItem(DECK_A, '{"name":"a"}');
    localStorage.setItem(DECK_B, '{"name":"b"}');
    localStorage.setItem(DECK_METADATA_KEY, '{"Azorius Control":{"addedAt":1}}');
    localStorage.setItem(ACTIVE_DECK_KEY, "Azorius Control");
    localStorage.setItem(PREFERENCES_KEY, '{"state":{}}');

    const result = await hydrateProfileStorage();

    expect(result.backend).toBe("indexeddb");
    expect(result.migration.imported).toBe(5);
    expect(result.migration.unverified).toEqual([]);
    expect(profileStorage.getItem(DECK_A)).toBe('{"name":"a"}');
    expect(profileStorage.getItem(ACTIVE_DECK_KEY)).toBe("Azorius Control");
    expect(profileStorage.getItem(PREFERENCES_KEY)).toBe('{"state":{}}');
    expect(localStorage.getItem(DECK_A)).toBeNull();
    expect(localStorage.getItem(PREFERENCES_KEY)).toBeNull();
  });

  it("leaves keys that are not part of the portable profile alone", async () => {
    localStorage.setItem("phase-game:abc", '{"turn":3}');
    localStorage.setItem("phase-active-game", '{"id":"abc"}');
    localStorage.setItem(DECK_A, "{}");

    const result = await hydrateProfileStorage();

    expect(result.migration.imported).toBe(1);
    expect(localStorage.getItem("phase-game:abc")).toBe('{"turn":3}');
    expect(localStorage.getItem("phase-active-game")).toBe('{"id":"abc"}');
    expect(profileStorage.getItem("phase-game:abc")).toBeNull();
  });

  it("is a no-op on a second boot", async () => {
    localStorage.setItem(DECK_A, "{}");
    await hydrateProfileStorage();

    _resetProfileStorageForTests();
    const second = await hydrateProfileStorage();

    expect(second.migration.imported).toBe(0);
    expect(second.entries).toBe(1);
    expect(profileStorage.getItem(DECK_A)).toBe("{}");
  });

  it("keeps the legacy copy when the IndexedDB write cannot be verified", async () => {
    localStorage.setItem(DECK_A, '{"name":"a"}');
    localStorage.setItem(DECK_B, '{"name":"b"}');
    // A backend that accepts the write for DECK_B and silently loses it —
    // exactly the case the read-back exists to catch. Nothing may be deleted
    // from localStorage on the strength of such a write.
    const realPut = IDBObjectStore.prototype.put;
    const swallowing = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        if (key === DECK_B) return {} as IDBRequest<IDBValidKey>;
        return realPut.call(this, value, key);
      });

    const result = await hydrateProfileStorage();
    swallowing.mockRestore();

    expect(result.migration.imported).toBe(1);
    expect(result.migration.unverified).toEqual([DECK_B]);
    expect(localStorage.getItem(DECK_A)).toBeNull();
    expect(localStorage.getItem(DECK_B)).toBe('{"name":"b"}');
  });

  it("does not delete anything when the migration write throws", async () => {
    localStorage.setItem(DECK_A, '{"name":"a"}');
    localStorage.setItem(DECK_B, '{"name":"b"}');
    const failing = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

    const result = await hydrateProfileStorage();
    failing.mockRestore();

    expect(result.backend).toBe("localstorage");
    expect(localStorage.getItem(DECK_A)).toBe('{"name":"a"}');
    expect(localStorage.getItem(DECK_B)).toBe('{"name":"b"}');
    expect(profileStorage.getItem(DECK_A)).toBe('{"name":"a"}');
  });

  it("retries the migration on the next boot after a failure", async () => {
    localStorage.setItem(DECK_A, '{"name":"a"}');
    const failing = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementationOnce(() => {
        throw new Error("transient");
      });
    await hydrateProfileStorage();
    failing.mockRestore();

    _resetProfileStorageForTests();
    const second = await hydrateProfileStorage();

    expect(second.backend).toBe("indexeddb");
    expect(second.migration.imported).toBe(1);
    expect(profileStorage.getItem(DECK_A)).toBe('{"name":"a"}');
    expect(localStorage.getItem(DECK_A)).toBeNull();
  });

  it("lets localStorage win over a half-written record from an aborted run", async () => {
    // An aborted run copied a stale deck in without ever writing the marker.
    await set(DECK_A, '{"name":"stale"}', profileStore());
    localStorage.setItem(DECK_A, '{"name":"current"}');

    await hydrateProfileStorage();

    expect(profileStorage.getItem(DECK_A)).toBe('{"name":"current"}');
  });

  it("adopts a stray legacy write from an older bundle after migration", async () => {
    localStorage.setItem(DECK_A, '{"name":"a"}');
    await hydrateProfileStorage();

    // An older bundle ran afterwards and wrote straight to localStorage.
    localStorage.setItem(DECK_B, '{"name":"b"}');
    _resetProfileStorageForTests();
    const second = await hydrateProfileStorage();

    expect(second.migration.imported).toBe(1);
    expect(profileStorage.getItem(DECK_B)).toBe('{"name":"b"}');
    expect(localStorage.getItem(DECK_B)).toBeNull();
  });

  it("does not let a stray legacy write clobber the live IndexedDB value", async () => {
    localStorage.setItem(DECK_A, '{"name":"current"}');
    await hydrateProfileStorage();

    localStorage.setItem(DECK_A, '{"name":"ancient"}');
    _resetProfileStorageForTests();
    await hydrateProfileStorage();

    expect(profileStorage.getItem(DECK_A)).toBe('{"name":"current"}');
  });

  it("records a completion marker so later boots skip the scan", async () => {
    localStorage.setItem(DECK_A, "{}");
    await hydrateProfileStorage();

    const meta = await get<{ version: number; migratedKeys: number }>(
      "__phase_profile_meta__",
      profileStore(),
    );
    expect(meta).toMatchObject({ version: 1, migratedKeys: 1 });
  });
});
