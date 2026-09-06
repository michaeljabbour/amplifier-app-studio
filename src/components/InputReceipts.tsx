import { createSignal, For, Show } from "solid-js";
import type { InputReceipt } from "../inputReceipts";

export function InputReceipts(props: { items: InputReceipt[]; onDismiss: (id: string) => void; onCheck: () => void }) {
  const [message, setMessage] = createSignal("");
  const label = (item: InputReceipt) => item.stage === "dispatched" ? "Runtime dispatched this input. This receipt does not confirm model execution."
    : item.stage === "queued" ? "Runtime queued this steer. This receipt does not confirm consumption."
    : item.stage === "rejected" ? "Runtime rejected this input. Review it before sending again."
    : item.stage === "unknown" ? "Runtime cannot confirm this input. Check conversation history before sending again."
    : "Input sent; Runtime acceptance is unconfirmed. Check history before sending again.";
  return <Show when={props.items.length}><section class="input-receipts" aria-label="Input delivery receipts"><For each={props.items}>{(item) => <details class="input-receipt" open={item.stage === "unknown" || item.stage === "rejected"}>
    <summary>{label(item)}</summary>
    <p>The retained text below is available to copy. No input is sent by checking its status.</p>
    <textarea aria-label="Retained input" readOnly value={item.text} rows={3} />
    <button type="button" onClick={() => void navigator.clipboard.writeText(item.text).then(() => setMessage("Input text copied")).catch(() => setMessage("Select and copy the retained text above"))}>Copy retained text</button>
    <button type="button" onClick={props.onCheck}>Check status</button>
    <button type="button" onClick={() => props.onDismiss(item.inputId)}>Dismiss receipt</button>
  </details>}</For><Show when={message()}><p role="status">{message()}</p></Show></section></Show>;
}
