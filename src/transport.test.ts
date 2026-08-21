// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  configuredBridgeToken,
  configuredBridgeUrl,
  cloneGithubRepository,
  durableRuntimeHostForSession,
  launchSession,
  loadOutputPreview,
  listRuntimeHosts,
  probeRuntimeHost,
  prepareSessionLaunch,
  readRuntimeSettings,
  removeRuntimeHost,
  resetReplayDedupe,
  runtimeHostId,
  saveBridgeToken,
  saveBridgeUrl,
  saveRuntimeHost,
  stopSession,
  storeRuntimeHostToken,
} from "./transport";

describe("bridge trust storage", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
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

  it("preflights an unowned remote bridge before a dead tab is created", async () => {
    saveBridgeUrl("http://127.0.0.1:9555");

    await expect(prepareSessionLaunch({
      projectDir: "/remote/project",
      hostUrl: "http://127.0.0.1:9555",
    })).rejects.toThrow("Enter the Rust bridge bearer token");

    saveBridgeToken("0123456789abcdef0123456789abcdef", "http://127.0.0.1:9555");
    await expect(prepareSessionLaunch({
      projectDir: "/remote/project",
      hostUrl: "http://127.0.0.1:9555",
    })).resolves.toBeUndefined();
  });

  it("persists proven mobile host metadata without invoking desktop-only storage", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("iPhone");
    const url = "https://spark-288f.example.test";
    const token = "0123456789abcdef0123456789abcdef";
    const host = {
      id: runtimeHostId(`${url}/`),
      name: "Compute · spark-288f.example.test",
      url,
      tokenRef: `keychain:${runtimeHostId(`${url}/`)}`,
      defaultProjectRoot: "/home/mjabbour/dev",
    };

    saveBridgeToken(token, url);
    await expect(saveRuntimeHost(host)).resolves.toEqual([
      { ...host, url: `${url}/`, tokenRef: "session" },
    ]);
    await expect(storeRuntimeHostToken(host.id, token)).resolves.toBeUndefined();
    await expect(listRuntimeHosts()).resolves.toEqual([
      { ...host, url: `${url}/`, tokenRef: "session" },
    ]);
    expect(configuredBridgeUrl()).toBe(url);
    expect(configuredBridgeToken()).toBe(token);

    await expect(removeRuntimeHost(host.id)).resolves.toEqual([]);
    expect(configuredBridgeUrl()).toBe("");
    expect(configuredBridgeToken(url)).toBe("");
  });

  it("turns a proven remote session into a stable durable compute host", () => {
    const host = durableRuntimeHostForSession({
      projectDir: "/home/mjabbour/amplifier",
      hostId: "configured",
      hostName: "Configured host",
      hostUrl: "http://127.0.0.1:4318",
    }, []);
    expect(host).toEqual({
      id: runtimeHostId("http://127.0.0.1:4318/"),
      name: "Compute · 127.0.0.1:4318",
      url: "http://127.0.0.1:4318/",
      tokenRef: `keychain:${runtimeHostId("http://127.0.0.1:4318/")}`,
      defaultProjectRoot: "/home/mjabbour/amplifier",
    });
  });

  // Regression, reported from the field: a stored Spark session became unreachable at
  // http://127.0.0.1:4318. Host ids are derived from the URL, and these URLs are loopback ports
  // handed out by an SSH/Tailscale forward. When the forward returned on a different port the
  // URL no longer matched, a new host record and keychain entry were minted, and every session
  // pinned to the old id was orphaned with nothing in the UI able to re-point it.
  it("re-points an existing named host when its forward moves to a new port", () => {
    const hosts = [{
      id: "host-127.0.0.1-4318-dmtm1b",
      name: "Spark 288f",
      url: "http://127.0.0.1:4318/",
      tokenRef: "keychain:host-127.0.0.1-4318-dmtm1b",
      defaultProjectRoot: "/home/mjabbour/dev",
    }];

    const moved = durableRuntimeHostForSession(
      { projectDir: "/home/mjabbour/dev", hostId: "configured", hostName: "Spark 288f", hostUrl: "http://127.0.0.1:4322" },
      hosts,
    );

    // Same record, new address: the id and credential reference survive, so sessions pinned to
    // this host follow it instead of being stranded.
    expect(moved?.id).toBe("host-127.0.0.1-4318-dmtm1b");
    expect(moved?.tokenRef).toBe("keychain:host-127.0.0.1-4318-dmtm1b");
    expect(moved?.url).toBe("http://127.0.0.1:4322/");
    expect(moved?.name).toBe("Spark 288f");
  });

  it("never merges two computes that only share an auto-generated name", () => {
    const hosts = [{
      id: "host-127.0.0.1-4318-aaa",
      name: "Configured host",
      url: "http://127.0.0.1:4318/",
      tokenRef: "keychain:host-127.0.0.1-4318-aaa",
    }];

    const fresh = durableRuntimeHostForSession(
      { projectDir: "/home/mjabbour/dev", hostId: "configured", hostName: "Configured host", hostUrl: "http://127.0.0.1:4399" },
      hosts,
    );

    expect(fresh?.id).not.toBe("host-127.0.0.1-4318-aaa");
    expect(fresh?.url).toBe("http://127.0.0.1:4399/");
  });

  it("keeps a named host pinned to the host-configured project home", () => {
    const saved = {
      id: "spark-288f",
      name: "Spark 288f",
      url: "https://spark.example.test/",
      tokenRef: "env:SPARK_TOKEN",
      defaultProjectRoot: "/old",
    };
    expect(durableRuntimeHostForSession({
      projectDir: "/home/mjabbour/amplifier",
      hostId: saved.id,
      hostName: saved.name,
      hostUrl: saved.url,
    }, [saved], "/home/mjabbour/dev")).toEqual({ ...saved, defaultProjectRoot: "/home/mjabbour/dev" });
  });

  it("proves a remote runtime and discovers its default project root before saving", async () => {
    saveBridgeToken("0123456789abcdef0123456789abcdef", "http://127.0.0.1:4318");
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/runtime")) {
        return jsonResponse({
          installed: true,
          current: true,
          adapter: "neutral",
          installSupported: false,
          providerStatusAvailable: true,
          providerConfigured: true,
          providerMessage: "ready",
          message: "Amplifier Runtime is ready",
        });
      }
      return jsonResponse({
        defaultProjectDir: "/home/mjabbour/amplifier",
        capabilities: ["githubRepositoryClone"],
      });
    }));

    await expect(probeRuntimeHost("http://127.0.0.1:4318", "configured")).resolves.toEqual({
      status: expect.objectContaining({ installed: true, adapter: "neutral" }),
      defaultProjectDir: "/home/mjabbour/amplifier",
      capabilities: ["githubRepositoryClone"],
    });
  });

  it("clones on the explicitly selected remote compute", async () => {
    const bridge = "http://127.0.0.1:4319";
    saveBridgeToken("0123456789abcdef0123456789abcdef", bridge);
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => jsonResponse({
      path: "/home/mjabbour/dev/amplifier",
      repository: "microsoft/amplifier",
      request: init?.body,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(cloneGithubRepository(
      " https://github.com/microsoft/amplifier ",
      bridge,
      "spark-9602",
    )).resolves.toEqual(expect.objectContaining({
      path: "/home/mjabbour/dev/amplifier",
      repository: "microsoft/amplifier",
    }));

    const [requested, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(requested.origin).toBe(bridge);
    expect(requested.pathname).toBe("/v1/api/repositories/clone");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      repositoryUrl: "https://github.com/microsoft/amplifier",
    });
  });

  it("explains that an older remote host must be updated before cloning", async () => {
    const bridge = "http://127.0.0.1:4319";
    saveBridgeToken("0123456789abcdef0123456789abcdef", bridge);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "Not Found" }, 404)));

    await expect(cloneGithubRepository(
      "https://github.com/microsoft/amplifier",
      bridge,
      "spark-9602",
    )).rejects.toThrow("Update Amplifier Host");
  });

  it("reads settings from the explicitly selected host instead of the globally configured bridge", async () => {
    saveBridgeUrl("http://127.0.0.1:9555");
    saveBridgeToken("0123456789abcdef0123456789abcdef", "http://127.0.0.1:4319");
    const fetchMock = vi.fn(async (_input: URL | RequestInfo) => jsonResponse({
      projectDir: "/home/mjabbour/amplifier",
      values: [],
      version: "0.1.6",
      paths: {},
      recentChanges: [],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await readRuntimeSettings(
      "/home/mjabbour/amplifier",
      "http://127.0.0.1:4319",
      "spark-9602",
    );

    const requested = fetchMock.mock.calls[0]?.[0] as URL;
    expect(requested.origin).toBe("http://127.0.0.1:4319");
    expect(requested.pathname).toBe("/v1/api/runtime-settings");
    expect(requested.searchParams.get("projectDir")).toBe("/home/mjabbour/amplifier");
  });

  it("loads output previews from the session's owning host", async () => {
    saveBridgeUrl("http://127.0.0.1:9555");
    saveBridgeToken("0123456789abcdef0123456789abcdef", "http://127.0.0.1:4319");
    const fetchMock = vi.fn(async (_input: URL | RequestInfo) => jsonResponse({ mediaType: "image/png", data: "cG5n" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadOutputPreview(
      "/home/mjabbour/amplifier",
      ".git/amplifier-studio/outputs/result.png",
      "http://127.0.0.1:4319",
      "spark-9602",
    )).resolves.toEqual({ mediaType: "image/png", data: "cG5n" });

    const requested = fetchMock.mock.calls[0]?.[0] as URL;
    expect(requested.origin).toBe("http://127.0.0.1:4319");
    expect(requested.pathname).toBe("/v1/api/output-preview");
    expect(requested.searchParams.get("path")).toBe(".git/amplifier-studio/outputs/result.png");
  });

  it("turns a WebKit load failure into an actionable host connection error", async () => {
    saveBridgeToken("0123456789abcdef0123456789abcdef", "http://127.0.0.1:4318");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Load failed")));

    // The message names the origin and tells the user what to check, without echoing WebKit's
    // contentless "Load failed" and without asserting which link in the chain broke -- a
    // rejected fetch cannot distinguish a dead tunnel from a CORS rejection.
    const failure = (await probeRuntimeHost("http://127.0.0.1:4318", "configured").catch((error: unknown) => error)) as Error;
    expect(failure.message).toContain("http://127.0.0.1:4318");
    expect(failure.message).toMatch(/check that/i);
    expect(failure.message).not.toContain("Load failed");
    expect(failure.message).not.toMatch(/Could not reach/i);
    expect(failure.cause).toBeInstanceOf(TypeError);
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
    const onConnectionChange = vi.fn();
    const pending = launchSession(
      { guiId: "gui-one", projectDir: "/project" },
      { onRecord, onLog: vi.fn(), onExit: vi.fn(), onConnectionChange },
    );

    sockets[0].open();
    expect(sockets[0].messages()).toEqual([
      expect.objectContaining({ type: "start" }),
    ]);
    sockets[0].message({ type: "ready", guiId: "gui-one", attached: false });
    const connection = await pending;
    expect(onConnectionChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: "connected" }));
    sockets[0].message(eventEnvelope("already-seen", 50));
    expect(runtimeEventIds(onRecord)).toEqual(["already-seen"]);

    sockets[0].disconnect();
    expect(onConnectionChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: "reconnecting" }));
    await vi.advanceTimersByTimeAsync(300);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(sockets[1].messages()).toEqual([{ type: "attach", since: 0, version: 1 }]);
    sockets[1].message({ type: "ready", guiId: "gui-one", attached: true, since: 0 });
    expect(onConnectionChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: "connected" }));

    // A live event may arrive after attachment but before history.begin. It is
    // buffered, then suppressed when the same durable id appears in replay.
    sockets[1].message(eventEnvelope("at-boundary", 80));
    sockets[1].message(recordEnvelope({ schema_version: 1, type: "history.begin", since: 0 }));
    sockets[1].message(eventEnvelope("already-seen", 1, true));
    sockets[1].message(eventEnvelope("missed", 2, true));
    sockets[1].message(eventEnvelope("at-boundary", 3, true));
    const transcriptMessage = recordEnvelope({
      schema_version: 1,
      type: "transcript.message",
      replay: true,
      message_id: "runtime-one:transcript:1",
      role: "user",
      text: "Legacy prompt",
    });
    sockets[1].message(transcriptMessage);
    sockets[1].message(transcriptMessage);
    sockets[1].message(recordEnvelope({ schema_version: 1, type: "history.end", cursor: 3 }));
    expect(runtimeEventIds(onRecord)).toEqual(["already-seen", "missed", "at-boundary"]);
    expect(onRecord.mock.calls
      .map(([record]) => record)
      .filter((record) => record?.type === "transcript.message"))
      .toHaveLength(1);

    sockets[1].message(eventEnvelope("after-cursor", 999));
    sockets[1].disconnect();
    await vi.advanceTimersByTimeAsync(300);
    sockets[2].open();
    expect(sockets[2].messages()).toEqual([{ type: "attach", since: 3, version: 1 }]);

    connection.dispose();
    vi.useRealTimers();
  });

  // Regression: the host rejects the reattach because the runtime is gone, and this used to
  // close the socket straight into the reconnect backoff. The view retried a runtime that could
  // never come back -- "Reconnecting to compute" forever, composer disabled, and detaching the
  // tab did not stop it. A rejected reattach has to be terminal.
  it("ends the session when the host says the runtime no longer exists", async () => {
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
    const onExit = vi.fn();
    const pending = launchSession(
      { guiId: "gui-gone", projectDir: "/project" },
      { onRecord: vi.fn(), onLog: vi.fn(), onExit, onConnectionChange: vi.fn() },
    );
    sockets[0].open();
    sockets[0].message({ type: "ready", guiId: "gui-gone", attached: false });
    const connection = await pending;

    sockets[0].disconnect();
    await vi.advanceTimersByTimeAsync(300);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    sockets[1].message({ type: "error", message: "unknown session gui-gone" });

    expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ message: "unknown session gui-gone" }));

    // No further reconnect may be scheduled, however long we wait.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);

    connection.dispose();
    vi.useRealTimers();
  });

  // Regression: on a reattach every record is buffered until history.end arrives. When the
  // replay never completed, the buffer grew forever behind a UI that still read "connected" --
  // the session silently stopped updating with no error and no recovery.
  it("stops buffering and goes live when a reattach replay never completes", async () => {
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
      { guiId: "gui-stall", projectDir: "/project" },
      { onRecord, onLog: vi.fn(), onExit: vi.fn(), onConnectionChange: vi.fn() },
    );
    sockets[0].open();
    sockets[0].message({ type: "ready", guiId: "gui-stall", attached: false });
    const connection = await pending;

    sockets[0].disconnect();
    await vi.advanceTimersByTimeAsync(300);
    sockets[1].open();
    sockets[1].message({ type: "ready", guiId: "gui-stall", attached: true, since: 0 });

    // history.begin arrives, history.end never does.
    sockets[1].message(recordEnvelope({ schema_version: 1, type: "history.begin", since: 0 }));
    sockets[1].message(eventEnvelope("stranded", 10));
    expect(runtimeEventIds(onRecord)).toEqual([]);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(runtimeEventIds(onRecord)).toEqual(["stranded"]);

    // Live delivery resumes immediately instead of buffering the next record too.
    sockets[1].message(eventEnvelope("after-flush", 11));
    expect(runtimeEventIds(onRecord)).toEqual(["stranded", "after-flush"]);

    connection.dispose();
    vi.useRealTimers();
  });

  // Regression: "Retry restore" clears the transcript and re-asks for the whole ledger with
  // history.replay { since: 0 }. seenEventIds still held every id from the first delivery, so
  // every replayed record was dropped and the rebuilt transcript came back permanently blank.
  it("re-delivers the whole ledger after transport dedupe is reset for a retry", async () => {
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
      { guiId: "gui-retry", projectDir: "/project" },
      { onRecord, onLog: vi.fn(), onExit: vi.fn(), onConnectionChange: vi.fn() },
    );
    sockets[0].open();
    sockets[0].message({ type: "ready", guiId: "gui-retry", attached: false });
    const connection = await pending;

    sockets[0].message(eventEnvelope("first", 1));
    sockets[0].message(eventEnvelope("second", 2));
    expect(runtimeEventIds(onRecord)).toEqual(["first", "second"]);

    // Without the reset, a since:0 re-replay is swallowed entirely.
    onRecord.mockClear();
    sockets[0].message(recordEnvelope({ schema_version: 1, type: "history.begin", since: 0 }));
    sockets[0].message(eventEnvelope("first", 1, true));
    sockets[0].message(eventEnvelope("second", 2, true));
    sockets[0].message(recordEnvelope({ schema_version: 1, type: "history.end", cursor: 0, source: "transcript" }));
    expect(runtimeEventIds(onRecord)).toEqual([]);

    onRecord.mockClear();
    resetReplayDedupe("gui-retry");
    sockets[0].message(recordEnvelope({ schema_version: 1, type: "history.begin", since: 0 }));
    sockets[0].message(eventEnvelope("first", 1, true));
    sockets[0].message(eventEnvelope("second", 2, true));
    sockets[0].message(recordEnvelope({ schema_version: 1, type: "history.end", cursor: 0, source: "transcript" }));
    expect(runtimeEventIds(onRecord)).toEqual(["first", "second"]);

    connection.dispose();
    vi.useRealTimers();
  });

  it("does not append a cursorless legacy transcript again on reconnect", async () => {
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
      { guiId: "gui-legacy-reconnect", projectDir: "/project" },
      { onRecord, onLog: vi.fn(), onExit: vi.fn() },
    );
    const replayLegacy = (socket: FakeWebSocket) => {
      socket.message(recordEnvelope({ schema_version: 1, type: "history.begin", since: 0, source: "transcript" }));
      socket.message(recordEnvelope({
        schema_version: 1,
        type: "transcript.message",
        replay: true,
        message_id: "runtime-one:transcript:1",
        role: "user",
        text: "Legacy prompt",
      }));
      socket.message(recordEnvelope({
        schema_version: 1,
        type: "history.end",
        cursor: 0,
        source: "transcript",
        transcript_count: 1,
      }));
    };

    sockets[0].open();
    sockets[0].message({ type: "ready", guiId: "gui-legacy-reconnect", attached: false });
    const connection = await pending;
    replayLegacy(sockets[0]);
    expect(transcriptMessages(onRecord)).toHaveLength(1);

    for (let reconnect = 1; reconnect <= 2; reconnect += 1) {
      sockets[reconnect - 1].disconnect();
      await vi.advanceTimersByTimeAsync(300);
      sockets[reconnect].open();
      sockets[reconnect].message({ type: "ready", guiId: "gui-legacy-reconnect", attached: true, since: 0 });
      replayLegacy(sockets[reconnect]);
      expect(transcriptMessages(onRecord)).toHaveLength(1);
    }

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
    const onRecord = vi.fn();
    const pending = launchSession(
      { guiId: "gui-stop", projectDir: "/project" },
      { onRecord, onLog: vi.fn(), onExit: vi.fn() },
    );
    sockets[0].open();
    sockets[0].message({ type: "ready", guiId: "gui-stop", attached: false });
    const connection = await pending;

    let confirmed = false;
    const stopping = stopSession("gui-stop").then((value) => {
      confirmed = true;
      return value;
    });
    expect(sockets[0].messages().at(-1)).toEqual({ type: "stop", version: 1 });
    await Promise.resolve();
    expect(confirmed).toBe(false);

    sockets[0].message({
      type: "event",
      channel: "record",
      payload: {
        type: "transcript.message",
        role: "assistant",
        text: "The final response survives the stop drain",
      },
    });
    expect(onRecord).toHaveBeenCalledWith(expect.objectContaining({
      type: "transcript.message",
      text: "The final response survives the stop drain",
    }));
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

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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

function transcriptMessages(spy: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return spy.mock.calls
    .map(([record]) => record as Record<string, unknown>)
    .filter((record) => record.type === "transcript.message");
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
    this.emit("message", { data: JSON.stringify({ version: 1, ...value }) });
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
