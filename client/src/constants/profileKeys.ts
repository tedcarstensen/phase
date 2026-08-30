/**
 * Leaf module holding the storage keys that make up the user's *portable
 * profile* — decks, deck organization, preferences, and feed subscriptions.
 *
 * These live apart from `constants/storage.ts` (which re-exports them, so no
 * call site needs to know) because the durable profile store in
 * `services/profileStorage` needs the key vocabulary during boot, and
 * `constants/storage.ts` reaches into the deck parser. Keeping the vocabulary
 * in a dependency-free leaf breaks that cycle.
 */

/** Prefix for saved deck data. Full key: `${STORAGE_KEY_PREFIX}${deckName}` */
export const STORAGE_KEY_PREFIX = "phase-deck:";

/** Key for the currently selected/active deck name */
export const ACTIVE_DECK_KEY = "phase-active-deck";

/** Key for deck metadata (timestamps, source tracking, folder/star) */
export const DECK_METADATA_KEY = "phase-deck-metadata";

/** Key for the user's deck-folder registry (an array of `DeckFolder`). */
export const DECK_FOLDERS_KEY = "phase-deck-folders";

/** Key for the list of subscribed feeds */
export const FEED_SUBSCRIPTIONS_KEY = "phase-feed-subscriptions";

/** Key for mapping deck names to their originating feed ID */
export const FEED_DECK_ORIGINS_KEY = "phase-feed-deck-origins";

/** Key for the Zustand-persisted preferences store. */
export const PREFERENCES_KEY = "phase-preferences";

/** Key for personal draft workspace preferences. */
export const DRAFT_WORKSPACE_PREFERENCES_KEY = "phase-draft-workspace-preferences";

/**
 * Single authority for "is this key part of the user's portable profile?" —
 * the decks, preferences, metadata, active-deck pointer, and feed state that
 * `buildBackup`/`applyBackup` round-trip, that cloud sync mirrors, and that
 * the durable profile store owns.
 *
 * Deliberately excludes transient/rehydratable keys (per-game state, draft
 * blobs, caches): those regenerate at runtime, must NOT trigger a cloud push,
 * and stay in their own IndexedDB stores. Consumed by `backup.ts`
 * (export/import), the cloud-sync storage watcher, and the profile store's
 * legacy-localStorage migration so all of them share one definition and
 * cannot drift.
 */
export function isUserOwnedStorageKey(key: string): boolean {
  return (
    key === PREFERENCES_KEY ||
    key === DRAFT_WORKSPACE_PREFERENCES_KEY ||
    key === DECK_METADATA_KEY ||
    key === DECK_FOLDERS_KEY ||
    key === ACTIVE_DECK_KEY ||
    key === FEED_SUBSCRIPTIONS_KEY ||
    key === FEED_DECK_ORIGINS_KEY ||
    key.startsWith(STORAGE_KEY_PREFIX)
  );
}
