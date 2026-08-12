import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { DecisionState, SessionViewState } from "../protocol";

const GOAL_DECISION_SECONDS = 60;
const BEST_JUDGMENT = "Use your best judgment according to the active goal";

interface Props {
  state: SessionViewState;
  onChoose: (choice: string) => Promise<void>;
}

export function goalAlignedRecommendedChoice(
  decision: Pick<DecisionState, "recommendedChoice" | "multiple"> | undefined,
  automaticDecisionMaking: boolean,
): string | undefined {
  return automaticDecisionMaking && decision && !decision.multiple
    ? decision.recommendedChoice
    : undefined;
}

export function decisionChoiceRows(
  decision: Pick<DecisionState, "choices" | "descriptions" | "recommendedChoice"> | undefined,
): Array<{ choice: string; description?: string; recommended: boolean }> {
  return (decision?.choices || []).map((choice, index) => ({
    choice,
    description: decision?.descriptions[index] || undefined,
    recommended: choice === decision?.recommendedChoice,
  }));
}

export function AttentionBar(props: Props) {
  const [submitting, setSubmitting] = createSignal<string>();
  const [customAnswer, setCustomAnswer] = createSignal("");
  const [selectedChoices, setSelectedChoices] = createSignal<string[]>([]);
  const [now, setNow] = createSignal(Date.now());
  const [autoDeadline, setAutoDeadline] = createSignal<number>();
  const [armedDecision, setArmedDecision] = createSignal("");
  const [autoSubmitted, setAutoSubmitted] = createSignal("");
  const approval = () => props.state.pendingApproval;
  const decision = () => props.state.pendingDecision;
  const choices = () => approval()?.options || decision()?.choices || [];
  const prompt = () => approval()?.prompt || decision()?.question || "Amplifier needs your input";
  const goalActive = () => props.state.autopilot
    || props.state.goal?.state === "armed"
    || props.state.goal?.state === "continuing";
  const automaticDecisionMaking = () => props.state.mode === "auto" || goalActive();
  const recommended = () => goalAlignedRecommendedChoice(decision(), automaticDecisionMaking());
  const automaticChoice = () => decision() && automaticDecisionMaking()
    ? recommended() || BEST_JUDGMENT
    : undefined;
  const expiresAt = () => approval()?.expiresAtMs || autoDeadline();
  const remainingSeconds = createMemo(() => {
    const deadline = expiresAt();
    return deadline ? Math.max(0, Math.ceil((deadline - now()) / 1_000)) : undefined;
  });

  createEffect(() => {
    const id = decision()?.decisionId;
    const choice = automaticChoice();
    const key = id && choice ? `${id}:${choice}` : "";
    if (key === armedDecision()) return;
    setArmedDecision(key);
    setAutoSubmitted("");
    setCustomAnswer("");
    setSelectedChoices([]);
    setAutoDeadline(id && choice ? Date.now() + GOAL_DECISION_SECONDS * 1_000 : undefined);
  });

  const timer = window.setInterval(() => setNow(Date.now()), 250);
  onCleanup(() => window.clearInterval(timer));

  const choose = async (choice: string) => {
    if (submitting() || !choice.trim()) return;
    setSubmitting(choice);
    try {
      await props.onChoose(choice);
    } finally {
      setSubmitting(undefined);
    }
  };

  createEffect(() => {
    const choice = automaticChoice();
    const key = choice ? `${decision()?.decisionId}:${choice}` : "";
    if (choice && key && key !== autoSubmitted() && remainingSeconds() === 0 && !submitting()) {
      setAutoSubmitted(key);
      void choose(choice);
    }
  });

  const countdownLabel = () => {
    const seconds = remainingSeconds();
    if (seconds === undefined) return undefined;
    if (approval()) return `${formatDuration(seconds)} until Amplifier applies ${approval()?.defaultChoice || "its safe default"}`;
    return automaticChoice()
      ? `${formatDuration(seconds)} until Amplifier ${recommended() ? "chooses the recommended option" : "continues using its goal-aligned judgment"}`
      : undefined;
  };

  const toggleChoice = (choice: string) => {
    if (!decision()?.multiple) {
      void choose(choice);
      return;
    }
    setSelectedChoices((selected) => selected.includes(choice)
      ? selected.filter((item) => item !== choice)
      : [...selected, choice]);
  };

  return (
    <div class="attention-bar" role="alertdialog" aria-live="assertive" aria-label="Amplifier requires a decision">
      <div class="attention-icon">!</div>
      <div class="attention-copy">
        <div class="eyebrow">{approval() ? "APPROVAL REQUIRED" : "DECISION REQUIRED"}</div>
        <strong>{prompt()}</strong>
        <Show when={decision()?.reason}><p>{decision()?.reason}</p></Show>
        <Show when={countdownLabel()}>{(label) => <p class="attention-countdown">{label()}</p>}</Show>
      </div>
      <div class="attention-actions">
        <For each={decision() ? decisionChoiceRows(decision()) : choices().map((choice) => ({ choice, description: undefined, recommended: false }))}>
          {(row) => (
            <div class="attention-choice">
              <button
                disabled={Boolean(submitting())}
                classList={{
                  primary: row.recommended || /allow once|yes|continue/i.test(row.choice),
                  danger: /deny|no|cancel|don't edit/i.test(row.choice),
                  selected: selectedChoices().includes(row.choice),
                }}
                aria-pressed={decision()?.multiple ? selectedChoices().includes(row.choice) : undefined}
                onClick={() => toggleChoice(row.choice)}
              >
                {submitting() === row.choice ? "Sending…" : row.choice}
              </button>
              <Show when={row.description}>
                {(description) => <small>{description()}</small>}
              </Show>
            </div>
          )}
        </For>
        <Show when={decision()?.multiple}>
          <button
            class="attention-multiple-submit primary"
            disabled={Boolean(submitting()) || selectedChoices().length === 0}
            onClick={() => void choose(selectedChoices().join(", "))}
          >Answer with {selectedChoices().length} selected</button>
        </Show>
        <Show when={decision() && (!recommended() || choices().length === 0)}>
          <button
            class="attention-best-judgment"
            disabled={Boolean(submitting())}
            onClick={() => void choose(BEST_JUDGMENT)}
          >Use Amplifier's best judgment</button>
        </Show>
        <Show when={decision()?.custom}>
          <form class="attention-custom" onSubmit={(event) => {
            event.preventDefault();
            void choose(customAnswer());
          }}>
            <input
              value={customAnswer()}
              disabled={Boolean(submitting())}
              onInput={(event) => setCustomAnswer(event.currentTarget.value)}
              placeholder="Or type your own answer"
              aria-label="Custom decision answer"
            />
            <button type="submit" disabled={Boolean(submitting()) || !customAnswer().trim()}>Answer</button>
          </form>
        </Show>
        <Show when={approval() && !choices().some((choice) => /deny/i.test(choice))}>
          <button class="danger" disabled={Boolean(submitting())} onClick={() => void choose("Deny")}>{submitting() === "Deny" ? "Sending…" : "Deny"}</button>
        </Show>
      </div>
      <span class="escape-hint">
        {automaticChoice() ? "Choose now to override Amplifier's goal-aligned default" : "Choose an action to continue"}
      </span>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}
