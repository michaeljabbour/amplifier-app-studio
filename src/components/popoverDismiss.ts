import { createEffect, onCleanup } from "solid-js";

/** WebKit can blur an input to null when a menu button is pressed. Do not
 * remove that button before its click; use outside pointer events instead. */
export function popoverDismiss(element: () => HTMLElement | undefined, open: () => boolean, close: () => void) {
  createEffect(() => {
    if (!open()) return;
    const outside = (event: PointerEvent) => {
      if (!element()?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside, true);
    onCleanup(() => document.removeEventListener("pointerdown", outside, true));
  });
  return (event: FocusEvent) => {
    if (event.relatedTarget && !element()?.contains(event.relatedTarget as Node)) close();
  };
}
