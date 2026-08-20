import { describe, expect, it } from "vitest";
import { TerminalCoordinator } from "./coordinator";
import {
  MuxplexTerminalAdapter,
  MuxplexTransportError,
  type MuxplexHttpRequest,
  type MuxplexSocket,
  type MuxplexSocketData,
  type MuxplexSocketObserver,
  type MuxplexSocketRequest,
  type MuxplexTransport,
} from "./muxplexAdapter";
import { TerminalAuthorizationError, terminalId, type TerminalHostIdentity } from "./types";

const host: TerminalHostIdentity = {
  id: "spark-288f",
  label: "Spark 288f",
  kind: "remote",
  transport: "native",
};

class FakeSocket implements MuxplexSocket {
  readonly sent: Array<string | Uint8Array> = [];
  closeCount = 0;

  constructor(readonly request: MuxplexSocketRequest, readonly observer: MuxplexSocketObserver) {}

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCount += 1;
  }

  open(): void {
    this.observer.onOpen();
  }

  message(data: MuxplexSocketData): void {
    this.observer.onMessage(data);
  }

  closed(code = 1006, reason = "network changed"): void {
    this.observer.onClose({ code, reason });
  }
}

class FakeTransport implements MuxplexTransport {
  readonly requests: MuxplexHttpRequest[] = [];
  readonly sockets: FakeSocket[] = [];

  constructor(readonly respond: (request: MuxplexHttpRequest) => unknown | Promise<unknown>) {}

  async request<T>(request: MuxplexHttpRequest): Promise<T> {
    this.requests.push(request);
    return await this.respond(request) as T;
  }

  openSocket(request: MuxplexSocketRequest, observer: MuxplexSocketObserver): MuxplexSocket {
    const socket = new FakeSocket(request, observer);
    this.sockets.push(socket);
    return socket;
  }
}

function sessionList() {
  return [
    {
      name: "alpha",
      snapshot: "$ alpha",
      cwd: "/work/alpha",
      last_activity_at: 12,
      bell: { unseen_count: 0, last_fired_at: null, seen_at: null },
    },
    {
      name: "beta",
      snapshot: "$ beta",
      cwd: "/work/beta",
      last_activity_at: 15,
      bell: { unseen_count: 2, last_fired_at: 15, seen_at: 10, source: "hook" },
    },
  ];
}

function adapter(transport: MuxplexTransport, inputAuthorization: "input" | "read-only" = "input") {
  return new MuxplexTerminalAdapter({
    transport,
    host,
    deviceId: "studio-device",
    inputAuthorization,
    maxCaptureLines: 500,
  });
}

function ttydOutput(text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  const result = new Uint8Array(body.length + 1);
  result[0] = 0x30;
  result.set(body, 1);
  return result;
}

describe("MuxPlex terminal vertical slice", () => {
  it("keeps two attached terminals independent and carries host, project, and attention identity", async () => {
    const transport = new FakeTransport((request) => request.path === "/api/sessions" ? sessionList() : {});
    const coordinator = new TerminalCoordinator(adapter(transport));
    const sessions = await coordinator.refresh();
    const [alpha, beta] = sessions;

    expect(alpha.host).toEqual(host);
    expect(alpha.project).toMatchObject({ root: "/work/alpha", label: "alpha" });
    expect(beta.attention).toMatchObject({ needsAttention: true, unseenCount: 2, source: "hook" });

    await Promise.all([coordinator.attach(alpha.id), coordinator.attach(beta.id)]);
    transport.sockets[0].open();
    transport.sockets[1].open();
    transport.sockets[0].message(ttydOutput("\nalpha live"));
    transport.sockets[1].message(ttydOutput("\nbeta live"));

    const attached = coordinator.snapshot().sessions;
    expect(attached.map((session) => session.connection.status)).toEqual(["attached", "attached"]);
    expect(attached[0].liveOutput).toContain("alpha live");
    expect(attached[0].liveOutput).not.toContain("beta live");
    expect(attached[1].liveOutput).toContain("beta live");
    expect(transport.sockets.map((socket) => socket.request.query)).toEqual([
      { session: "alpha", device_id: "studio-device" },
      { session: "beta", device_id: "studio-device" },
    ]);
  });

  it("suppresses output and close events from a superseded connection", async () => {
    const transport = new FakeTransport((request) => request.path === "/api/sessions" ? [sessionList()[0]] : {});
    const coordinator = new TerminalCoordinator(adapter(transport));
    const [alpha] = await coordinator.refresh();

    await coordinator.attach(alpha.id);
    const stale = transport.sockets[0];
    stale.open();
    await coordinator.attach(alpha.id);
    const current = transport.sockets[1];
    current.open();

    stale.message(ttydOutput("stale output"));
    stale.closed();
    current.message(ttydOutput("current output"));

    const state = coordinator.snapshot().sessions[0];
    expect(stale.closeCount).toBe(1);
    expect(state.connection.status).toBe("attached");
    expect(state.liveOutput).toBe("current output");
  });

  it("reconnects the socket without creating or respawning the tmux session", async () => {
    const transport = new FakeTransport((request) => request.path === "/api/sessions" ? [sessionList()[0]] : {});
    const coordinator = new TerminalCoordinator(adapter(transport));
    const [alpha] = await coordinator.refresh();

    await coordinator.attach(alpha.id);
    transport.sockets[0].open();
    transport.sockets[0].closed();
    expect(coordinator.snapshot().sessions[0].connection.status).toBe("reconnecting");

    await coordinator.reconnect(alpha.id);
    transport.sockets[1].open();

    expect(coordinator.snapshot().sessions[0].connection.status).toBe("attached");
    expect(transport.requests.filter((request) => request.path.endsWith("/connect"))).toHaveLength(2);
    expect(transport.requests.filter((request) => request.path === "/api/sessions" && request.method === "POST")).toHaveLength(0);
  });

  it("defaults to read-only and downgrades a claimed input grant when MuxPlex rejects it", async () => {
    const readOnlyTransport = new FakeTransport((request) => request.path === "/api/sessions" ? [sessionList()[0]] : {});
    const readOnly = new TerminalCoordinator(adapter(readOnlyTransport, "read-only"));
    const [viewOnly] = await readOnly.refresh();
    await expect(readOnly.send(viewOnly.id, { text: "whoami", enter: true })).rejects.toBeInstanceOf(TerminalAuthorizationError);
    expect(readOnlyTransport.requests.some((request) => request.path.endsWith("/input"))).toBe(false);

    const deniedTransport = new FakeTransport((request) => {
      if (request.path === "/api/sessions") return [sessionList()[0]];
      if (request.path.endsWith("/input")) throw new MuxplexTransportError(403, "Input disabled by the host");
      return {};
    });
    const claimedInput = new TerminalCoordinator(adapter(deniedTransport, "input"));
    const [candidate] = await claimedInput.refresh();
    await expect(claimedInput.send(candidate.id, { text: "whoami", enter: true })).rejects.toBeInstanceOf(TerminalAuthorizationError);
    expect(claimedInput.snapshot().sessions[0].capabilities.send).toBe("read-only");
  });

  it("pages older scrollback using the server-provided absolute start cursor", async () => {
    const transport = new FakeTransport((request) => {
      if (request.path === "/api/sessions") return [sessionList()[0]];
      if (request.method === "GET" && request.path.endsWith("/alpha")) {
        return request.query?.before === 8
          ? { name: "alpha", snapshot: "row 6\nrow 7", start: 6, row_count: 2, total: 10, has_more: true, saturated: false }
          : { name: "alpha", snapshot: "row 8\nrow 9", start: 8, row_count: 2, total: 10, has_more: true, saturated: false };
      }
      return {};
    });
    const coordinator = new TerminalCoordinator(adapter(transport));
    const [alpha] = await coordinator.refresh();

    await coordinator.capture(alpha.id, { lines: 2 });
    const older = await coordinator.loadOlder(alpha.id, 2);

    expect(older?.snapshot).toBe("row 6\nrow 7\nrow 8\nrow 9");
    expect(coordinator.snapshot().sessions[0].scrollback).toMatchObject({ start: 6, hasMore: true, pageSize: 2 });
    expect(transport.requests.at(-1)?.query).toEqual({ lines: 2, before: 8 });
  });

  it("maps the complete MuxPlex lifecycle without putting credentials in paths or socket queries", async () => {
    const transport = new FakeTransport((request) => {
      if (request.method === "POST" && request.path === "/api/sessions") return { name: "gamma", ok: true };
      if (request.method === "POST" && request.path.endsWith("/rename")) return { name: "gamma-renamed", renamed: true };
      if (request.method === "POST" && request.path.endsWith("/input")) return { ok: true, snapshot: "$ pwd\n/work" };
      if (request.method === "GET" && request.path.endsWith("/gamma-renamed")) {
        return { name: "gamma-renamed", snapshot: "$", start: 0, row_count: 1, total: 1, has_more: false, saturated: false };
      }
      return {};
    });
    const backend = adapter(transport);
    const created = await backend.create({ name: "gamma", commandProfile: "default" });
    const renamed = await backend.rename(created, "gamma-renamed");
    await backend.attach(renamed, { onOpen() {}, onData() {}, onClose() {}, onError() {} });
    transport.sockets[0].open();
    await backend.resize(renamed, { columns: 120, rows: 40 });
    await backend.send(renamed, { text: "pwd", enter: true, captureLines: 80 });
    await backend.capture(renamed, { lines: 80 });
    await backend.detach(renamed);
    await backend.terminate(renamed);

    expect(created.id).toBe(terminalId(host.id, "gamma"));
    expect(renamed.id).toBe(terminalId(host.id, "gamma-renamed"));
    expect(transport.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /api/sessions",
      "POST /api/sessions/gamma/rename",
      "POST /api/sessions/gamma-renamed/connect",
      "POST /api/sessions/gamma-renamed/input",
      "GET /api/sessions/gamma-renamed",
      "DELETE /api/sessions/gamma-renamed",
    ]);
    expect(transport.sockets[0].request).toEqual({
      path: "/terminal/ws",
      query: { session: "gamma-renamed", device_id: "studio-device" },
      protocols: ["tty"],
    });
    expect(transport.sockets[0].sent[0]).toBe(JSON.stringify({ AuthToken: "" }));
    expect(Array.from(transport.sockets[0].sent[1] as Uint8Array)[0]).toBe(0x31);
    expect(JSON.stringify(transport.requests)).not.toMatch(/token|authorization|password|secret/i);
  });
});
