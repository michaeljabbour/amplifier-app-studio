import { createMemo, createSignal, Show } from "solid-js";
import type { CapabilityCatalog, NewSessionInput } from "../protocol";

interface Props {
  initial: NewSessionInput;
  catalog: CapabilityCatalog;
  onCancel: () => void;
  onStart: (input: NewSessionInput) => Promise<void>;
}

export function NewSessionDialog(props: Props) {
  const [projectDir, setProjectDir] = createSignal(props.initial.projectDir);
  const [bundle, setBundle] = createSignal(props.initial.bundle || "");
  const [model, setModel] = createSignal(props.initial.model || "");
  const [provider, setProvider] = createSignal(props.initial.provider || "");
  const [mode, setMode] = createSignal(props.initial.mode || "");
  const [error, setError] = createSignal("");
  const [starting, setStarting] = createSignal(false);
  const overrideMismatch = createMemo(() => Boolean(model().trim()) !== Boolean(provider().trim()));

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!projectDir().trim()) {
      setError("Choose the project directory this session may work in.");
      return;
    }
    if (overrideMismatch()) {
      setError("Model and provider overrides must be supplied together.");
      return;
    }
    setStarting(true);
    setError("");
    try {
      await props.onStart({
        projectDir: projectDir().trim(),
        bundle: bundle().trim() || undefined,
        model: model().trim() || undefined,
        provider: provider().trim() || undefined,
        mode: mode() || undefined,
        resumeId: props.initial.resumeId,
        resumeName: props.initial.resumeName,
      });
    } catch (caught) {
      setError(String(caught));
      setStarting(false);
    }
  };

  return (
    <div class="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && props.onCancel()}>
      <form class="session-dialog" onSubmit={submit}>
        <div class="dialog-heading">
          <div>
            <div class="eyebrow">{props.initial.resumeId ? "RESTORE WORK" : "PARALLEL RUNTIME"}</div>
            <h2>{props.initial.resumeId ? "Resume session" : "Start a new session"}</h2>
          </div>
          <button type="button" class="icon-button" aria-label="Close dialog" onClick={props.onCancel}>×</button>
        </div>

        <Show when={props.initial.resumeId}>
          <div class="resume-chip">
            <span class="resume-icon">↺</span>
            <div><strong>{props.initial.resumeName || props.initial.resumeId}</strong><code>{props.initial.resumeId}</code></div>
          </div>
        </Show>

        <label class="field full-field">
          <span>Project directory</span>
          <input value={projectDir()} onInput={(event) => setProjectDir(event.currentTarget.value)} placeholder="/Users/you/dev/project" autofocus />
          <small>The child process runs here; Amplifier’s existing filesystem boundaries still apply.</small>
        </label>

        <div class="field-grid">
          <label class="field">
            <span>Bundle <em>optional</em></span>
            <input list="amplifier-bundles" value={bundle()} onInput={(event) => setBundle(event.currentTarget.value)} placeholder={props.initial.resumeId ? "Use stored bundle" : "Use active bundle"} />
            <datalist id="amplifier-bundles">
              {props.catalog.bundles.map((option) => <option value={option.name}>{option.active ? "Active" : option.status}</option>)}
            </datalist>
          </label>
          <label class="field">
            <span>Mode <em>optional</em></span>
            <select value={mode()} onChange={(event) => setMode(event.currentTarget.value)}>
              <option value="">Amplifier default (Auto)</option>
              <option value="chat">Chat</option>
              <option value="build">Build</option>
              <option value="plan">Plan</option>
              <option value="brainstorm">Brainstorm</option>
              <option value="auto">Auto</option>
            </select>
          </label>
          <label class="field">
            <span>Provider override <em>optional</em></span>
            <input
              list="amplifier-providers"
              value={provider()}
              onInput={(event) => {
                const value = event.currentTarget.value;
                setProvider(value);
                const option = props.catalog.providers.find((item) => item.name === value);
                if (option?.model) setModel(option.model);
              }}
              placeholder="anthropic"
            />
            <datalist id="amplifier-providers">
              {props.catalog.providers.map((option) => <option value={option.name}>{option.model}</option>)}
            </datalist>
          </label>
          <label class="field">
            <span>Model override <em>optional</em></span>
            <input value={model()} onInput={(event) => setModel(event.currentTarget.value)} placeholder="claude-fable-5" />
          </label>
        </div>

        <Show when={error()}><div class="form-error">{error()}</div></Show>

        <div class="dialog-footer">
          <div class="process-note"><span>◆</span> One isolated Amplifier runtime will be created for this tab.</div>
          <button type="button" class="secondary-button" onClick={props.onCancel}>Cancel</button>
          <button type="submit" class="primary-button" disabled={starting() || overrideMismatch()}>
            {starting() ? "Starting…" : props.initial.resumeId ? "Resume" : "Start session"}
          </button>
        </div>
      </form>
    </div>
  );
}
