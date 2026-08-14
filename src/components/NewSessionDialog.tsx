import { createMemo, createSignal, For, Show } from "solid-js";
import type { CapabilityCatalog, NewSessionInput } from "../protocol";
import { toolContractFailure } from "../providerSafety";
import { listHostDirectories, type HostDirectoryListing, type RuntimeHost } from "../transport";

interface Props {
  initial: NewSessionInput;
  catalog: CapabilityCatalog;
  catalogError?: string;
  hosts: RuntimeHost[];
  nativeProjectPicker: boolean;
  onCancel: () => void;
  onPickProjectDir: (defaultPath?: string) => Promise<string | undefined>;
  onHostChange: (host: RuntimeHost) => Promise<void>;
  onStart: (input: NewSessionInput) => Promise<void>;
}

export function NewSessionDialog(props: Props) {
  const [projectDir, setProjectDir] = createSignal(props.initial.projectDir);
  const [hostId, setHostId] = createSignal(props.initial.hostId || props.hosts[0]?.id || "local");
  const [bundle, setBundle] = createSignal(props.initial.bundle || "");
  const [model, setModel] = createSignal(props.initial.model || "");
  const [provider, setProvider] = createSignal(props.initial.provider || "");
  const [mode, setMode] = createSignal(props.initial.mode || "");
  const [error, setError] = createSignal("");
  const [starting, setStarting] = createSignal(false);
  const [pickingProject, setPickingProject] = createSignal(false);
  const [remoteDirectories, setRemoteDirectories] = createSignal<HostDirectoryListing>();
  const overrideMismatch = createMemo(() => Boolean(model().trim()) !== Boolean(provider().trim()));
  const selectedProvider = createMemo(() => props.catalog.providers.find((item) => item.name === provider().trim()));
  const unsafeProvider = createMemo(() => selectedProvider()?.toolCompatible === false ? selectedProvider() : undefined);
  const unsafeOverride = createMemo(() => toolContractFailure(model(), provider()));
  const selectedHost = createMemo(() => props.hosts.find((host) => host.id === hostId()) || props.hosts[0]);
  const nativeProjectPicker = createMemo(() => props.nativeProjectPicker && !selectedHost()?.url);

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
        hostId: selectedHost()?.id,
        hostName: selectedHost()?.name,
        hostUrl: selectedHost()?.url || undefined,
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

  const browseRemote = async (path?: string) => {
    const host = selectedHost();
    if (!host?.url || pickingProject()) return;
    setPickingProject(true);
    setError("");
    try {
      const listing = await listHostDirectories(host.url, path, host.id);
      setRemoteDirectories(listing);
      if (!projectDir()) setProjectDir(listing.path);
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

        <label class="field full-field">
          <span>Runtime host</span>
          <select
            value={hostId()}
            onChange={(event) => {
              const next = props.hosts.find((host) => host.id === event.currentTarget.value);
              if (!next) return;
              setHostId(next.id);
              setProjectDir(next.defaultProjectRoot || "");
              setRemoteDirectories(undefined);
              void props.onHostChange(next).catch((caught) => setError(String(caught)));
            }}
          >
            {props.hosts.map((host) => <option value={host.id}>{host.name}{host.url ? ` · ${host.url}` : " · local"}</option>)}
          </select>
          <small>Every tab is pinned to one host. Switching tabs does not move or stop its runtime.</small>
        </label>

        <div class="field full-field">
          <span>{props.initial.resumeId ? "Original project folder" : "Project folder"}</span>
          <div class="path-picker-control">
            <input
              value={projectDir()}
              readOnly={nativeProjectPicker() || Boolean(selectedHost()?.url)}
              onInput={(event) => setProjectDir(event.currentTarget.value)}
              placeholder={nativeProjectPicker() ? "Choose a folder…" : "/runtime-host/project"}
              aria-label="Selected project folder"
            />
            <Show when={nativeProjectPicker()}>
              <button type="button" class="secondary-button" disabled={pickingProject()} onClick={() => void pickProject()}>
                {pickingProject() ? "Choosing…" : "Choose folder…"}
              </button>
            </Show>
            <Show when={selectedHost()?.url}>
              <button type="button" class="secondary-button" disabled={pickingProject()} onClick={() => void browseRemote(projectDir() || undefined)}>
                {pickingProject() ? "Loading…" : "Browse host…"}
              </button>
            </Show>
          </div>
          <small>{nativeProjectPicker()
            ? "Studio uses the system folder picker. The Amplifier runtime starts in the selected folder."
            : "Enter a path exposed by this runtime host. The host validates it against its allowed project roots."}</small>
        </div>

        <Show when={remoteDirectories()} keyed>{(listing) => (
          <div class="remote-directory-browser">
            <div><strong>{listing.path}</strong></div>
            <div class="remote-directory-actions">
              <button type="button" class="secondary-button" onClick={() => setProjectDir(listing.path)}>Use this folder</button>
              <Show when={listing.parent} keyed>{(parent) => (
                <button type="button" class="secondary-button" onClick={() => void browseRemote(parent)}>Up</button>
              )}</Show>
            </div>
            <div class="remote-directory-list">
              <For each={listing.directories}>{(directory) => (
                <button type="button" onClick={() => void browseRemote(directory.path)}>{directory.name}</button>
              )}</For>
              <Show when={!listing.directories.length}><span>No child folders</span></Show>
            </div>
          </div>
        )}</Show>

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
