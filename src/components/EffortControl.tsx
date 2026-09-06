import { popoverDismiss } from "./popoverDismiss";
import { createEffect, createSignal, For, Show } from "solid-js";
import { DEFAULT_EFFORT_LEVELS, type SessionViewState } from "../protocol";

export function EffortControl(props: {
  state: SessionViewState;
  onCycle: () => void;
  onSet: (effort: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  let popoverRoot: HTMLDivElement | undefined;
  const dismiss = popoverDismiss(() => popoverRoot, open, () => setOpen(false));
  let sessionId: string | undefined;
  createEffect(() => { const id = props.state.guiId; if (id !== sessionId) setOpen(false); sessionId = id; });
  const levels = () => props.state.effortLevels.length ? props.state.effortLevels : [...DEFAULT_EFFORT_LEVELS];
  const current = () => props.state.effort || "runtime default";
  const controlLabel = () => props.state.effortPending
    ? `Amplifier effort is ${current()}; waiting for runtime confirmation of ${props.state.effortPending}`
    : props.state.effortConfirmedAtMs
      ? `Amplifier runtime confirmed effort ${current()}`
      : `Amplifier effort is ${current()}`;

  return (
    <div ref={popoverRoot} class="effort-control" onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); event.currentTarget.querySelector("button")?.focus(); } }} onFocusOut={dismiss}>
      <button
        classList={{ pending: Boolean(props.state.effortPending) }}
        title={`${controlLabel()}. Choose reasoning effort.`}
        aria-label={controlLabel()}
        aria-haspopup="dialog"
        aria-expanded={open()}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
      >
        reasoning <strong>{props.state.effort || "default"}</strong><span aria-hidden="true">⌃</span>
        <Show
          when={props.state.effortPending}
          fallback={<Show when={props.state.effortConfirmedAtMs}><span class="effort-confirmed">runtime ✓</span></Show>}
        >
          {(pending) => <><span class="effort-request">→ {pending()}</span><span class="effort-pending" aria-hidden="true" /></>}
        </Show>
      </button>
      <Show when={open()}>
        <div class="effort-popover" role="dialog" aria-label="Choose Amplifier effort">
          <strong>Reasoning effort</strong>
          <For each={levels()}>{(level) => <button type="button" aria-pressed={props.state.effort === level} disabled={Boolean(props.state.effortPending)} onClick={() => { props.onSet(level); setOpen(false); }}>{level}<Show when={props.state.effort === level}> ✓</Show></button>}</For>
        </div>
      </Show>
    </div>
  );
}
