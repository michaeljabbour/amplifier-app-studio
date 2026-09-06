// @vitest-environment jsdom
import { render } from "solid-js/web";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationHistory } from "./ConversationHistory";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.replaceChildren(); });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

it("pages bounded outlines and loads an old conversation without requesting replay", async () => {
  const request = vi.fn(async (op: string, args: Record<string, unknown>) => {
    if (op === "history.window") return { ok: true, generation: "g1", records: [{ event_id: args.event_id, kind: "prompt_submit", prompt: "The earlier conversation" }] };
    return { ok: true, generation: "g1", entries: [{ event_id: args.cursor ? "p51" : "p1", kind: "prompt_submit", preview: args.cursor ? "Later prompt" : "Earliest prompt" }], next_cursor: args.cursor ? null : "opaque-page-2" };
  });
  dispose = render(() => <ConversationHistory title="Large session" supported request={request} onClose={() => {}} />, document.body);
  await settle();
  (Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("Earliest prompt"))!).click();
  await settle();
  expect(document.querySelector('[aria-label="Selected conversation"]')?.textContent).toContain("The earlier conversation");
  expect(request).toHaveBeenCalledWith("history.window", { event_id: "p1", generation: "g1", before: 2, after: 2 });
  (Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Next")!).click();
  await settle();
  expect(request).toHaveBeenLastCalledWith("history.outline", { cursor: "opaque-page-2", limit: 50 });
  expect(document.querySelector('[aria-label="Conversation entries"]')?.textContent).toContain("Later prompt");
  expect(document.querySelector('[aria-label="Conversation entries"]')?.textContent).not.toContain("Earliest prompt");
  expect(request.mock.calls.every(([op]) => op !== "history.replay")).toBe(true);
});

it("explains unsupported or unavailable history without fabricating entries", async () => {
  const request = vi.fn(async () => { throw new Error("Navigation unavailable after rewind"); });
  dispose = render(() => <ConversationHistory title="Rewound session" supported request={request} onClose={() => {}} />, document.body);
  await settle();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Navigation unavailable after rewind");
  expect(document.querySelectorAll(".conversation-history-list button")).toHaveLength(0);
  dispose();
  request.mockClear();
  dispose = render(() => <ConversationHistory title="Legacy runtime" supported={false} request={request} onClose={() => {}} />, document.body);
  expect(document.body.textContent).toContain("does not support conversation navigation");
  expect(request).not.toHaveBeenCalled();
});

it("shows busy navigation and retries explicitly", async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error("Conversation navigation is busy; try again shortly.")).mockResolvedValueOnce({ generation: "g1", entries: [], next_cursor: null });
  dispose = render(() => <ConversationHistory title="Busy session" supported request={request} onClose={() => {}} />, document.body);
  await settle();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("busy");
  (Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Reload outline")!).click();
  await settle();
  expect(request).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="alert"]')).toBeNull();
});
