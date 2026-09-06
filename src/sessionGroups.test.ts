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
