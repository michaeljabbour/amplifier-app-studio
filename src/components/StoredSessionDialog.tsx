import { createSignal, Show } from "solid-js";
import { Copy, MonitorUp, X } from "lucide-solid";
import type { StoredSession } from "../protocol";
import { storedSessionCanDuplicate, storedSessionResumeBlocker, storedSessionWarning } from "../sessionAvailability";

interface Props {
  session: StoredSession;
  sessionHomeName: string;
  resumeDisabledReason?: string;
  onClose: () => void;
  onResume: () => Promise<void>;
  onDuplicate: () => Promise<void>;
}

export function StoredSessionDialog(props: Props) {
  const [busy, setBusy] = createSignal<"resume" | "duplicate">();
  const [error, setError] = createSignal<string>();
  const blocker = () => props.resumeDisabledReason || storedSessionResumeBlocker(props.session, false);
  const warning = () => storedSessionWarning(props.session);
  const canDuplicate = () => storedSessionCanDuplicate(props.session) && Boolean(props.session.projectDir);
  const origin = () => props.session.hostName || "This computer";

  const run = async (action: "resume" | "duplicate", task: () => Promise<void>) => {
    if (busy()) return;
    setBusy(action);
    setError(undefined);
    try {
      await task();
    } catch (caught) {
      setError(String(caught).replace(/^Error:\s*/, ""));
      setBusy(undefined);
    }
  };

  return (
    <div class="modal-backdrop stored-session-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy() && props.onClose()}>
      <section class="stored-session-dialog" role="dialog" aria-modal="true" aria-labelledby="stored-session-title">
        <header>
          <div><span class="eyebrow">DURABLE SESSION</span><h2 id="stored-session-title">{props.session.name}</h2></div>
          <button type="button" class="icon-button" aria-label="Close session options" disabled={Boolean(busy())} onClick={props.onClose}><X /></button>
        </header>

        <div class="stored-session-origin">
          <div><span>Stored on</span><strong>{origin()}</strong></div>
          <div><span>Project</span><strong>{props.session.projectDir || props.session.projectSlug}</strong></div>
          <div><span>Conversation</span><strong>{props.session.messageCount} messages · {props.session.turnCount ?? "—"} turns</strong></div>
        </div>

        <Show when={blocker() || warning()} keyed>{(message) => <p class="stored-session-health">{message}</p>}</Show>
        <Show when={error()} keyed>{(message) => <div class="drawer-error" role="alert">{message}</div>}</Show>

        <div class="stored-session-choices">
          <button
            type="button"
            disabled={Boolean(blocker()) || Boolean(busy())}
            onClick={() => void run("resume", props.onResume)}
          >
            <MonitorUp aria-hidden="true" />
            <span><strong>{busy() === "resume" ? "Opening…" : `Resume on ${origin()}`}</strong><small>Continue the original durable session on the compute that owns it.</small></span>
          </button>
          <button
            type="button"
            class="primary"
            disabled={!canDuplicate() || Boolean(busy())}
            onClick={() => void run("duplicate", props.onDuplicate)}
          >
            <Copy aria-hidden="true" />
            <span><strong>{busy() === "duplicate" ? "Duplicating…" : `Duplicate to ${props.sessionHomeName}`}</strong><small>Create a new resumable checkpoint there; the original remains unchanged.</small></span>
          </button>
        </div>

        <Show when={!canDuplicate()}>
          <p class="stored-session-limit">
            {props.session.projectDir
              ? "There is no intact conversation checkpoint to duplicate."
              : "Studio could not resolve the original project path, so it cannot safely locate this checkpoint."}
          </p>
        </Show>
        <p class="stored-session-footnote">A duplicate transfers conversation and metadata, not a running process, UI telemetry, or provider credentials.</p>
      </section>
    </div>
  );
}
