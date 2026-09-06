import { describe, expect, it } from "vitest";
import { groupByDirectory, shortBundleName } from "./sessionGroups";
describe("directory navigation", () => {
  it("keeps same directory on different computes separate, preserving recent order", () => {
    const items = [{ path: "/dev/app", host: "a", id: 1 }, { path: "/dev/app", host: "b", id: 2 }, { path: "/dev/app", host: "a", id: 3 }, { path: "/other/app", host: "a", id: 4 }];
    const groups = groupByDirectory(items, (item) => item);
    expect(groups.map((group) => group.items.map((item) => item.id))).toEqual([[1, 3], [2], [4]]);
    expect(groups[0].path).toBe("/dev/app");
    expect(shortBundleName("bundle:file:////Users/sample/dev/reviewer-bundle.md")).toBe("reviewer-bundle.md");
  });
});

import { filterSessionTree, sessionTree } from "./sessionGroups";
it("nests children across directories but never across hosts", () => {
  const child = { sessionId: "child", parentSessionId: "root", hostId: "a", projectSlug: "other" };
  const root = { sessionId: "root", hostId: "a", projectSlug: "project" };
  const remote = { sessionId: "remote", parentSessionId: "root", hostId: "b" };
  const tree = sessionTree([child, root, remote]);
  expect(tree.map((node) => node.session.sessionId)).toEqual(["root", "remote"]);
  expect(tree[0].children[0].session).toBe(child);
  expect(filterSessionTree(tree, (session) => session.sessionId === "child")[0].children).toHaveLength(1);
});
it("keeps missing parents, cycles, and duplicate IDs discoverable", () => {
  const tree = sessionTree([
    { sessionId: "a", parentSessionId: "b" }, { sessionId: "b", parentSessionId: "a" },
    { sessionId: "orphan", parentSessionId: "missing" },
    { sessionId: "same", projectSlug: "one" }, { sessionId: "same", projectSlug: "two" },
    { sessionId: "child", parentSessionId: "same", projectSlug: "two" },
  ]);
  expect(tree).toHaveLength(5);
  expect(tree[4].children[0].session.sessionId).toBe("child");
});
