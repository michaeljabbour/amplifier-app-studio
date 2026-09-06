import type { ProtocolRecord } from "./protocol";

export interface InputReceipt {
  guiId: string;
  inputId: string;
  op: "submit" | "steer";
  text: string;
  stage: "unconfirmed" | "dispatched" | "queued" | "rejected" | "unknown";
}

export class InputDispatchUnconfirmed extends Error {}

/** Retains local input text until receipt review; status reads never resend input. */
export function createInputReceipts(send: (guiId: string, op: Record<string, unknown>) => Promise<void>, changed: (items: InputReceipt[]) => void) {
  const items = new Map<string, InputReceipt>();
  const queries = new Map<string, string>();
  const publish = () => changed([...items.values()]);
  return {
    async send(guiId: string, op: Record<string, unknown>, supported: boolean): Promise<void> {
      if (!supported || (op.op !== "submit" && op.op !== "steer")) return send(guiId, op);
      const existing = [...items.values()].filter((item) => item.guiId === guiId);
      if (existing.length >= 32) {
        const confirmed = existing.find((item) => item.stage === "dispatched" || item.stage === "queued" || item.stage === "rejected");
        if (!confirmed) throw new Error("Review unresolved input receipts before sending more input.");
        items.delete(confirmed.inputId);
        queries.delete(confirmed.inputId);
      }
      const inputId = crypto.randomUUID();
      items.set(inputId, { guiId, inputId, op: op.op, text: typeof op.text === "string" ? op.text : "", stage: "unconfirmed" });
      publish();
      try { await send(guiId, { ...op, request_id: inputId, idem: inputId }); }
      catch (error) { throw new InputDispatchUnconfirmed(`Input acceptance is unconfirmed: ${String(error).replace(/^Error:\s*/, "")}. Check history before sending again.`); }
    },
    accept(guiId: string, record: ProtocolRecord): boolean {
      if (record.type !== "input.result" && record.type !== "input.status") return false;
      const id = typeof record.input_id === "string" ? record.input_id : "";
      const item = items.get(id);
      if (!item || item.guiId !== guiId) return true;
      if (record.type === "input.result" && record.request_id !== id) return true;
      if (record.type === "input.status" && queries.get(id) !== record.request_id) return true;
      queries.delete(id);
      const stage = record.stage;
      if (stage === "dispatched" || stage === "queued" || stage === "rejected") item.stage = stage;
      else if (stage === "unknown" || stage === "unknown_previous_instance") item.stage = "unknown";
      else return true;
      publish();
      return true;
    },
    recheck(guiId: string): void {
      for (const item of items.values()) {
        if (item.guiId !== guiId || item.stage === "rejected") continue;
        const requestId = crypto.randomUUID();
        queries.set(item.inputId, requestId);
        void send(guiId, { op: "input.status", input_id: item.inputId, request_id: requestId }).catch(() => {
          // The retained input remains unconfirmed until another explicit status check.
        });
      }
    },
    dismiss(inputId: string): void { items.delete(inputId); queries.delete(inputId); publish(); },
  };
}
