import { onMount, Show } from "solid-js";
import type { SessionViewState } from "../protocol";
import { stopRuntimeActivity } from "../sessionLifecycle";

interface Props {
  session: SessionViewState;
  stopping: boolean;
  error?: string;
  onCancel: () => void;
  onDetach: () => void;
  onStop: () => void;
}

export function SessionLifecycleDialog(props: Props) {
  const activity = () => stopRuntimeActivity(props.session);
  let cancelButton: HTMLButtonElement | undefined;

  onMount(() => cancelButton?.focus());

  const cancel = () => {
    if (!props.stopping) props.onCancel();
  };

  const keepFocusInside = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      cancel();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = (event.currentTarget as HTMLElement).querySelector<HTMLElement>('[role="alertdialog"]');
    const controls = dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])');
    if (!controls?.length) return;
    const first = controls.item(0);
    const last = controls.item(controls.length - 1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      class="modal-backdrop session-lifecycle-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && cancel()}
      onKeyDown={keepFocusInside}
    >
      <section
        class="session-lifecycle-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="session-lifecycle-title"
        aria-describedby="session-lifecycle-description"
      >
        <header>
          <div>
            <span class="eyebrow">SESSION LIFECYCLE</span>
            <h2 id="session-lifecycle-title">Stop Amplifier runtime?</h2>
          </div>
          <button type="button" class="icon-button" aria-label="Keep session open" disabled={props.stopping} onClick={cancel}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
          </button>
        </header>

        <div class="session-lifecycle-body">
          <p id="session-lifecycle-description">
            Closing a view and stopping its runtime are different actions. Detach keeps the runtime available; Stop ends the underlying process.
          </p>
          <div class={`session-lifecycle-activity ${activity().tone}`} role="status" aria-live="polite">
            <i aria-hidden="true" />
            <div><strong>{activity().label}</strong><span>{activity().detail}</span></div>
          </div>
          <dl class="session-lifecycle-context">
            <div><dt>Session</dt><dd>{props.session.title}</dd></div>
            <div><dt>Compute</dt><dd>{props.session.hostName || (props.session.hostId === "local" || !props.session.hostId ? "This computer" : props.session.hostId)}</dd></div>
          </dl>
          <Show when={props.error} keyed>{(message) => (
            <div class="session-lifecycle-error" role="alert">
              <strong>Runtime did not stop</strong>
              <span>{message}</span>
              <small>The session and connection are still open. Retry the stop or detach only this view.</small>
            </div>
          )}</Show>
        </div>

        <footer>
          <button ref={cancelButton} type="button" class="secondary-button" disabled={props.stopping} onClick={cancel}>
            {props.error ? "Keep session open" : "Cancel"}
          </button>
          <button type="button" class="secondary-button detach-button" disabled={props.stopping} onClick={props.onDetach}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 7 6 6M13 7l-2 2M7 13l2-2M5 3l12 14" /></svg> Detach view
          </button>
          <button type="button" class="danger-button" disabled={props.stopping} onClick={props.onStop}>
            {props.stopping ? "Stopping runtime…" : props.error ? "Retry stop" : "Stop runtime"}
          </button>
        </footer>
      </section>
    </div>
  );
}
