// @vitest-environment jsdom
import { render } from "solid-js/web";
import { expect, it, vi } from "vitest";
import { SessionDrawer } from "./SessionDrawer";
import type { StoredSession } from "../protocol";

it("opens collapsed directories, nests children, and reveals their parents during search", async () => {
  const root = document.createElement("div"); document.body.append(root);
  const session = (id: string, parentSessionId?: string): StoredSession => ({ sessionId: id, parentSessionId, name: id, bundle: "test", tags: [], messageCount: 3, mtimeMs: 1, projectSlug: "project", projectDir: "/dev/project", state: "ok", summary: "" });
  const resume = vi.fn();
  const dispose = render(() => <SessionDrawer sessions={[session("child-needle", "parent"), session("parent")]} openSessions={[]} detachedSessionIds={[]} loading={false} sourceName="Local" sessionHomeName="Local" onClose={() => {}} onRefresh={() => {}} onResume={resume} onSelectOpen={() => {}} onDetachOpen={() => {}} onStopOpen={() => {}} onNew={() => {}} onCapabilities={() => {}} onSettings={() => {}} />, root);
  expect(root.querySelector<HTMLDetailsElement>(".history-directory")!.open).toBe(false);
  expect(root.querySelectorAll(".stored-row")).toHaveLength(0);
  const directory = root.querySelector<HTMLDetailsElement>(".history-directory")!;
  directory.open = true; directory.dispatchEvent(new Event("toggle"));
  await vi.waitFor(() => expect(root.querySelectorAll(".history-directory > .history-session-branch")).toHaveLength(1));
  expect(root.querySelectorAll(".history-children .stored-row")).toHaveLength(0);
  const search = root.querySelector<HTMLInputElement>('[aria-label="Search stored sessions"]')!;
  search.value = "child-needle"; search.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() => expect(root.querySelector<HTMLDetailsElement>(".history-directory")!.open).toBe(true));
  expect(root.querySelector<HTMLDetailsElement>(".history-children")!.open).toBe(true);
  root.querySelector<HTMLButtonElement>(".history-children .stored-row")!.click();
  expect(resume).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "child-needle" }));
  dispose(); root.remove();
});
