import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useGameStore } from "../../../stores/gameStore.ts";
import { buildGameState, buildPlayer } from "../../../test/factories/gameStateFactory.ts";
import { PlayerArea } from "../PlayerArea.tsx";

vi.mock("../../../hooks/useCardImage", () => ({
  useCardImage: () => ({ src: null, isLoading: false }),
}));

const INDEX_CSS = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

function portraitBlock(): string {
  const start = INDEX_CSS.indexOf("@media (width < 64rem) and (orientation: portrait) {");
  expect(start).toBeGreaterThan(-1);
  const end = INDEX_CSS.indexOf("\n}\n", start);
  return INDEX_CSS.slice(start, end);
}

/**
 * The reported bug: on a portrait phone the zone-pile rail sat on top of the
 * land column. The rail is lifted clear of the fanned hand, and the lift used to
 * be a per-viewport constant that exceeded the hand row's whole height — so the
 * rail escaped its row by an unbounded amount and landed on the battlefield.
 * The fix is structural, and both halves are asserted here because jsdom applies
 * no stylesheet: derive the lift from the row it has to clear, and reserve the
 * gutter the rail occupies instead of overlaying it.
 */
describe("mobile portrait zone-pile rail", () => {
  beforeEach(() => {
    useGameStore.setState({
      gameState: buildGameState({
        players: [buildPlayer({ id: 0 }), buildPlayer({ id: 1 })],
      }),
      legalActions: [],
      spellCosts: {},
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("derives the pile lift instead of restating it as a constant", () => {
    const block = portraitBlock();

    // `top: auto` is load-bearing: with Tailwind's `inset-y-0` still supplying
    // `top: 0`, the box is over-constrained and resolves to zero height, so its
    // contents overflow upward without bound.
    expect(block).toMatch(/\[data-flex-zone="playerPiles"\]\s*\{\s*top:\s*auto\s*!important;/);
    for (const term of [
      "--game-mobile-player-row-h",
      "--game-mobile-hand-lift",
      "--game-mobile-hand-arc",
    ]) {
      expect(block).toContain(term);
    }
    // The old hand-tuned constants are gone from the whole sheet.
    expect(INDEX_CSS).not.toContain("--game-mobile-pile-lift");
  });

  it("reserves the gutter the rail occupies", () => {
    expect(portraitBlock()).toMatch(
      /\[data-player-area-gutter\]\s*\{\s*padding-left:\s*var\(--game-mobile-pile-gutter\);/,
    );
  });

  it("marks full-width battlefields as owing the gutter", () => {
    for (const mode of ["full", "focused"] as const) {
      const { container, unmount } = render(<PlayerArea playerId={0} mode={mode} />);
      expect(container.querySelector("[data-player-area-gutter]")).not.toBeNull();
      unmount();
    }
  });

  it("exempts split-overview seat panes, which the rail never reaches across", () => {
    const { container } = render(
      <PlayerArea playerId={0} mode="focused" splitOverview />,
    );

    expect(container.querySelector("[data-player-area-gutter]")).toBeNull();
  });
});
