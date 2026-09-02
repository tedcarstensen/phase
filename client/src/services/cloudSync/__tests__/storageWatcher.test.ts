// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { PREFERENCES_KEY } from "../../../constants/storage";
import { profileStorage } from "../../profileStorage";
import {
  watchUserStorage,
  withStorageWatchSuppressed,
} from "../storageWatcher";

/**
 * The watcher observes the durable profile store, not `Storage.prototype`, so
 * every case here drives `profileStorage`. Without IndexedDB (jsdom has none)
 * the store runs on its localStorage fallback, which is what lets these tests
 * still assert against `localStorage` for the written value.
 */
const cleanups: Array<() => void> = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => {
    cleanup();
  });
  localStorage.clear();
  vi.restoreAllMocks();
});

function watch(onDirty: (key: string, origin: "local" | "remote") => void): () => void {
  const cleanup = watchUserStorage(onDirty);
  cleanups.push(cleanup);
  return cleanup;
}

describe("watchUserStorage", () => {
  it("notifies every registration for relevant profile writes and keeps duplicate callbacks independent", () => {
    const first = vi.fn();
    const second = vi.fn();
    const duplicate = vi.fn();
    const removeFirst = watch(first);
    watch(second);
    const removeFirstDuplicate = watch(duplicate);
    watch(duplicate);

    profileStorage.setItem(PREFERENCES_KEY, "first");
    removeFirst();
    removeFirstDuplicate();
    profileStorage.removeItem(PREFERENCES_KEY);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenNthCalledWith(1, PREFERENCES_KEY, "local");
    expect(second).toHaveBeenNthCalledWith(2, PREFERENCES_KEY, "local");
    expect(duplicate).toHaveBeenCalledTimes(3);
  });

  it("ignores non-profile keys and writes before notifying", () => {
    const observedValues: Array<string | null> = [];
    const dirty = vi.fn((key: string) => {
      observedValues.push(profileStorage.getItem(key));
    });
    watch(dirty);

    profileStorage.setItem("unrelated", "ignored");
    profileStorage.setItem(PREFERENCES_KEY, "written-first");

    expect(dirty).toHaveBeenCalledExactlyOnceWith(PREFERENCES_KEY, "local");
    expect(observedValues).toEqual(["written-first"]);
  });

  it("forwards the origin so each subscriber can apply its own policy", () => {
    const dirty = vi.fn();
    const subscribe = vi.spyOn(profileStorage, "subscribe");
    watch(dirty);
    const notifyStore = subscribe.mock.calls[0][0];

    notifyStore({ key: PREFERENCES_KEY, origin: "remote" });

    expect(dirty).toHaveBeenCalledExactlyOnceWith(PREFERENCES_KEY, "remote");
  });

  it("owns one shared store subscription until the final cleanup, then can resubscribe", () => {
    const subscribe = vi.spyOn(profileStorage, "subscribe");
    const unsubscribe = vi.fn();
    subscribe.mockReturnValue(unsubscribe);

    const firstCleanup = watch(vi.fn());
    const secondCleanup = watch(vi.fn());
    expect(subscribe).toHaveBeenCalledTimes(1);

    firstCleanup();
    firstCleanup();
    expect(unsubscribe).not.toHaveBeenCalled();

    secondCleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    watch(vi.fn());
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it("does not notify when the durable write throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage quota exceeded");
    });
    const dirty = vi.fn();
    watch(dirty);

    expect(() => profileStorage.setItem(PREFERENCES_KEY, "nope")).toThrow(
      "storage quota exceeded",
    );
    expect(dirty).not.toHaveBeenCalled();
  });

  it("suppresses all subscribers across nested scopes and restores after a throwing scope", () => {
    const first = vi.fn();
    const second = vi.fn();
    watch(first);
    watch(second);

    withStorageWatchSuppressed(() => {
      profileStorage.setItem(PREFERENCES_KEY, "outer");
      withStorageWatchSuppressed(() => {
        profileStorage.removeItem(PREFERENCES_KEY);
      });
      profileStorage.setItem(PREFERENCES_KEY, "still-outer");
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(() =>
      withStorageWatchSuppressed(() => {
        throw new Error("apply failed");
      }),
    ).toThrow("apply failed");

    profileStorage.setItem(PREFERENCES_KEY, "ordinary");
    expect(first).toHaveBeenCalledExactlyOnceWith(PREFERENCES_KEY, "local");
    expect(second).toHaveBeenCalledExactlyOnceWith(PREFERENCES_KEY, "local");
  });
});
