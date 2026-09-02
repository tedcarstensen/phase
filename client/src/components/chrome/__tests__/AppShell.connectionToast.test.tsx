import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";

import { AppShell } from "../AppShell";
import { useMultiplayerStore } from "../../../stores/multiplayerStore";

vi.mock("../../../hooks/useChangelog", () => ({
  useChangelog: () => ({
    hasUnread: false,
    entries: [],
    loading: false,
    failed: false,
    openAndLoad: vi.fn(),
  }),
}));
vi.mock("../../menu/MenuParticles", () => ({ SceneParticles: () => null }));
vi.mock("../../modal/WhatsNewModal", () => ({ WhatsNewModal: () => null }));
vi.mock("../../settings/visual-packs/VisualPackManager.tsx", () => ({
  VisualPackManager: () => null,
}));
vi.mock("../AccountControl", () => ({ AccountControl: () => null }));
vi.mock("../BuildBadge", () => ({ BuildBadge: () => null }));
vi.mock("../CardDataLoadingBar", () => ({ CardDataLoadingBar: () => null }));
vi.mock("../FullscreenButton", () => ({ FullscreenButton: () => null }));
vi.mock("../SocialBar", () => ({ SocialBar: () => null }));
vi.mock("../StatusBanner", () => ({ StatusBanner: () => null }));
vi.mock("../TabBar", () => ({ TabBar: () => null }));
vi.mock("../VolumeControl", () => ({ VolumeControl: () => null }));

/** Render the shell on the home route — the surface `startHosting` navigates
 *  to before the server's answer to `CreateGameWithSettings` comes back. */
function renderShellAtHome() {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<div>Home</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("AppShell connection toast surface", () => {
  afterEach(() => {
    cleanup();
    act(() => useMultiplayerStore.getState().clearToast());
  });

  // Regression: hosting rejections are raised by the module-level host socket
  // after the lobby page has already navigated home and unmounted. When the
  // toast surface was page-owned, every server-side rejection — including
  // "display_name must not be empty" — was silent.
  it("renders a multiplayer toast raised while the home route is showing", () => {
    renderShellAtHome();

    act(() => {
      useMultiplayerStore.getState().showToast("display_name must not be empty");
    });

    expect(
      screen.getByText("display_name must not be empty"),
    ).toBeInTheDocument();
  });

  it("renders exactly one banner per toast", () => {
    renderShellAtHome();

    act(() => {
      useMultiplayerStore.getState().showToast("Failed to create game.");
    });

    expect(screen.getAllByText("Failed to create game.")).toHaveLength(1);
  });
});
