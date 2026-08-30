import { useCallback } from "react";

import { useUiStore } from "../stores/uiStore.ts";
import type { PreviewPlacement } from "../stores/uiStore.ts";
import type { ObjectId } from "../adapter/types.ts";

/**
 * The single authority for "open this card's preview and pin it" — what every
 * long-press gesture in the game resolves to.
 *
 * Callers own the *gesture* (a per-card `useLongPress`, or the one shared timer
 * in `useInspectHoverProps`); this owns what the gesture *does*, so the two
 * halves of that behaviour cannot drift apart per surface. They had: the board,
 * the hand and the stack each re-derived it, and three of the four call sites
 * had dropped the `"immediate"` argument — leaving a long press on a hand card
 * or a stack entry waiting out `cardPreviewHoverDelayMs` on any device that
 * reports `(hover: hover)` while being touched (hybrid tablets, and the
 * remote-desktop hosts `useCardHover` already documents), while the identical
 * gesture on a permanent showed instantly.
 *
 * A long press is explicit intent — the hold has already outlasted the timer —
 * so it always bypasses hover latency, and setting sticky synchronously with
 * the inspect avoids orphaning `previewSticky` on a preview that never opened.
 */
export function useStickyPreview() {
  const inspectObject = useUiStore((s) => s.inspectObject);
  const setPreviewSticky = useUiStore((s) => s.setPreviewSticky);

  return useCallback(
    (objectId: ObjectId, placement: PreviewPlacement = "cursor") => {
      inspectObject(objectId, undefined, "immediate", placement);
      setPreviewSticky(true);
    },
    [inspectObject, setPreviewSticky],
  );
}
