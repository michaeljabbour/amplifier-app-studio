import { createMemo, createSignal, Show } from "solid-js";
import type { CapabilityCatalog, NewSessionInput } from "../protocol";
import { toolContractFailure } from "../providerSafety";

interface Props {
  initial: NewSessionInput;
  catalog: CapabilityCatalog;
  catalogError?: string;
  nativeProjectPicker: boolean;
  onCancel: () => void;
  onPickProjectDir: (defaultPath?: string) => Promise<string | undefined>;
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
  const [pickingProject, setPickingProject] = createSignal(false);
  const overrideMismatch = createMemo(() => Boolean(model().trim()) !== Boolean(provider().trim()));
  const selectedProvider = createMemo(() => props.catalog.providers.find((item) => item.name === provider().trim()));
  const unsafeProvider = createMemo(() => selectedProvider()?.toolCompatible === false ? selectedProvider() : undefined);
  const unsafeOverride = createMemo(() => toolContractFailure(model(), provider()));

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
    if (unsafeProvider() || unsafeOverride()) {
      setError(unsafeProvider()?.warning || unsafeOverride() || "This provider does not pass Amplifier's tool-call contract.");
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
        capabilityId: props.initial.capabilityId,
        capabilityName: props.initial.capabilityName,
      });
    } catch (caught) {
      setError(String(caught));
      setStarting(false);
    }
  };

  const pickProject = async () => {
    if (pickingProject()) return;
    setPickingProject(true);
    setError("");
    try {
      const selected = await props.onPickProjectDir(projectDir());
      if (selected) setProjectDir(selected);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setPickingProject(false);
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

        <Show when={props.initial.capabilityName}>
          <div class="capability-selection">
            <span>SESSION SETUP</span>
            <strong>{props.initial.capabilityName}</strong>
            <p>Studio will start this capability as an isolated Amplifier runtime. Your coordinator and other sessions stay available.</p>
          </div>
        </Show>

        <Show when={props.catalogError} keyed>{(message) => (
          <div class="catalog-discovery-warning" role="status">
            Installed bundles and provider routes could not be discovered: {message}. You may enter explicit values under Advanced composition.
          </div>
        )}</Show>

        <div class="field full-field">
          <span>{props.initial.resumeId ? "Original project folder" : "Project folder"}</span>
          <div class="path-picker-control">
            <input
              value={projectDir()}
              readOnly={props.nativeProjectPicker}
              onInput={(event) => setProjectDir(event.currentTarget.value)}
              placeholder={props.nativeProjectPicker ? "Choose a folder…" : "/runtime-host/project"}
              aria-label="Selected project folder"
            />
            <Show when={props.nativeProjectPicker}>
              <button type="button" class="secondary-button" disabled={pickingProject()} onClick={() => void pickProject()}>
                {pickingProject() ? "Choosing…" : "Choose folder…"}
              </button>
            </Show>
          </div>
          <small>{props.nativeProjectPicker
            ? "Studio uses the system folder picker. The Amplifier runtime starts in the selected folder."
            : "Enter a folder on the configured runtime host; its operating-system picker is not available to this client."}</small>
        </div>

        <details class="advanced-composition" open={!props.initial.capabilityName && !props.initial.resumeId}>
          <summary>Advanced composition <span>bundle · mode · provider · model</span></summary>
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
              {props.catalog.providers.map((option) => <option value={option.name} disabled={!option.toolCompatible}>{option.model}{option.toolCompatible ? "" : " · text experiment only"}</option>)}
            </datalist>
          </label>
          <label class="field">
            <span>Model override <em>optional</em></span>
            <input value={model()} onInput={(event) => setModel(event.currentTarget.value)} placeholder="claude-fable-5" />
          </label>
          </div>
          <Show when={unsafeProvider()} keyed>{(option) => <div class="form-error provider-contract-warning"><strong>{option.name} cannot run this machine safely.</strong> {option.warning}</div>}</Show>
          <Show when={!unsafeProvider() && unsafeOverride()} keyed>{(warning) => <div class="form-error provider-contract-warning"><strong>This model cannot run Amplifier tools safely.</strong> {warning}</div>}</Show>
        </details>

        <Show when={error()}><div class="form-error">{error()}</div></Show>

        <div class="dialog-footer">
          <div class="process-note"><span>◆</span> One isolated Amplifier runtime will be created for this tab.</div>
          <button type="button" class="secondary-button" onClick={props.onCancel}>Cancel</button>
          <button type="submit" class="primary-button" disabled={starting() || overrideMismatch() || Boolean(unsafeProvider()) || Boolean(unsafeOverride())}>
            {starting() ? "Starting…" : props.initial.resumeId ? "Resume" : "Start session"}
          </button>
        </div>
      </form>
    </div>
  );
}
