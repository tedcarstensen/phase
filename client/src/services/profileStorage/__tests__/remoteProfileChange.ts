import { vi } from "vitest";

import { profileStorage, type ProfileChange } from "..";

/**
 * Deliver a profile change that originated in another tab.
 *
 * Peer writes reach a tab through the profile store's `BroadcastChannel`,
 * which needs a second live browsing context — more than a unit test can
 * stand up. Capturing the store's own subscribers gives the code under test
 * exactly what a real peer write would deliver, without changing production
 * code to make itself testable.
 *
 * Call inside `beforeEach`, after any `clearAllMocks`, and before the code
 * under test subscribes.
 */
const nativeSubscribe = profileStorage.subscribe.bind(profileStorage);

export interface RemoteProfileChannel {
  /** Notify every current subscriber as if a peer tab had written `key`. */
  emit(key: string): void;
}

export function captureRemoteProfileChanges(): RemoteProfileChannel {
  const listeners: Array<(change: ProfileChange) => void> = [];

  vi.spyOn(profileStorage, "subscribe").mockImplementation((listener) => {
    listeners.push(listener);
    const unsubscribe = nativeSubscribe(listener);
    return () => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
      unsubscribe();
    };
  });

  return {
    emit(key) {
      for (const listener of [...listeners]) listener({ key, origin: "remote" });
    },
  };
}
