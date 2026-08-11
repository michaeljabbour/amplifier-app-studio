// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  configuredBridgeToken,
  configuredBridgeUrl,
  launchSession,
  saveBridgeToken,
  saveBridgeUrl,
  stopSession,
} from "./transport";

describe("bridge trust storage", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("sessionStorage", memoryStorage());
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("uses a bridge query for the page without persisting it", () => {
    window.history.replaceState({}, "", "/?bridge=http://127.0.0.1:9443");

    expect(configuredBridgeUrl()).toBe("http://127.0.0.1:9443");
    expect(localStorage.getItem("amplifier-studio.bridge-url")).toBeNull();
  });

  it("persists a bridge only through explicit save and removes the query", () => {
    window.history.replaceState({}, "", "/?bridge=http://127.0.0.1:9443");
    saveBridgeUrl("http://127.0.0.1:9555");

    expect(window.location.search).toBe("");
    expect(configuredBridgeUrl()).toBe("http://127.0.0.1:9555");
  });

  it("binds a session token to the explicitly trusted bridge", () => {
    const token = "0123456789abcdef0123456789abcdef";
    saveBridgeUrl("http://127.0.0.1:9555");
    saveBridgeToken(token, "http://127.0.0.1:9555");
    expect(configuredBridgeToken()).toBe(token);

    window.history.replaceState({}, "", "/?bridge=http://127.0.0.1:9666");
    expect(configuredBridgeToken()).toBe("");
  });

  it("reconnects from a durable cursor and deduplicates replay by event id", async () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    class TestWebSocket extends FakeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    }
    vi.stubGlobal("WebSocket", TestWebSocket);
    saveBridgeUrl("http://127.0.0.1:9555");
    saveBridgeToken("0123456789abcdef0123456789abcdef");
    const onRecord = vi.fn();
    const pending = launchSession(
      { guiId: "gui-one", projectDir: "/project" },
      { onRecord, onLog: vi.fn(), onExit: vi.fn() },
    );

    sockets[0].open();
    expect(sockets[0].messages()).toEqual([
      expect.objectContaining({ type: "start" }),
    ]);
    sockets[0].message({ type: "ready", guiId: "gui-one", attached: false });
    const connection = await pending;
    sockets[0].message(eventEnvelope("already-seen", 50));
    expect(runtimeEventIds(onRecord)).toEqual(["already-seen"]);

    sockets[0].disconnect();
    await vi.advanceTimersByTimeAsync(300);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(sockets[1].messages()).toEqual([{ type: "attach", since: 0 }]);
    sockets[1].message({ type: "ready", guiId: "gui-one", attached: true, since: 0 });

    // A live event may arrive after attachment but before history.begin. It is
    // buffered, then suppressed when the same durable id appears in replay.
    sockets[1].message(eventEnvelope("at-boundary", 80));
    sockets[1].message(recordEnvelope({ schema_version: 1, type: "history.begin", since: 0 }));
    sockets[1].message(eventEnvelope("already-seen", 1, true));
    sockets[1].message(eventEnvelope("missed", 2, true));
    sockets[1].message(eventEnvelope("at-boundary", 3, true));
    sockets[1].message(recordEnvelope({ schema_version: 1, type: "history.end", cursor: 3 }));
    expect(runtimeEventIds(onRecord)).toEqual(["already-seen", "missed", "at-boundary"]);

    sockets[1].message(eventEnvelope("after-cursor", 999));
    sockets[1].disconnect();
    await vi.advanceTimersByTimeAsync(300);
    sockets[2].open();
    expect(sockets[2].messages()).toEqual([{ type: "attach", since: 3 }]);

    connection.dispose();
    vi.useRealTimers();
  });

  it("waits for runtime exit before confirming a remote stop", async () => {
    const sockets: FakeWebSocket[] = [];
    class TestWebSocket extends FakeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    }
    vi.stubGlobal("WebSocket", TestWebSocket);
    saveBridgeUrl("http://127.0.0.1:9555");
    saveBridgeToken("0123456789abcdef0123456789abcdef");
    const pending = launchSession(
      { guiId: "gui-stop", projectDir: "/project" },
      { onRecord: vi.fn(), onLog: vi.fn(), onExit: vi.fn() },
    );
    sockets[0].open();
    sockets[0].message({ type: "ready", guiId: "gui-stop", attached: false });
    const connection = await pending;

    let confirmed = false;
    const stopping = stopSession("gui-stop").then((value) => {
      confirmed = true;
      return value;
    });
    expect(sockets[0].messages().at(-1)).toEqual({ type: "stop" });
    await Promise.resolve();
    expect(confirmed).toBe(false);

    sockets[0].message({
      type: "event",
      channel: "exit",
      payload: { code: 0, message: "Session closed cleanly" },
    });
    await expect(stopping).resolves.toBe(true);
    connection.dispose();
  });
});

function recordEnvelope(payload: Record<string, unknown>): Record<string, unknown> {
  return { type: "event", channel: "record", payload };
}

function eventEnvelope(eventId: string, sequence: number, replay = false): Record<string, unknown> {
  return recordEnvelope({
    schema_version: 1,
    type: "runtime.event",
    sequence,
    replay,
    event: {
      event_id: eventId,
      session_id: "runtime-one",
      parent_id: null,
      ts: "2026-08-11T00:00:00Z",
      kind: "notification",
      message: eventId,
    },
  });
}

function runtimeEventIds(spy: ReturnType<typeof vi.fn>): string[] {
  return spy.mock.calls
    .map(([record]) => record)
    .filter((record) => record?.type === "runtime.event")
    .map((record) => record.event.event_id as string);
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly sent: string[] = [];
  readyState = 0;
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  constructor(
    readonly url: string | URL,
    readonly protocols?: string | string[],
  ) {}

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  message(value: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(value) });
  }

  disconnect(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  messages(): Record<string, unknown>[] {
    return this.sent.map((value) => JSON.parse(value) as Record<string, unknown>);
  }

  private emit(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}
