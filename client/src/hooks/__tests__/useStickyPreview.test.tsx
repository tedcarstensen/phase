import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useStickyPreview } from "../useStickyPreview.ts";
import { useUiStore } from "../../stores/uiStore.ts";

const SRC_ROOT = resolve(process.cwd(), "src");
/** The one place allowed to pin the preview — everything else routes through it. */
const AUTHORITY = join(SRC_ROOT, "hooks", "useStickyPreview.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === "__tests__" ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(path) ? [path] : [];
  });
}

describe("useStickyPreview", () => {
  afterEach(() => {
    cleanup();
    useUiStore.setState({ inspectedObjectId: null, previewSticky: false });
  });

  it("opens the preview immediately and pins it", () => {
    const { result } = renderHook(() => useStickyPreview());

    act(() => result.current(42));

    // "immediate" means the store applies the inspect synchronously rather than
    // scheduling it behind `cardPreviewHoverDelayMs`.
    expect(useUiStore.getState().inspectedObjectId).toBe(42);
    expect(useUiStore.getState().previewSticky).toBe(true);
  });

  it("passes the caller's placement through", () => {
    const { result } = renderHook(() => useStickyPreview());

    act(() => result.current(7, "side"));

    expect(useUiStore.getState().previewPlacement).toBe("side");
  });

  /**
   * The long-press preview used to be re-derived at six call sites (board, hand
   * fan, hand wings, mobile drawer, hand scrub, stack), and half of them had
   * silently dropped the `"immediate"` timing — which is what made the gesture
   * feel inconsistent from surface to surface. Keep the pairing in one place.
   */
  it("is the only writer that pins the preview on", () => {
    const offenders = sourceFiles(SRC_ROOT)
      .filter((file) => file !== AUTHORITY)
      .filter((file) => readFileSync(file, "utf8").includes("setPreviewSticky(true)"))
      .map((file) => relative(SRC_ROOT, file).split(sep).join("/"));

    expect(offenders).toEqual([]);
  });
});
