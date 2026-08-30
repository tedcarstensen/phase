import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The profile store is only the single authority for the user's decks,
 * preferences, and feed state if nothing else touches those keys directly.
 * A stray `localStorage.setItem(STORAGE_KEY_PREFIX + name, ...)` would write
 * to a store the app no longer reads: the deck would vanish on reload and
 * cloud sync would never see the change, because the storage watcher observes
 * profile-store notifications rather than `Storage.prototype`.
 *
 * That failure is silent, so guard it here rather than by review.
 */
const PROFILE_KEY_TOKENS = [
  "STORAGE_KEY_PREFIX",
  "ACTIVE_DECK_KEY",
  "DECK_METADATA_KEY",
  "DECK_FOLDERS_KEY",
  "FEED_SUBSCRIPTIONS_KEY",
  "FEED_DECK_ORIGINS_KEY",
  "PREFERENCES_KEY",
  "DRAFT_WORKSPACE_PREFERENCES_KEY",
];

/**
 * The profile store itself, and the key vocabulary it migrates from, must
 * name both `localStorage` and the profile keys — that is their job.
 */
const ALLOWED = [
  "src/services/profileStorage/",
  "src/constants/profileKeys.ts",
];

describe("profile keys are only reached through the profile store", () => {
  it("has no source file writing profile keys straight to localStorage", () => {
    const root = path.resolve(__dirname, "../../../..");
    const files = readdirSync(path.join(root, "src"), {
      recursive: true,
      encoding: "utf8",
    })
      .map((entry) => path.posix.join("src", entry.split(path.sep).join("/")))
      .filter(
        (file) =>
          /\.tsx?$/.test(file) &&
          !file.includes("/__tests__/") &&
          !/\.test\.tsx?$/.test(file) &&
          !file.startsWith("src/wasm/"),
      );

    // A sanity floor: an empty sweep would make this test vacuously green.
    expect(files.length).toBeGreaterThan(100);

    const offenders = files.filter((file) => {
      if (ALLOWED.some((allowed) => file.startsWith(allowed))) return false;
      const source = readFileSync(path.join(root, file), "utf8");
      // Comments legitimately mention localStorage (migration notes, history).
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      if (!/localStorage\s*\.\s*(get|set|remove)Item/.test(code)) return false;
      return PROFILE_KEY_TOKENS.some((token) => code.includes(token));
    });

    expect(offenders).toEqual([]);
  });
});
