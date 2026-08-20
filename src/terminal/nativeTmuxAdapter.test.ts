import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NativeTmuxAdapter,
  requireExactTmuxName,
  terminalSnapshotDelta,
  type NativeTmuxInvoke,
} from "./nativeTmuxAdapter";
import { terminalId, type TerminalAttachmentObserver, type TerminalHostIdentity } from "./types";

const host: TerminalHostIdentity = {
  id: "local",
  label: "This Mac",
  kind: "local",
  transport: "native",
};

interface NativeCall {
  command: string;
  args?: Record<string, unknown>;
}

class FakeNativeTmux {
  readonly calls: NativeCall[] = [];
  sessions: unknown = [{ name: "alpha", createdAt: 10, lastActivityAt: 20, cwd: "/work/alpha" }];
  captures: Array<unknown | Error | string> = [
    { snapshot: "$", historySize: 0, paneHeight: 24 },
  ];

  readonly invoke: NativeTmuxInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
    this.calls.push({ command, args });
    if (command === "terminal_tmux_list") return this.sessions as T;
    if (command === "terminal_tmux_capture") {
      const response = this.captures.length > 1 ? this.captures.shift() : this.captures[0];
      if (response instanceof Error || typeof response === "string") throw response;
      return response as T;
    }
    return undefined as T;
  };
}

function adapter(fake: FakeNativeTmux, pollIntervalMs = 100) {
  return new NativeTmuxAdapter({
    host,
    invoke: fake.invoke,
    pollIntervalMs,
    project: { id: "project", label: "Project", root: "/work/alpha" },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("native tmux adapter", () => {
  it("maps the complete local lifecycle while detach leaves tmux running", async () => {
    const fake = new FakeNativeTmux();
    const backend = adapter(fake);
    const [alpha] = await backend.list();
    expect(alpha).toMatchObject({
      id: terminalId("local", "alpha"),
      backendId: "alpha",
      cwd: "/work/alpha",
      project: { id: "project", root: "/work/alpha" },
    });

    const created = await backend.create({
      name: "studio-build",
      project: { id: "other", label: "Other", root: "/work/other" },
    });
    const renamed = await backend.rename(created, "studio-ready");
    const hostile = "; rm -rf / && $(reboot) `id` | tee /tmp/pwned";
    await backend.send(renamed, { text: hostile, keys: ["C-c"], enter: true });
    await backend.resize(renamed, { columns: 120.9, rows: 40.8 });
    await backend.detach(renamed);
    await backend.terminate(renamed);

    expect(fake.calls).toEqual([
      { command: "terminal_tmux_list", args: undefined },
      { command: "terminal_tmux_create", args: { name: "studio-build", projectDir: "/work/other" } },
      { command: "terminal_tmux_rename", args: { name: "studio-build", newName: "studio-ready" } },
      {
        command: "terminal_tmux_send",
        args: { name: "studio-ready", text: hostile, keys: ["C-c"], enter: true },
      },
      { command: "terminal_tmux_resize", args: { name: "studio-ready", columns: 120, rows: 40 } },
      { command: "terminal_tmux_terminate", args: { name: "studio-ready" } },
    ]);
    expect(fake.calls.some((call) => /server/i.test(call.command))).toBe(false);
  });

  it("polls an attachment, reports deltas, and classifies an exact session disappearing", async () => {
    vi.useFakeTimers();
    const fake = new FakeNativeTmux();
    fake.captures = [
      { snapshot: "$", historySize: 0, paneHeight: 24 },
      { snapshot: "$ pwd", historySize: 0, paneHeight: 24 },
      "TMUX_SESSION_NOT_FOUND: The tmux session no longer exists",
    ];
    const backend = adapter(fake);
    const [alpha] = await backend.list();
    const opened = vi.fn();
    const data = vi.fn();
    const closed = vi.fn();
    const observer: TerminalAttachmentObserver = { onOpen: opened, onData: data, onClose: closed, onError: vi.fn() };

    await backend.attach(alpha, observer);
    expect(opened).toHaveBeenCalledOnce();
    expect(data).toHaveBeenCalledWith("$");
    await vi.advanceTimersByTimeAsync(100);
    expect(data).toHaveBeenLastCalledWith(" pwd");
    await vi.advanceTimersByTimeAsync(100);
    expect(closed).toHaveBeenCalledWith({
      code: 4404,
      reason: "The tmux session no longer exists",
      expected: false,
    });
    expect(fake.calls.filter((call) => call.command === "terminal_tmux_create")).toHaveLength(0);
  });

  it("reconnects by starting a fresh poller and never creates or respawns the session", async () => {
    vi.useFakeTimers();
    const fake = new FakeNativeTmux();
    fake.captures = [
      { snapshot: "$ first", historySize: 0, paneHeight: 24 },
      { snapshot: "$ second", historySize: 0, paneHeight: 24 },
    ];
    const backend = adapter(fake);
    const [alpha] = await backend.list();
    const observer = (): TerminalAttachmentObserver => ({
      onOpen: vi.fn(),
      onData: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    });

    const first = await backend.attach(alpha, observer());
    first.close();
    await backend.attach(alpha, observer());

    expect(fake.calls.filter((call) => call.command === "terminal_tmux_capture")).toHaveLength(2);
    expect(fake.calls.filter((call) => call.command === "terminal_tmux_create")).toHaveLength(0);
  });

  it("rejects unstable names and unsupported keys before crossing the native boundary", async () => {
    const fake = new FakeNativeTmux();
    const backend = adapter(fake);
    const [alpha] = await backend.list();

    for (const invalid of ["", "-leading", "has space", "build.js", "name:window", "$(id)"]) {
      expect(() => requireExactTmuxName(invalid)).toThrow(/Terminal names/);
    }
    await expect(backend.create({ name: "$(touch /tmp/pwned)" })).rejects.toThrow(/Terminal names/);
    await expect(backend.rename(alpha, "build.js")).rejects.toThrow(/Terminal names/);
    await expect(backend.send(alpha, { keys: ["C-b"] })).rejects.toThrow("Unsupported terminal key: C-b");
    expect(fake.calls.map((call) => call.command)).toEqual(["terminal_tmux_list"]);
  });

  it("derives bounded polling deltas without replaying an unchanged screen", () => {
    expect(terminalSnapshotDelta("$", "$ pwd")).toBe(" pwd");
    expect(terminalSnapshotDelta("one\ntwo", "two\nthree")).toBe("\nthree");
    expect(terminalSnapshotDelta("same", "same")).toBe("");
    expect(terminalSnapshotDelta("", "fresh")).toBe("fresh");
  });
});
