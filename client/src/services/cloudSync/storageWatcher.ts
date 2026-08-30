import { isUserOwnedStorageKey } from "../../constants/profileKeys";
import { profileStorage, type ProfileChange, type ProfileChangeOrigin } from "../profileStorage";

/**
 * Single chokepoint for "the user's portable profile changed".
 *
 * Writes to user-owned keys are scattered across ~9 call sites (deck builder,
 * feed service, import modal, game setup, precon loader) plus the Zustand
 * `persist` middleware for preferences. Rather than sprinkle markDirty()
 * through every save path, we observe the one store they all write to:
 * `profileStorage` notifies on every `setItem`/`removeItem`, which is the
 * DRY, can't-miss-a-site alternative. It automatically excludes game state,
 * draft blobs, and caches — those live in their own IndexedDB stores and
 * never enter the profile store at all. The extra `isUserOwnedStorageKey`
 * filter keeps that guarantee explicit rather than implied.
 *
 * Subscribers receive the change's `origin` and decide for themselves what to
 * do with it. `local` is this tab's own write; `remote` is a peer tab of the
 * same origin, replicated through the profile store because IndexedDB has no
 * equivalent of the `storage` event. The two mean different things to
 * different consumers — cloud sync must not treat a peer's write as this
 * device's unpushed change, while the deck-library pack must reconcile for
 * both — so the policy belongs at each subscriber, not here.
 *
 * Subscribers share one profile-store subscription, but each registration has
 * its own lifetime. Returns an idempotent uninstaller for this registration.
 */
type UserStorageListener = (key: string, origin: ProfileChangeOrigin) => void;

interface StorageWatcherRegistration {
  onDirty: UserStorageListener;
}

const registrations = new Set<StorageWatcherRegistration>();
let unsubscribeProfile: (() => void) | null = null;
let suppressionDepth = 0;

export function watchUserStorage(onDirty: UserStorageListener): () => void {
  const registration = { onDirty };
  registrations.add(registration);

  if (registrations.size === 1) {
    unsubscribeProfile = profileStorage.subscribe(notifyUserStorageWrite);
  }

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    registrations.delete(registration);
    if (registrations.size > 0) return;

    unsubscribeProfile?.();
    unsubscribeProfile = null;
  };
}

function notifyUserStorageWrite({ key, origin }: ProfileChange): void {
  if (suppressionDepth > 0 || !isUserOwnedStorageKey(key)) return;

  registrations.forEach(({ onDirty }) => {
    onDirty(key, origin);
  });
}

/**
 * Suppress dirty notifications while applying a remote snapshot — `applyBackup`
 * writes the user-owned keys, which would otherwise re-mark the profile dirty
 * and schedule a redundant push of data we just pulled. Depth-counted so a
 * nested scope cannot un-suppress its caller.
 */
export function withStorageWatchSuppressed(fn: () => void): void {
  suppressionDepth += 1;
  try {
    fn();
  } finally {
    suppressionDepth -= 1;
  }
}
