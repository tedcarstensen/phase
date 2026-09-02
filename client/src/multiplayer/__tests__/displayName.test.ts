import { describe, expect, it } from "vitest";

import {
  DEFAULT_DISPLAY_NAME,
  optionalDisplayName,
  requiredDisplayName,
} from "../displayName";

describe("requiredDisplayName", () => {
  it("keeps a name the broker would accept", () => {
    expect(requiredDisplayName("Ted")).toBe("Ted");
  });

  it("trims surrounding whitespace", () => {
    expect(requiredDisplayName("  Ted  ")).toBe("Ted");
  });

  it.each(["", "   ", "\t\n", null, undefined])(
    "substitutes the default for a blank name: %j",
    (name) => {
      expect(requiredDisplayName(name)).toBe(DEFAULT_DISPLAY_NAME);
    },
  );

  it("uses the caller's seat-appropriate fallback when given one", () => {
    expect(requiredDisplayName("", "Host")).toBe("Host");
    expect(requiredDisplayName("   ", "Host")).toBe("Host");
    expect(requiredDisplayName("Ted", "Host")).toBe("Ted");
  });
});

describe("optionalDisplayName", () => {
  it("keeps a trimmed name", () => {
    expect(optionalDisplayName("  Ted  ")).toBe("Ted");
  });

  it.each(["", "   ", null, undefined])(
    "collapses a blank name to absent: %j",
    (name) => {
      expect(optionalDisplayName(name)).toBeUndefined();
    },
  );
});
