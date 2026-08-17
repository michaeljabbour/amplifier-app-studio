import type { AppUpdateState } from "./updater";

export function appUpdateButtonTitle(update: AppUpdateState, blocked: boolean): string {
  if (blocked) return "Update ready. Finish or interrupt active turns before restarting.";
  if (update.status === "error") return update.message || "The Studio update did not install. Retry to check the release again.";
  return update.notes || update.message || "Install the latest Amplifier Studio release";
}
