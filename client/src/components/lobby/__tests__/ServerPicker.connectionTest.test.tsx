import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ServerPicker } from "../ServerPicker";

/** Stand-in for the probe socket. `close()` raises an `error` event, which is
 *  what a real browser does when the socket is closed with the server's
 *  unsolicited `ServerHello` still in flight — the race that flipped a healthy
 *  server's indicator from green to red. */
class RaceyWebSocket {
  static last: RaceyWebSocket | null = null;

  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public readonly url: string) {
    RaceyWebSocket.last = this;
  }

  close(): void {
    this.closed = true;
    this.onerror?.();
  }
}

const originalWebSocket = globalThis.WebSocket;

function openPickerAndTest(url = "wss://self-hosted.example/ws"): void {
  render(<ServerPicker onClose={vi.fn()} onApply={vi.fn()} />);
  fireEvent.change(
    screen.getByPlaceholderText("wss://your-server.example/ws"),
    { target: { value: url } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Test" }));
}

describe("ServerPicker connection test", () => {
  beforeEach(() => {
    RaceyWebSocket.last = null;
    globalThis.WebSocket = RaceyWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    cleanup();
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  it("stays green when closing the probe socket raises an error event", () => {
    openPickerAndTest();

    const socket = RaceyWebSocket.last;
    expect(socket).not.toBeNull();

    act(() => socket!.onopen?.());

    expect(socket!.closed).toBe(true);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText("Connection failed")).not.toBeInTheDocument();
  });

  it("does not fail the probe from the timeout it already cleared", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    openPickerAndTest();

    act(() => RaceyWebSocket.last!.onopen?.());
    act(() => vi.advanceTimersByTime(5000));

    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText("Connection failed")).not.toBeInTheDocument();
  });

  it("reports a genuine connection failure", () => {
    openPickerAndTest();

    act(() => RaceyWebSocket.last!.onerror?.());

    expect(screen.getByText("Connection failed")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });
});
