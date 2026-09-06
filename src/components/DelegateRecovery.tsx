import { createSignal, Show } from "solid-js";
import type { LaneState, SessionViewState } from "../protocol";
import { delegateRecoveryInstruction } from "../delegateRecovery";
import { Markdown } from "./Markdown";

export function DelegateRecovery(props: { state: SessionViewState; lane: LaneState }) {
  const instruction = () => delegateRecoveryInstruction(props.state, props.lane);
  const [message, setMessage] = createSignal("");
  return <Show when={props.lane.status === "incomplete"}>
    <section class="delegate-recovery" aria-label="Incomplete delegate work">
      <h3>Partial work</h3>
      <Show when={props.lane.partialResult} fallback={<p>No partial result was retained.</p>}>{(text) => <Markdown text={text()} />}</Show>
      <Show when={instruction()}>{(text) => <>
        <p>Copy this instruction and send it to the coordinator in this parent session. Copying does not resume the delegate; the coordinator must check whether recovery is available.</p>
        <textarea aria-label="Delegate recovery instruction" readOnly value={text()} rows={4} />
        <button type="button" onClick={async () => {
          try { await navigator.clipboard.writeText(text()); setMessage("Instruction copied"); }
          catch { setMessage("Select and copy the instruction above"); }
        }}>Copy recovery instruction</button>
        <Show when={message()}><p role="status">{message()}</p></Show>
      </>}</Show>
    </section>
  </Show>;
}
