// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationEntries, createSessionHistoryReader } from "./sessionHistory";

afterEach(() => vi.useRealTimers());

describe("isolated conversation navigation", () => {
  it("correlates host replies by view and request without accepting them as replay", async () => {
    const send = vi.fn(async () => {});
    const reader = createSessionHistoryReader(send);
    const pending = reader.request("view-a", "history.outline", { limit: 50 });
    const [, request] = send.mock.calls[0] as unknown as [string, Record<string, unknown>];
    const response = { type: "history.outline", request_id: request.request_id, ok: true, entries: [] };
    let resolved = false;
    void pending.then(() => { resolved = true; });
    expect(reader.accept("view-b", response)).toBe(true);
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(reader.accept("view-a", { type: "history.end", cursor: 500 })).toBe(false);
    expect(reader.accept("view-a", response)).toBe(true);
    await expect(pending).resolves.toEqual(response);
    expect(reader.accept("view-a", response)).toBe(true);
  });

  it("bounds requests per operation and ignores superseded selection replies", async () => {
    const send = vi.fn(async () => {});
    const reader = createSessionHistoryReader(send);
    const old = reader.request("view", "history.window", { event_id: "old" }).catch((error: Error) => error.message);
    const current = reader.request("view", "history.window", { event_id: "new" });
    const calls = send.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
    expect(reader.accept("view", { type: "history.window", request_id: calls[0][1].request_id, ok: true })).toBe(true);
    reader.accept("view", { type: "history.window", request_id: calls[1][1].request_id, ok: true, target_event_id: "new" });
    await expect(old).resolves.toContain("newer history request");
    await expect(current).resolves.toMatchObject({ target_event_id: "new" });
  });

  it("reports request expiry and rejects closed-view requests without replay", async () => {
    vi.useFakeTimers();
    const reader = createSessionHistoryReader(async () => {});
    const pending = reader.request("view", "history.outline").catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toContain("History did not respond");
    const closing = reader.request("view", "history.window").catch((error: Error) => error.message);
    reader.cancelSession("view");
    await expect(closing).resolves.toBe("History view closed");
  });

  it("extracts conversation only and rejects unsupported events", () => {
    expect(conversationEntries({ records: [{ event_id: "p1", kind: "prompt_submit", prompt: "Earlier question" }] }, "records")).toEqual([{ eventId: "p1", kind: "prompt_submit", text: "Earlier question" }]);
    expect(() => conversationEntries({ records: [{ event_id: "private", kind: "thinking", text: "hidden" }] }, "records")).toThrow("unsupported");
  });
});
