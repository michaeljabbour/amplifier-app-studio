import type {
  CaptureTerminalRequest,
  CreateTerminalRequest,
  TerminalAttachment,
  TerminalBackend,
  TerminalCapture,
  TerminalConnectionStatus,
  TerminalCoordinatorContract,
  TerminalCoordinatorSnapshot,
  TerminalId,
  TerminalInputRequest,
  TerminalInputResult,
  TerminalSession,
  TerminalSize,
} from "./types";
import { TerminalAuthorizationError } from "./types";

const MAX_LIVE_OUTPUT_CHARACTERS = 1_000_000;

interface LiveAttachment {
  generation: number;
  attachment: TerminalAttachment;
}

/**
 * Owns terminal lifecycle and suppresses late events from superseded sockets.
 * It intentionally does not schedule retries: the app decides when a device is
 * online enough to reconnect, while `reconnect()` guarantees no PTY respawn.
 */
export class TerminalCoordinator implements TerminalCoordinatorContract {
  private current: TerminalCoordinatorSnapshot = { sessions: [], refreshing: false };
  private readonly listeners = new Set<(snapshot: TerminalCoordinatorSnapshot) => void>();
  private readonly attachments = new Map<TerminalId, LiveAttachment>();
  private readonly generations = new Map<TerminalId, number>();
  private disposed = false;

  constructor(private readonly backend: TerminalBackend) {}

  snapshot(): TerminalCoordinatorSnapshot {
    return this.current;
  }

  subscribe(listener: (snapshot: TerminalCoordinatorSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  select(id: TerminalId | undefined): void {
    if (id !== undefined) this.requireSession(id);
    this.commit({ ...this.current, selectedId: id, error: undefined });
  }

  async refresh(): Promise<readonly TerminalSession[]> {
    this.assertAlive();
    this.commit({ ...this.current, refreshing: true, error: undefined });
    try {
      const discovered = await this.backend.list();
      const discoveredIds = new Set(discovered.map((session) => session.id));
      for (const [id, live] of this.attachments) {
        if (!discoveredIds.has(id)) {
          this.nextGeneration(id);
          live.attachment.close();
          this.attachments.delete(id);
        }
      }
      const merged = discovered.map((session) => {
        const existing = this.current.sessions.find((candidate) => candidate.id === session.id);
        return existing ? mergeDiscoveredSession(existing, session) : session;
      });
      const selectedId = this.current.selectedId && discoveredIds.has(this.current.selectedId)
        ? this.current.selectedId
        : merged[0]?.id;
      this.commit({ sessions: merged, selectedId, refreshing: false });
      return merged;
    } catch (error) {
      this.commit({ ...this.current, refreshing: false, error: errorMessage(error) });
      throw error;
    }
  }

  async create(request: CreateTerminalRequest): Promise<TerminalSession> {
    this.assertAlive();
    const created = await this.backend.create(request);
    this.replaceOrAppend(created);
    this.select(created.id);
    return created;
  }

  async attach(id: TerminalId): Promise<void> {
    await this.attachGeneration(id, "attaching");
  }

  async reconnect(id: TerminalId): Promise<void> {
    const session = this.requireSession(id);
    if (!session.capabilities.reconnect) throw new Error(`${session.name} cannot reconnect`);
    await this.attachGeneration(id, "reconnecting");
  }

  async detach(id: TerminalId): Promise<void> {
    const session = this.requireSession(id);
    const generation = this.nextGeneration(id);
    this.attachments.get(id)?.attachment.close();
    this.attachments.delete(id);
    this.patchSession(id, {
      connection: {
        ...session.connection,
        status: "detached",
        generation,
        reconnectAttempt: 0,
        message: undefined,
      },
    });
    await this.backend.detach(session);
  }

  async terminate(id: TerminalId): Promise<void> {
    const session = this.requireSession(id);
    const generation = this.nextGeneration(id);
    this.attachments.get(id)?.attachment.close();
    this.attachments.delete(id);
    this.patchSession(id, {
      connection: { ...session.connection, status: "terminated", generation, message: "Terminating…" },
    });
    try {
      await this.backend.terminate(session);
      const sessions = this.current.sessions.filter((candidate) => candidate.id !== id);
      const selectedId = this.current.selectedId === id ? sessions[0]?.id : this.current.selectedId;
      this.commit({ ...this.current, sessions, selectedId, error: undefined });
    } catch (error) {
      this.patchSession(id, {
        connection: { ...session.connection, status: "error", generation, message: errorMessage(error) },
      });
      throw error;
    }
  }

  async rename(id: TerminalId, name: string): Promise<TerminalSession> {
    const session = this.requireSession(id);
    const renamed = await this.backend.rename(session, name.trim());
    this.nextGeneration(id);
    this.attachments.get(id)?.attachment.close();
    this.attachments.delete(id);
    const sessions = this.current.sessions.map((candidate) => candidate.id === id ? renamed : candidate);
    this.commit({
      ...this.current,
      sessions,
      selectedId: this.current.selectedId === id ? renamed.id : this.current.selectedId,
      error: undefined,
    });
    return renamed;
  }

  async capture(id: TerminalId, request: CaptureTerminalRequest = {}): Promise<TerminalCapture> {
    const session = this.requireSession(id);
    const captured = await this.backend.capture(session, request);
    this.patchSession(id, { snapshot: captured.snapshot, scrollback: captured.scrollback });
    return captured;
  }

  async loadOlder(id: TerminalId, lines?: number): Promise<TerminalCapture | undefined> {
    const session = this.requireSession(id);
    if (!session.capabilities.scrollbackPaging || !session.scrollback?.hasMore) return undefined;
    const older = await this.backend.capture(session, {
      lines: lines || session.scrollback.pageSize,
      before: session.scrollback.start,
    });
    const snapshot = joinTerminalPages(older.snapshot, session.snapshot);
    this.patchSession(id, { snapshot, scrollback: older.scrollback });
    return { ...older, snapshot };
  }

  async send(id: TerminalId, request: TerminalInputRequest): Promise<TerminalInputResult> {
    const session = this.requireSession(id);
    if (session.capabilities.send !== "input") {
      throw new TerminalAuthorizationError("send", `${session.name} is available read-only`);
    }
    try {
      const result = await this.backend.send(session, request);
      if (result.snapshot !== undefined) this.patchSession(id, { snapshot: result.snapshot });
      return result;
    } catch (error) {
      if (error instanceof TerminalAuthorizationError) {
        this.patchSession(id, {
          capabilities: { ...session.capabilities, send: "read-only" },
          connection: {
            ...session.connection,
            status: session.connection.status === "attached" ? "read-only" : session.connection.status,
            message: error.message,
          },
        });
      }
      throw error;
    }
  }

  async resize(id: TerminalId, size: TerminalSize): Promise<void> {
    const session = this.requireSession(id);
    if (!session.capabilities.resize) return;
    await this.backend.resize(session, {
      columns: Math.max(2, Math.floor(size.columns)),
      rows: Math.max(1, Math.floor(size.rows)),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [id, live] of this.attachments) {
      this.nextGeneration(id);
      live.attachment.close();
    }
    this.attachments.clear();
    this.listeners.clear();
  }

  private async attachGeneration(id: TerminalId, status: Extract<TerminalConnectionStatus, "attaching" | "reconnecting">): Promise<void> {
    this.assertAlive();
    const session = this.requireSession(id);
    if (!session.capabilities.attach) throw new Error(`${session.name} cannot attach`);
    const previousAttempt = session.connection.reconnectAttempt;
    const generation = this.nextGeneration(id);
    this.attachments.get(id)?.attachment.close();
    this.attachments.delete(id);
    this.patchSession(id, {
      connection: {
        ...session.connection,
        status,
        generation,
        reconnectAttempt: status === "reconnecting" ? previousAttempt + 1 : 0,
        message: undefined,
      },
    });

    const isCurrent = () => !this.disposed && this.generations.get(id) === generation;
    let closedBeforeRegistration = false;
    try {
      const attachment = await this.backend.attach(this.requireSession(id), {
        onOpen: () => {
          if (!isCurrent()) return;
          const active = this.requireSession(id);
          this.patchSession(id, {
            connection: {
              ...active.connection,
              status: active.capabilities.send === "input" ? "attached" : "read-only",
              generation,
              lastConnectedAt: Date.now(),
              message: active.capabilities.send === "input" ? undefined : "Viewing only — terminal input is not authorized",
            },
          });
        },
        onData: (data) => {
          if (!isCurrent()) return;
          const active = this.requireSession(id);
          this.patchSession(id, {
            liveOutput: appendLiveOutput(active.liveOutput, data),
            connection: { ...active.connection, lastDataAt: Date.now() },
          });
        },
        onSnapshot: (snapshot) => {
          if (!isCurrent()) return;
          const active = this.requireSession(id);
          this.patchSession(id, {
            snapshot,
            liveOutput: "",
            connection: { ...active.connection, lastDataAt: Date.now() },
          });
        },
        onClose: (event) => {
          if (!isCurrent()) return;
          closedBeforeRegistration = true;
          this.attachments.delete(id);
          const active = this.requireSession(id);
          const gone = event.code === 4404;
          this.patchSession(id, {
            connection: {
              ...active.connection,
              status: gone ? "terminated" : "reconnecting",
              generation,
              message: event.reason || (gone ? "The terminal no longer exists on its host" : "Connection interrupted"),
            },
          });
        },
        onError: (error) => {
          if (!isCurrent()) return;
          const active = this.requireSession(id);
          this.patchSession(id, {
            connection: { ...active.connection, status: "error", generation, message: error.message },
          });
        },
      });
      if (!isCurrent()) {
        attachment.close();
        return;
      }
      if (closedBeforeRegistration) {
        attachment.close();
        return;
      }
      this.attachments.set(id, { generation, attachment });
    } catch (error) {
      if (isCurrent()) {
        const active = this.requireSession(id);
        this.patchSession(id, {
          connection: { ...active.connection, status: "error", generation, message: errorMessage(error) },
        });
      }
      throw error;
    }
  }

  private replaceOrAppend(session: TerminalSession): void {
    const found = this.current.sessions.some((candidate) => candidate.id === session.id);
    const sessions = found
      ? this.current.sessions.map((candidate) => candidate.id === session.id ? session : candidate)
      : [...this.current.sessions, session];
    this.commit({ ...this.current, sessions, error: undefined });
  }

  private patchSession(id: TerminalId, patch: Partial<TerminalSession>): void {
    const sessions = this.current.sessions.map((session) => session.id === id ? { ...session, ...patch } : session);
    this.commit({ ...this.current, sessions });
  }

  private requireSession(id: TerminalId): TerminalSession {
    const session = this.current.sessions.find((candidate) => candidate.id === id);
    if (!session) throw new Error(`Unknown terminal: ${id}`);
    return session;
  }

  private nextGeneration(id: TerminalId): number {
    const generation = (this.generations.get(id) || 0) + 1;
    this.generations.set(id, generation);
    return generation;
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("Terminal coordinator has been disposed");
  }

  private commit(next: TerminalCoordinatorSnapshot): void {
    this.current = next;
    for (const listener of this.listeners) listener(next);
  }
}

function mergeDiscoveredSession(existing: TerminalSession, discovered: TerminalSession): TerminalSession {
  return {
    ...discovered,
    liveOutput: existing.liveOutput,
    scrollback: existing.scrollback || discovered.scrollback,
    connection: existing.connection,
    capabilities: existing.capabilities.send === "read-only" && discovered.capabilities.send === "input"
      ? { ...discovered.capabilities, send: "read-only" }
      : discovered.capabilities,
  };
}

function appendLiveOutput(current: string, data: string): string {
  const next = current + data;
  return next.length > MAX_LIVE_OUTPUT_CHARACTERS
    ? next.slice(next.length - MAX_LIVE_OUTPUT_CHARACTERS)
    : next;
}

function joinTerminalPages(older: string, newer: string): string {
  if (!older) return newer;
  if (!newer) return older;
  return `${older.replace(/\n+$/, "")}\n${newer.replace(/^\n+/, "")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
