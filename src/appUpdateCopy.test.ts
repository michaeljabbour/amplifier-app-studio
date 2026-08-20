import { describe, expect, it } from "vitest";
import { appUpdateBlocked } from "./appUpdateCopy";
import type { SessionPhase } from "./protocol";

const session = (phase: SessionPhase, busy = false) => ({ busy, phase });

describe("app update gating", () => {
  it("waits for genuinely transient work", () => {
    expect(appUpdateBlocked([session("ready", true)])).toBe(true);
    expect(appUpdateBlocked([session("starting")])).toBe(true);
    expect(appUpdateBlocked([session("closing")])).toBe(true);
  });

  // Regression, reproduced live on 0.1.41: a session whose restore stalled sits in `degraded`
  // until the user picks "Retry restore" or "Open anyway". Treating that as work-in-flight left
  // the Update button permanently disabled, with a tooltip telling the user to finish active
  // turns that did not exist. The only escape was noticing an unrelated button in the transcript.
  it("does not let a stalled restore deadlock the updater forever", () => {
    expect(appUpdateBlocked([session("degraded")])).toBe(false);
    expect(appUpdateBlocked([session("ready"), session("degraded"), session("exited")])).toBe(false);
  });

  it("still blocks a degraded session that is mid-turn", () => {
    expect(appUpdateBlocked([session("degraded", true)])).toBe(true);
  });

  it("allows an update when nothing is running", () => {
    expect(appUpdateBlocked([])).toBe(false);
    expect(appUpdateBlocked([session("ready"), session("exited"), session("error")])).toBe(false);
  });
});
