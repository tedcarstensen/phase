import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { HandBadge } from "../../hand/HandBadge.tsx";
import { FullControlToggle } from "../../controls/FullControlToggle.tsx";
import { MobilePhaseChip } from "../../controls/MobilePhaseChip.tsx";
import { gameButtonClass } from "../buttonStyles.ts";
import { useGameStore } from "../../../stores/gameStore.ts";
import { usePreferencesStore } from "../../../stores/preferencesStore.ts";
import {
  buildGameState,
  buildPlayers,
} from "../../../test/factories/gameStateFactory.ts";

// `import.meta.url` is an http URL under the jsdom environment, so resolve from
// vitest's root (the `client/` package) instead.
const INDEX_CSS = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

/**
 * jsdom applies no stylesheet, so the contract is asserted in two halves: that
 * `index.css` still declares the 44px floor, and that the controls a player taps
 * during a match still opt into it. Between them, a regression on either side
 * fails here rather than on someone's phone.
 */
describe("touch target floor", () => {
  beforeEach(() => {
    useGameStore.setState({
      gameState: buildGameState({
        players: buildPlayers([{ id: 0, hand: [101, 102] }, { id: 1 }]),
      }),
    });
    usePreferencesStore.setState({ phaseStops: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it("declares both primitives at 44px, gated on a coarse pointer", () => {
    const start = INDEX_CSS.indexOf("@media (pointer: coarse) {");
    expect(start).toBeGreaterThan(-1);
    const coarseBlock = INDEX_CSS.slice(start, INDEX_CSS.indexOf("\n}\n", start));

    expect(coarseBlock).toContain(".touch-target {");
    expect(coarseBlock).toContain("min-height: 44px");
    expect(coarseBlock).toContain("min-width: 44px");
    // The halo's floor must be an absolute 44px, never derived from a
    // percentage inset — see the padding-box note in index.css.
    expect(coarseBlock).toContain("width: max(100%, 44px)");
    expect(coarseBlock).toContain("height: max(100%, 44px)");
  });

  it("applies the floor to every game button size", () => {
    for (const size of ["xs", "sm", "md", "lg"] as const) {
      expect(gameButtonClass({ tone: "neutral", size })).toContain("touch-target");
    }
  });

  it("applies the floor to the mobile action rail chips", () => {
    render(
      <>
        <MobilePhaseChip />
        <HandBadge />
        <FullControlToggle />
      </>,
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.className).toContain("touch-target");
    }
  });
});
