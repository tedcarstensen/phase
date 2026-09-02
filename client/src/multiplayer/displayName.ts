/**
 * Single authority for the player's outbound display name.
 *
 * The store default is `""` and the preferences field accepts whitespace, so
 * `state.displayName` is never safe to put on the wire directly. The lobby
 * broker validates every name-carrying frame with `validate_required_label`
 * (`crates/lobby-broker/src/validation.rs`), which trims before its empty
 * check and rejects the frame with `"display_name must not be empty"`. A
 * rejected `CreateGameWithSettings` means the player cannot host at all.
 *
 * The two helpers below mirror the broker's own required/optional label pair
 * so a call site picks the semantics it needs instead of inventing its own
 * fallback — four independent `|| "Host"` expressions is what let the
 * unguarded fifth one ship.
 */

/** Fallback label when the player has not chosen a display name. */
export const DEFAULT_DISPLAY_NAME = "Player";

/**
 * Resolve a name for a field the broker treats as a required label: the
 * result is never blank. `fallback` names the seat-appropriate stand-in
 * (e.g. `"Host"` when registering a room).
 */
export function requiredDisplayName(
  name: string | null | undefined,
  fallback: string = DEFAULT_DISPLAY_NAME,
): string {
  return name?.trim() || fallback;
}

/**
 * Resolve a name for a field the broker treats as an optional label: a blank
 * name collapses to `undefined` (absent) rather than to a stand-in, so the
 * receiver applies its own default.
 */
export function optionalDisplayName(
  name: string | null | undefined,
): string | undefined {
  return name?.trim() || undefined;
}
