import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GameObject } from "../../../adapter/types.ts";
import { useGameStore } from "../../../stores/gameStore.ts";
import { useUiStore } from "../../../stores/uiStore.ts";
import {
  buildGameObjectWithCoreTypes,
  buildObjectMap,
} from "../../../test/factories/gameObjectFactory.ts";
import { buildGameState, buildPlayers } from "../../../test/factories/gameStateFactory.ts";
import { GraveyardPile } from "../GraveyardPile.tsx";

vi.mock("../../../hooks/useCardImage", () => ({
  useCardBackImage: () => ({ src: "/test-card-back.png", isLoading: false }),
  useCardImage: () => ({ src: null, isLoading: false }),
}));

const TOP_ID = 42;

function topCard(): GameObject {
  return buildGameObjectWithCoreTypes(["Creature"], {
    id: TOP_ID,
    card_id: TOP_ID,
    zone: "Graveyard",
    name: "Grizzly Bears",
    timestamp: 1,
    entered_battlefield_turn: null,
  });
}

/**
 * The pile shows a card face, so it owes the same gesture its sibling
 * LibraryPile already answered — this is the surface the "sometimes you can tap
 * and hold to look at a card and others you can't" report pointed at.
 */
describe("GraveyardPile card preview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useGameStore.setState({
      gameState: buildGameState({
        objects: buildObjectMap(topCard()),
        players: buildPlayers([{ id: 0, graveyard: [TOP_ID] }, { id: 1 }]),
      }),
    });
    useUiStore.setState({ inspectedObjectId: null, previewSticky: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("previews the top card on a touch long press", () => {
    render(<GraveyardPile playerId={0} onClick={vi.fn()} />);
    const pile = screen.getByRole("button");

    fireEvent.pointerDown(pile, {
      button: 0,
      clientX: 10,
      clientY: 10,
      isPrimary: true,
      pointerId: 1,
      pointerType: "touch",
    });
    act(() => vi.advanceTimersByTime(500));

    expect(useUiStore.getState().inspectedObjectId).toBe(TOP_ID);
    expect(useUiStore.getState().previewSticky).toBe(true);
  });

  it("previews the top card on mouse hover", () => {
    render(<GraveyardPile playerId={0} onClick={vi.fn()} />);

    fireEvent.pointerEnter(screen.getByRole("button"), { pointerType: "mouse" });

    expect(useUiStore.getState().inspectedObjectId).toBe(TOP_ID);
  });

  it("does not open the zone viewer on the click that ends a long press", () => {
    const onClick = vi.fn();
    render(<GraveyardPile playerId={0} onClick={onClick} />);
    const pile = screen.getByRole("button");

    fireEvent.pointerDown(pile, {
      button: 0,
      clientX: 10,
      clientY: 10,
      isPrimary: true,
      pointerId: 1,
      pointerType: "touch",
    });
    act(() => vi.advanceTimersByTime(500));
    fireEvent.pointerUp(pile, { pointerId: 1, pointerType: "touch" });
    fireEvent.click(pile);

    expect(onClick).not.toHaveBeenCalled();
  });

  it("still opens the zone viewer on a plain tap", () => {
    const onClick = vi.fn();
    render(<GraveyardPile playerId={0} onClick={onClick} />);

    fireEvent.click(screen.getByRole("button"));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
