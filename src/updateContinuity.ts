import type { NewSessionInput, SessionViewState, StoredSession } from "./protocol";
import { usableSessionTitle } from "./reducer";

const RESTORE_KEY = "amplifier-studio.update-restore.v1";
const MAX_RESTORE_AGE_MS = 24 * 60 * 60 * 1_000;

export interface UpdateRestoreEntry extends NewSessionInput {
  active: boolean;
}

interface UpdateRestorePlan {
  version: 1;
  savedAtMs: number;
  sessions: UpdateRestoreEntry[];
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function saveUpdateRestorePlan(
  storage: StorageLike,
  sessions: SessionViewState[],
  activeId: string | undefined,
  now = Date.now(),
): boolean {
  const restorable = sessions.flatMap((session): UpdateRestoreEntry[] => {
    if (session.phase !== "ready" || !session.runtimeSessionId || !session.projectDir) return [];
    const visibleHistoryMessages = session.blocks.filter(
      (block) => block.kind === "user" || block.kind === "answer",
    ).length;
    return [{
      projectDir: session.projectDir,
      hostId: session.hostId,
      hostName: session.hostName,
      hostUrl: session.hostUrl,
      bundle: session.requestedBundle,
      model: session.requestedModel,
      provider: session.requestedProvider,
      mode: session.mode,
      resumeId: session.runtimeSessionId,
      resumeName: usableSessionTitle(session.title),
      expectedHistoryMessages: session.expectedHistoryMessages
        ?? (visibleHistoryMessages > 0 ? visibleHistoryMessages : undefined),
      active: session.guiId === activeId,
    }];
  });
  if (restorable.length === 0) {
    storage.removeItem(RESTORE_KEY);
    return false;
  }
  const plan: UpdateRestorePlan = { version: 1, savedAtMs: now, sessions: restorable };
  storage.setItem(RESTORE_KEY, JSON.stringify(plan));
  return true;
}

export function takeUpdateRestorePlan(
  storage: StorageLike,
  now = Date.now(),
): UpdateRestoreEntry[] {
  const raw = storage.getItem(RESTORE_KEY);
  storage.removeItem(RESTORE_KEY);
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as Partial<UpdateRestorePlan>;
    if (value.version !== 1 || typeof value.savedAtMs !== "number" || !Array.isArray(value.sessions)) return [];
    if (now - value.savedAtMs < 0 || now - value.savedAtMs > MAX_RESTORE_AGE_MS) return [];
    const sessions = value.sessions.filter((entry): entry is UpdateRestoreEntry =>
      typeof entry === "object"
      && entry !== null
      && typeof entry.projectDir === "string"
      && entry.projectDir.trim().length > 0
      && typeof entry.resumeId === "string"
      && entry.resumeId.trim().length > 0
      && typeof entry.active === "boolean",
    );
    return [...sessions.filter((entry) => !entry.active), ...sessions.filter((entry) => entry.active)];
  } catch {
    return [];
  }
}

export function clearUpdateRestorePlan(storage: StorageLike): void {
  storage.removeItem(RESTORE_KEY);
}

/** Older Studio versions saved only projectDir + resumeId. Hydrate those
 * entries from federated durable history so the first update to the fixed
 * build returns remote sessions to their owning compute instead of treating
 * them as an unauthenticated global bridge. Ambiguous matches fail closed. */
export function hydrateLegacyUpdateRestoreEntry(
  entry: UpdateRestoreEntry,
  storedSessions: StoredSession[],
): UpdateRestoreEntry {
  if (entry.hostId || entry.hostUrl) return entry;
  const candidates = storedSessions.filter((session) => session.sessionId === entry.resumeId
    && (!session.projectDir || sameProject(session.projectDir, entry.projectDir)));
  if (candidates.length !== 1) return entry;
  const match = candidates[0];
  return {
    ...entry,
    projectDir: match.projectDir || entry.projectDir,
    hostId: match.hostId,
    hostName: match.hostName,
    hostUrl: match.hostUrl,
    expectedHistoryMessages: match.messageCount,
  };
}

function sameProject(left: string, right: string): boolean {
  const normalize = (value: string) => value.trim().replace(/[\\/]+$/, "");
  return normalize(left) === normalize(right);
}
