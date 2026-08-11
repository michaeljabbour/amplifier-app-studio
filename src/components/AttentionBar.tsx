import { createSignal, For, Show } from "solid-js";
import type { SessionViewState } from "../protocol";

interface Props {
  state: SessionViewState;
  onChoose: (choice: string) => Promise<void>;
}

export function AttentionBar(props: Props) {
  const [submitting, setSubmitting] = createSignal<string>();
  const approval = () => props.state.pendingApproval;
  const decision = () => props.state.pendingDecision;
  const choices = () => approval()?.options || decision()?.choices || [];
  const prompt = () => approval()?.prompt || decision()?.question || "Amplifier needs your input";
  const choose = async (choice: string) => {
    if (submitting()) return;
    setSubmitting(choice);
    try {
      await props.onChoose(choice);
    } finally {
      setSubmitting(undefined);
    }
  };

  return (
    <div class="attention-bar" role="alertdialog" aria-live="assertive" aria-label="Amplifier requires a decision">
      <div class="attention-icon">!</div>
      <div class="attention-copy">
        <div class="eyebrow">{approval() ? "APPROVAL REQUIRED" : "DECISION REQUIRED"}</div>
        <strong>{prompt()}</strong>
        <Show when={decision()?.reason}><p>{decision()?.reason}</p></Show>
      </div>
      <div class="attention-actions">
        <For each={choices()}>
          {(choice) => (
            <button disabled={Boolean(submitting())} classList={{ primary: /allow once|yes|continue/i.test(choice), danger: /deny|no|cancel/i.test(choice) }} onClick={() => void choose(choice)}>
              {submitting() === choice ? "Sending…" : choice}
            </button>
          )}
        </For>
        <Show when={approval() && !choices().some((choice) => /deny/i.test(choice))}>
          <button class="danger" disabled={Boolean(submitting())} onClick={() => void choose("Deny")}>{submitting() === "Deny" ? "Sending…" : "Deny"}</button>
        </Show>
      </div>
      <span class="escape-hint">Choose an action to continue</span>
    </div>
  );
}
