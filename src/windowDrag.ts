import { getCurrentWindow } from "@tauri-apps/api/window";

export function startNativeWindowDrag(event: MouseEvent): void {
  if (event.button !== 0 || !("__TAURI_INTERNALS__" in window)) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("button, input, textarea, select, a, [role='button']")) return;
  event.preventDefault();
  void getCurrentWindow().startDragging();
}
