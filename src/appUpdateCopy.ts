import type { SessionPhase } from "./protocol";
import type { AppUpdateState } from "./updater";

/**
 * Whether an available update must wait before it can be installed.
 *
 * Only genuinely transient work blocks a restart. `degraded` is deliberately NOT in this list:
 * it means a session's restore stalled and is now waiting for the user to choose "Retry restore"
 * or "Open anyway", so it can persist indefinitely. Including it deadlocked the updater behind a
 * stuck tab -- the button went permanently disabled while its tooltip told the user to finish
 * active turns that did not exist. A degraded session that is also mid-turn still blocks, because
 * `busy` covers that independently.
 */
export function appUpdateBlocked(
  sessions: readonly { busy: boolean; phase: SessionPhase }[],
): boolean {
  return sessions.some((session) => session.busy || session.phase === "starting" || session.phase === "closing");
}

export function appUpdateButtonTitle(update: AppUpdateState, blocked: boolean): string {
  if (blocked) return "Update ready. Finish or interrupt active turns before restarting.";
  if (update.status === "error") return update.message || "The Studio update did not install. Retry to check the release again.";
  return update.notes || update.message || "Install the latest Amplifier Studio release";
}
