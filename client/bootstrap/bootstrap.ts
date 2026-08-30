import { invoke } from "@tauri-apps/api/core";

import { isUserOwnedStorageKey } from "../src/constants/storage";
import { buildBackup } from "../src/services/backup";
import { getSupabaseSessionKey } from "../src/services/cloudSync/sessionKey";
import { hydrateProfileStorage, profileStorage } from "../src/services/profileStorage";
import "./bootstrap.css";

declare const __SHELL_REMOTE_ORIGIN__: string;
declare const __SHELL_PREVIEW_ORIGIN__: string;

type Channel = "release" | "preview";

interface LegacyStorageResult {
  remote_load_ok: boolean;
  channel: Channel;
}

const status = document.querySelector<HTMLParagraphElement>("#status");
const retry = document.querySelector<HTMLButtonElement>("#retry");

if (!status || !retry) {
  throw new Error("Bootstrap page is missing its status controls.");
}

function hasLegacyStorage(sessionKey: string | null): boolean {
  if (profileStorage.keys().some(isUserOwnedStorageKey)) return true;
  // The Supabase auth session is not part of the portable profile and stays
  // in localStorage, where supabase-js put it.
  return sessionKey !== null && localStorage.getItem(sessionKey) !== null;
}

/**
 * Snapshot the bundled origin's profile for the shell to hand to the remote
 * origin. Hydrating first is what makes this see the whole profile: on a
 * bundled build that has already run, the decks are in IndexedDB, and
 * `buildBackup` reads the profile store rather than localStorage directly.
 */
async function legacyStashJson(): Promise<string> {
  await hydrateProfileStorage();
  const sessionKey = getSupabaseSessionKey();
  if (!hasLegacyStorage(sessionKey)) return "";

  return JSON.stringify({
    backup: buildBackup(),
    supabaseSession: sessionKey ? localStorage.getItem(sessionKey) : null,
  });
}

function channelUrl(channel: Channel): string {
  return channel === "preview" ? __SHELL_PREVIEW_ORIGIN__ : __SHELL_REMOTE_ORIGIN__;
}

async function stashLegacyStorage(): Promise<LegacyStorageResult> {
  try {
    return await invoke<LegacyStorageResult>("stash_legacy_storage", {
      json: await legacyStashJson(),
    });
  } catch {
    return { remote_load_ok: false, channel: "release" };
  }
}

async function navigateToChannel(): Promise<void> {
  retry.hidden = true;
  status.textContent = "Connecting…";
  const { remote_load_ok: remoteLoadOk, channel } = await stashLegacyStorage();
  const destination = channelUrl(channel);

  if (remoteLoadOk) {
    location.replace(destination);
    return;
  }

  try {
    await fetch(destination, { mode: "no-cors", cache: "no-store" });
    location.replace(destination);
  } catch {
    status.textContent = "Unable to connect.";
    retry.hidden = false;
  }
}

retry.addEventListener("click", () => {
  void navigateToChannel();
});

void navigateToChannel();
