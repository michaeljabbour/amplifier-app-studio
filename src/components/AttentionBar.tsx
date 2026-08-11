import { For, Show } from "solid-js";
import type { SessionViewState } from "../protocol";

interface Props {
  state: SessionViewState;
  onChoose: (choice: string) => void;
}

export function AttentionBar(props: Props) {
  const approval = () => props.state.pendingApproval;
  const decision = () => props.state.pendingDecision;
  const choices = () => approval()?.options || decision()?.choices || [];
  const prompt = () => approval()?.prompt || decision()?.question || "Amplifier needs your input";

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
            <button classList={{ primary: /allow once|yes|continue/i.test(choice), danger: /deny|no|cancel/i.test(choice) }} onClick={() => props.onChoose(choice)}>
              {choice}
            </button>
          )}
        </For>
        <Show when={approval() && !choices().some((choice) => /deny/i.test(choice))}>
          <button class="danger" onClick={() => props.onChoose("Deny")}>Deny</button>
        </Show>
      </div>
      <span class="escape-hint">Esc denies</span>
    </div>
  );
}
