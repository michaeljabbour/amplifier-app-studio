// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { keepModalFocus } from "./focusTrap";

function modal(): { backdrop: HTMLElement; first: HTMLButtonElement; last: HTMLButtonElement } {
  document.body.innerHTML = `
    <button id="outside">outside</button>
    <div id="backdrop">
      <section role="dialog" aria-modal="true">
        <button id="first">first</button>
        <input id="middle" />
        <button id="last">last</button>
      </section>
    </div>`;
  return {
    backdrop: document.getElementById("backdrop") as HTMLElement,
    first: document.getElementById("first") as HTMLButtonElement,
    last: document.getElementById("last") as HTMLButtonElement,
  };
}

function tab(backdrop: HTMLElement, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, cancelable: true });
  Object.defineProperty(event, "currentTarget", { value: backdrop });
  keepModalFocus(event);
  return event;
}

describe("modal focus trap", () => {
  it("wraps forward from the last control to the first", () => {
    const { backdrop, first, last } = modal();
    last.focus();
    const event = tab(backdrop);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it("wraps backward from the first control to the last", () => {
    const { backdrop, first, last } = modal();
    first.focus();
    const event = tab(backdrop, true);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it("leaves interior tabbing to the browser", () => {
    const { backdrop, first } = modal();
    first.focus();
    const event = tab(backdrop);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(first);
  });

  it("ignores keys other than Tab", () => {
    const { backdrop, last } = modal();
    last.focus();
    const event = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    Object.defineProperty(event, "currentTarget", { value: backdrop });
    keepModalFocus(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("does nothing when the dialog has no focusable controls", () => {
    document.body.innerHTML = `<div id="backdrop"><section role="dialog"><p>text only</p></section></div>`;
    const backdrop = document.getElementById("backdrop") as HTMLElement;
    const event = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    Object.defineProperty(event, "currentTarget", { value: backdrop });
    expect(() => keepModalFocus(event)).not.toThrow();
    expect(event.defaultPrevented).toBe(false);
  });
});
