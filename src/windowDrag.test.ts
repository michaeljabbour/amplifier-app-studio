// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { startNativeWindowDrag } from "./windowDrag";

const startDragging = vi.fn(async () => undefined);
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ startDragging }) }));

afterEach(() => {
  startDragging.mockClear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("native window dragging", () => {
  it("drags blank chrome without stealing interactive controls", () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    const blank = document.createElement("div");
    const preventDefault = vi.fn();
    startNativeWindowDrag({ button: 0, target: blank, preventDefault } as unknown as MouseEvent);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(startDragging).toHaveBeenCalledOnce();

    const button = document.createElement("button");
    startNativeWindowDrag({ button: 0, target: button, preventDefault } as unknown as MouseEvent);
    expect(startDragging).toHaveBeenCalledOnce();
  });
});
