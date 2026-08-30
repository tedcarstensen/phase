import "fake-indexeddb/auto";

import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import {
  deleteDeck,
  getDeckMeta,
  listSavedDeckNames,
  loadActiveDeckName,
  loadSavedDeck,
  saveActiveDeckName,
  saveSavedDeckRaw,
  stampDeckMeta,
} from "../../../constants/storage";
import { applyBackup, buildBackup } from "../../backup";
import {
  _resetProfileStorageForTests,
  hydrateProfileStorage,
  profileStorage,
} from "..";

const AZORIUS = JSON.stringify({
  main: [{ name: "Island", count: 24 }],
  sideboard: [],
});

/**
 * The rest of the deck suite runs on the localStorage fallback, because
 * happy-dom has no IndexedDB. These cases exercise the same helpers against
 * the backend production actually uses, so a durability regression in the
 * write-through path cannot hide behind a green fallback suite.
 */
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  _resetProfileStorageForTests();
});

describe("saved decks on the IndexedDB backend", () => {
  it("survives a reload", async () => {
    await hydrateProfileStorage();
    saveSavedDeckRaw("Azorius Control", AZORIUS);
    stampDeckMeta("Azorius Control", 1234);
    saveActiveDeckName("Azorius Control");
    await profileStorage.flush();

    _resetProfileStorageForTests();
    await hydrateProfileStorage();

    expect(listSavedDeckNames()).toEqual(["Azorius Control"]);
    expect(loadSavedDeck("Azorius Control")?.main).toEqual([{ name: "Island", count: 24 }]);
    expect(getDeckMeta("Azorius Control")).toEqual({ addedAt: 1234 });
    expect(loadActiveDeckName()).toBe("Azorius Control");
  });

  it("deletes durably, clearing metadata and the active-deck pointer", async () => {
    await hydrateProfileStorage();
    saveSavedDeckRaw("Azorius Control", AZORIUS);
    stampDeckMeta("Azorius Control");
    saveActiveDeckName("Azorius Control");

    deleteDeck("Azorius Control");
    await profileStorage.flush();

    _resetProfileStorageForTests();
    await hydrateProfileStorage();

    expect(listSavedDeckNames()).toEqual([]);
    expect(getDeckMeta("Azorius Control")).toBeNull();
    expect(loadActiveDeckName()).toBeNull();
  });

  it("round-trips a backup envelope through the durable store", async () => {
    await hydrateProfileStorage();
    saveSavedDeckRaw("Azorius Control", AZORIUS);
    stampDeckMeta("Azorius Control", 1234);
    saveActiveDeckName("Azorius Control");

    const exported = buildBackup();
    expect(exported.decks).toEqual({ "Azorius Control": AZORIUS });
    expect(exported.activeDeck).toBe("Azorius Control");

    // A different device's snapshot replaces the profile wholesale.
    applyBackup(
      { ...exported, decks: { "Gruul Aggro": AZORIUS }, activeDeck: "Gruul Aggro" },
      "overwrite",
    );
    await profileStorage.flush();

    _resetProfileStorageForTests();
    await hydrateProfileStorage();

    expect(listSavedDeckNames()).toEqual(["Gruul Aggro"]);
    expect(loadActiveDeckName()).toBe("Gruul Aggro");
  });

  it("carries decks migrated out of localStorage into the deck helpers", async () => {
    localStorage.setItem("phase-deck:Legacy Deck", AZORIUS);
    localStorage.setItem("phase-active-deck", "Legacy Deck");

    await hydrateProfileStorage();

    expect(listSavedDeckNames()).toEqual(["Legacy Deck"]);
    expect(loadActiveDeckName()).toBe("Legacy Deck");
    expect(loadSavedDeck("Legacy Deck")?.main).toEqual([{ name: "Island", count: 24 }]);
  });
});
