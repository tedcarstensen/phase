import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCardImage } from "../../../hooks/useCardImage.ts";
import { CardImage } from "../CardImage.tsx";

vi.mock("../../../hooks/useCardImage.ts", () => ({
  useCardBackImage: vi.fn(() => ({ src: "card-back.png", isLoading: false })),
  useCardImage: vi.fn(() => ({ src: null, isLoading: true, isRotated: false, isFlip: false })),
}));

vi.mock("../../../hooks/useEngineCardData.ts", () => ({
  useEngineCardData: vi.fn(() => null),
}));

const mockUseCardImage = vi.mocked(useCardImage);
const INDEX_CSS = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * The choice-overlay and zone-viewer strips size their cards from a CSS rule,
 * and that rule used to select `[role="img"]` — true of the card element only
 * while it was a background-image div. Once it became a real `<img>`, every card
 * whose art resolved silently fell back to the tiny battlefield card size, and a
 * later pass that raised the strip height changed a number nothing read. The
 * class below is the component's own contract with that rule.
 */
describe("card face sizing hook", () => {
  const branches = [
    { name: "loading pulse", value: { src: null, isLoading: true } },
    { name: "art fallback", value: { src: null, isLoading: false } },
    { name: "resolved art", value: { src: "art.png", isLoading: false } },
  ] as const;

  for (const branch of branches) {
    it(`stamps card-face on the ${branch.name}`, () => {
      mockUseCardImage.mockReturnValue({
        ...branch.value,
        isRotated: false,
        isFlip: false,
      });

      const { container } = render(<CardImage cardName="Grizzly Bears" />);

      expect(container.querySelector(".card-face")).not.toBeNull();
    });
  }

  it("stamps card-face on the card back", () => {
    mockUseCardImage.mockReturnValue({
      src: null,
      isLoading: false,
      isRotated: false,
      isFlip: false,
    });

    const { container } = render(<CardImage cardName="Grizzly Bears" faceDown />);

    expect(container.querySelector(".card-face")).not.toBeNull();
  });

  it("sizes both strips from the shared hand-view scale via that class", () => {
    const start = INDEX_CSS.indexOf(".zone-viewer-strip .card-face");
    expect(start).toBeGreaterThan(-1);
    const rule = INDEX_CSS.slice(start, INDEX_CSS.indexOf("}", start));

    expect(rule).toContain(".card-choice-strip .card-face");
    expect(rule).toContain("--strip-card-h: var(--hand-view-card-h)");
  });

  it("defines the hand-view scale once, capped so a phone shows more than one card", () => {
    expect(INDEX_CSS).toContain(
      "--hand-view-card-h: min(clamp(200px, 40vh, 360px), 87vw, 52vh)",
    );
    expect(INDEX_CSS).toContain("--hand-view-card-w: calc(var(--hand-view-card-h) * 5 / 7)");

    // The mulligan prompts must read that token rather than restating it — the
    // duplicated literals they used to carry are what let the two surfaces drift.
    const gamePage = readFileSync(resolve(process.cwd(), "src/pages/GamePage.tsx"), "utf8");
    expect(gamePage).not.toContain("clamp(200px,40vh,360px)");
    expect(gamePage).not.toContain("clamp(143px,28.6vh,257px)");
    expect(gamePage).toContain("var(--hand-view-card-h)");
  });
});
