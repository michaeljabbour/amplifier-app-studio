const FOCUSABLE = [
  "button:not(:disabled)",
  "[href]",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * Keeps Tab focus inside a modal.
 *
 * `aria-modal="true"` is a promise to assistive technology that the rest of the page is inert.
 * Without a trap that promise is a lie: keyboard and screen-reader users tab straight out into
 * the frozen background with no way to tell they have left, and no way back except reversing
 * every tab. Studio declared five modals and implemented this for exactly one of them.
 *
 * Attach to the element that WRAPS the dialog (the backdrop), so `currentTarget` can find it.
 */
export function keepModalFocus(
  event: KeyboardEvent,
  dialogSelector = '[role="dialog"], [role="alertdialog"]',
): void {
  if (event.key !== "Tab") return;
  const wrapper = event.currentTarget as HTMLElement | null;
  const dialog = wrapper?.matches(dialogSelector) ? wrapper : wrapper?.querySelector<HTMLElement>(dialogSelector);
  // Collect in document order and filter, rather than relying on a comma-separated
  // querySelectorAll: that returns matches grouped per selector under jsdom, which would pick
  // the wrong "first" and "last" and wrap focus to the middle of the dialog.
  const controls = dialog
    ? [...dialog.querySelectorAll<HTMLElement>("*")].filter((element) => element.matches(FOCUSABLE))
    : [];
  if (!controls.length) return;

  const first = controls[0];
  const last = controls[controls.length - 1];
  const active = dialog?.ownerDocument?.activeElement;

  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
