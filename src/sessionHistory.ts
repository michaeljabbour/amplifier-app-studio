import type { ProtocolRecord } from "./protocol";

export type HistoryOperation = "history.outline" | "history.window";

interface PendingRead {
  requestId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (record: ProtocolRecord) => void;
  reject: (error: Error) => void;
}

/** Correlates read-only navigation without delivering records to session replay. */
export function createSessionHistoryReader(send: (guiId: string, op: Record<string, unknown>) => Promise<void>) {
  const pending = new Map<string, PendingRead>();
  const cancel = (key: string, message: string) => {
    const read = pending.get(key);
    if (!read) return;
    clearTimeout(read.timer);
    pending.delete(key);
    read.reject(new Error(message));
  };
  return {
    request(guiId: string, op: HistoryOperation, args: Record<string, unknown> = {}): Promise<ProtocolRecord> {
      const key = `${guiId}:${op}`;
      cancel(key, "A newer history request replaced this one");
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => cancel(key, "History did not respond. Check the connection and try again."), 15_000);
        pending.set(key, { requestId, timer, resolve, reject });
        void send(guiId, { ...args, op, request_id: requestId }).catch((error: unknown) => {
          if (pending.get(key)?.requestId === requestId) cancel(key, String(error).replace(/^Error:\s*/, ""));
        });
      });
    },
    accept(guiId: string, record: ProtocolRecord): boolean {
      if (record.type !== "history.outline" && record.type !== "history.window") return false;
      const key = `${guiId}:${record.type}`;
      const read = pending.get(key);
      if (!read || read.requestId !== record.request_id) return true;
      clearTimeout(read.timer);
      pending.delete(key);
      if (record.ok === true) read.resolve(record);
      else read.reject(new Error(typeof record.error === "string" ? record.error : "Conversation navigation is unavailable for this session."));
      return true;
    },
    cancelSession(guiId: string): void {
      for (const op of ["history.outline", "history.window"]) cancel(`${guiId}:${op}`, "History view closed");
    },
    dispose(): void {
      for (const key of pending.keys()) cancel(key, "Studio closed");
    },
  };
}

export interface ConversationEntry {
  eventId: string;
  kind: "prompt_submit" | "prompt_complete";
  text: string;
}

/** Extracts only public conversation text from the navigation response. */
export function conversationEntries(record: ProtocolRecord, field: "entries" | "records"): ConversationEntry[] {
  const values = record[field];
  if (!Array.isArray(values)) throw new Error("The runtime returned an invalid conversation page");
  return values.map((value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("The runtime returned an invalid conversation entry");
    const item = value as Record<string, unknown>;
    if (typeof item.event_id !== "string" || (item.kind !== "prompt_submit" && item.kind !== "prompt_complete")) {
      throw new Error("The runtime returned an unsupported conversation entry");
    }
    const text = field === "entries" ? item.preview : item.kind === "prompt_submit" ? item.prompt : item.response;
    if (typeof text !== "string") throw new Error("The runtime returned conversation text in an unsupported format");
    return { eventId: item.event_id, kind: item.kind, text };
  });
}
