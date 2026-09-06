// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createInputReceipts, type InputReceipt } from "./inputReceipts";

describe("input receipts", () => {
  it("assigns identity only with capability and rechecks without resending text", async () => {
    const send = vi.fn(async (_gui: string, _op: Record<string, unknown>) => {});
    let items: InputReceipt[] = [];
    const tracker = createInputReceipts(send, (value) => { items = value; });
    await tracker.send("gui", { op: "submit", text: "retained" }, true);
    const first = send.mock.calls[0][1];
    expect(first.idem).toBe(first.request_id);
    expect(items[0].stage).toBe("unconfirmed");
    tracker.recheck("gui");
    const query = send.mock.calls[1][1];
    expect(query.op).toBe("input.status");
    expect(query).not.toHaveProperty("text");
    expect(tracker.accept("other", { type: "input.status", ...query, stage: "dispatched" })).toBe(true);
    expect(items[0].stage).toBe("unconfirmed");
    tracker.accept("gui", { type: "input.status", ...query, stage: "unknown_previous_instance", ok: false });
    expect(items[0]).toMatchObject({ text: "retained", stage: "unknown" });
    expect(send.mock.calls.filter(([, op]) => op.op === "submit")).toHaveLength(1);
    await tracker.send("legacy", { op: "steer", text: "legacy" }, false);
    expect(send.mock.calls.at(-1)?.[1]).toEqual({ op: "steer", text: "legacy" });
  });

  it("retains failed sends, correlates acknowledgements and keeps dispatched distinct from executed", async () => {
    let items: InputReceipt[] = [];
    const send = vi.fn(async (_gui: string, _op: Record<string, unknown>) => { throw new Error("disconnected"); });
    const tracker = createInputReceipts(send, (value) => { items = value; });
    await expect(tracker.send("gui", { op: "steer", text: "keep this" }, true)).rejects.toThrow("disconnected");
    const id = items[0].inputId;
    tracker.accept("gui", { type: "input.result", input_id: id, request_id: "stale", stage: "queued" });
    expect(items[0].stage).toBe("unconfirmed");
    tracker.accept("gui", { type: "input.result", input_id: id, request_id: id, stage: "queued", ok: true });
    expect(items[0]).toMatchObject({ text: "keep this", stage: "queued" });
    tracker.dismiss(id);
    expect(items).toEqual([]);
  });
});

it("evicts confirmed receipts before gating unresolved input", async () => {
  const send = vi.fn(async (_gui: string, _op: Record<string, unknown>) => {});
  let items: InputReceipt[] = [];
  const tracker = createInputReceipts(send, (value) => { items = value; });
  for (let index = 0; index < 32; index++) await tracker.send("gui", { op: "submit", text: String(index) }, true);
  await expect(tracker.send("gui", { op: "submit", text: "blocked" }, true)).rejects.toThrow("unresolved");
  expect(send).toHaveBeenCalledTimes(32);
  const id = items[1].inputId;
  tracker.accept("gui", { type: "input.result", input_id: id, request_id: id, stage: "dispatched", ok: true });
  await tracker.send("gui", { op: "submit", text: "next" }, true);
  expect(items).toHaveLength(32);
  expect(items.some((item) => item.text === "0")).toBe(true);
  expect(items.some((item) => item.inputId === id)).toBe(false);
});
