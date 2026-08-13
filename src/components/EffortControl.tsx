import { createSignal, onCleanup, Show } from "solid-js";
import { DEFAULT_EFFORT_LEVELS, type SessionViewState } from "../protocol";

export function EffortControl(props: {
  state: SessionViewState;
  onCycle: () => void;
  onSet: (effort: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [preview, setPreview] = createSignal(0);
  let holdTimer: number | undefined;
  let held = false;

  const levels = () => props.state.effortLevels.length ? props.state.effortLevels : [...DEFAULT_EFFORT_LEVELS];
  const currentIndex = () => Math.max(0, levels().indexOf(props.state.effort || "none"));
  const previewLevel = () => levels()[preview()] || levels()[currentIndex()] || "none";
  const current = () => props.state.effort || "runtime default";
  const controlLabel = () => props.state.effortPending
    ? `Amplifier effort is ${current()}; waiting for runtime confirmation of ${props.state.effortPending}`
    : props.state.effortConfirmedAtMs
      ? `Amplifier runtime confirmed effort ${current()}`
      : `Amplifier effort is ${current()}`;

  const cancelTimer = () => {
    if (holdTimer !== undefined) window.clearTimeout(holdTimer);
    holdTimer = undefined;
  };
  onCleanup(cancelTimer);

  return (
    <div class="effort-control" onFocusOut={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}>
      <button
        classList={{ pending: Boolean(props.state.effortPending) }}
        title={`${controlLabel()}. Click to cycle; press and hold to choose an exact level.`}
        aria-label={controlLabel()}
        aria-haspopup="dialog"
        aria-expanded={open()}
        onPointerDown={() => {
          held = false;
          cancelTimer();
          holdTimer = window.setTimeout(() => {
            held = true;
            setPreview(currentIndex());
            setOpen(true);
          }, 340);
        }}
        onPointerUp={cancelTimer}
        onPointerCancel={cancelTimer}
        onClick={() => {
          if (held) {
            held = false;
            return;
          }
          props.onCycle();
        }}
      >
        effort <strong>{current()}</strong>
        <Show
          when={props.state.effortPending}
          fallback={<Show when={props.state.effortConfirmedAtMs}><span class="effort-confirmed">runtime ✓</span></Show>}
        >
          {(pending) => <><span class="effort-request">→ {pending()}</span><span class="effort-pending" aria-hidden="true" /></>}
        </Show>
      </button>
      <Show when={open()}>
        <div class="effort-popover" role="dialog" aria-label="Choose Amplifier effort">
          <div><span>EFFORT</span><strong>{previewLevel()}</strong></div>
          <input
            type="range"
            min="0"
            max={Math.max(0, levels().length - 1)}
            step="1"
            value={preview()}
            aria-label="Amplifier effort level"
            onInput={(event) => setPreview(Number(event.currentTarget.value))}
            onChange={() => {
              props.onSet(previewLevel());
              setOpen(false);
            }}
          />
          <div class="effort-ticks"><span>{levels()[0]}</span><span>{levels().at(-1)}</span></div>
        </div>
      </Show>
    </div>
  );
}
