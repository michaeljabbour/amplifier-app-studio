import { createMemo, createSignal, For, Show } from "solid-js";
import type { CapabilityCatalog, NewSessionInput } from "../protocol";
import { directoryBreadcrumbs, isPathInsideRoot } from "../projectFolders";
import { toolContractFailure } from "../providerSafety";
import { createHostDirectory, listHostDirectories, type HostDirectoryListing, type RuntimeHost } from "../transport";

interface Props {
  initial: NewSessionInput;
  catalog: CapabilityCatalog;
  catalogError?: string;
  hosts: RuntimeHost[];
  nativeProjectPicker: boolean;
  onCancel: () => void;
  onPickProjectDir: (defaultPath?: string) => Promise<string | undefined>;
  onHostChange: (host: RuntimeHost) => Promise<string | undefined>;
  onStart: (input: NewSessionInput) => Promise<void>;
}

export function NewSessionDialog(props: Props) {
  let remoteBrowserTrigger: HTMLButtonElement | undefined;
  let remoteBrowserBack: HTMLButtonElement | undefined;
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
  const [newFolder, setNewFolder] = createSignal("");
  const [creatingFolder, setCreatingFolder] = createSignal(false);
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
    const opening = !remoteDirectories();
    setPickingProject(true);
    setError("");
    try {
      const listing = await listHostDirectories(host.url, path, host.id);
      setRemoteDirectories(listing);
      if (!projectDir()) setProjectDir(listing.path);
      if (opening) queueMicrotask(() => remoteBrowserBack?.focus());
    } catch (caught) {
      setError(String(caught));
    } finally {
      setPickingProject(false);
    }
  };

  const openRemoteBrowser = () => {
    void browseRemote(props.initial.resumeId ? projectDir() || undefined : undefined);
  };

  const chooseRemoteFolder = (path: string) => {
    setProjectDir(path);
    setRemoteDirectories(undefined);
    setNewFolder("");
    setError("");
    queueMicrotask(() => remoteBrowserTrigger?.focus());
  };

  const closeRemoteBrowser = () => {
    setRemoteDirectories(undefined);
    setNewFolder("");
    setError("");
    queueMicrotask(() => remoteBrowserTrigger?.focus());
  };

  // A remote host only exposes folders that already exist, so without this the
  // only way to start a session in a fresh directory was to go make one by hand
  // over SSH first.
  const createRemoteFolder = async (parentPath: string) => {
    const host = selectedHost();
    const name = newFolder().trim();
    if (!host?.url || !name || creatingFolder()) return;
    setCreatingFolder(true);
    setError("");
    try {
      const created = await createHostDirectory(host.url, parentPath, name, host.id);
      setNewFolder("");
      chooseRemoteFolder(created.path);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setCreatingFolder(false);
    }
  };

  return (
    <div class="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && props.onCancel()}>
      <form
        class="session-dialog"
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !remoteDirectories()) return;
          event.preventDefault();
          closeRemoteBrowser();
        }}
      >
        <div class="dialog-heading" inert={Boolean(remoteDirectories())} aria-hidden={Boolean(remoteDirectories())}>
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

        <label class="field full-field" inert={Boolean(remoteDirectories())} aria-hidden={Boolean(remoteDirectories())}>
          <span>Runtime host</span>
          <select
            value={hostId()}
            onChange={(event) => {
              const next = props.hosts.find((host) => host.id === event.currentTarget.value);
              if (!next) return;
              setHostId(next.id);
              setProjectDir(next.defaultProjectRoot || "");
              setRemoteDirectories(undefined);
              void props.onHostChange(next)
                .then((projectRoot) => {
                  if (hostId() === next.id && projectRoot) setProjectDir(projectRoot);
                })
                .catch((caught) => setError(String(caught)));
            }}
          >
            {props.hosts.map((host) => <option value={host.id}>{host.name}{host.url ? ` · ${host.url}` : " · local"}</option>)}
          </select>
          <small>Every tab is pinned to one host. Switching tabs does not move or stop its runtime.</small>
        </label>

        <div class="field full-field" inert={Boolean(remoteDirectories())} aria-hidden={Boolean(remoteDirectories())}>
          <span>{props.initial.resumeId ? "Original project folder" : "Project folder"}</span>
          <Show when={selectedHost()?.url} fallback={
            <div class="path-picker-control">
              <input
                value={projectDir()}
                readOnly={nativeProjectPicker()}
                onInput={(event) => setProjectDir(event.currentTarget.value)}
                placeholder={nativeProjectPicker() ? "Choose a folder…" : "/project/path"}
                aria-label="Selected project folder"
              />
              <Show when={nativeProjectPicker()}>
                <button type="button" class="secondary-button" disabled={pickingProject()} onClick={() => void pickProject()}>
                  {pickingProject() ? "Choosing…" : "Choose folder…"}
                </button>
              </Show>
            </div>
          }>
            <div class="remote-project-control">
              <div>
                <small>Selected folder</small>
                <code title={projectDir()}>{projectDir() || "No project folder selected"}</code>
              </div>
              <button ref={remoteBrowserTrigger} type="button" class="secondary-button" disabled={pickingProject()} onClick={openRemoteBrowser}>
                {pickingProject() ? "Loading…" : "Change…"}
              </button>
            </div>
          </Show>
          <small>{nativeProjectPicker()
            ? "Studio uses the system folder picker. The Amplifier runtime starts in the selected folder."
            : selectedHost()?.url
              ? "Choose an existing project, or create a new project folder on this host."
              : "Enter the project folder this session may use."}</small>
        </div>

        <Show when={remoteDirectories()} keyed>{(listing) => (
          <section class="remote-directory-picker" role="dialog" aria-modal="true" aria-labelledby="remote-directory-title">
            <header class="remote-directory-heading">
              <button ref={remoteBrowserBack} type="button" class="secondary-button" onClick={closeRemoteBrowser}>Back to setup</button>
              <div>
                <span class="eyebrow">PROJECT LOCATION</span>
                <h3 id="remote-directory-title">Choose a project folder</h3>
              </div>
            </header>

            <div class="remote-directory-body" aria-busy={pickingProject()}>
              <Show when={listing.roots.length > 1}>
                <div class="remote-directory-roots" role="group" aria-label="Available workspace roots">
                  <span>Workspaces</span>
                  <div>
                    <For each={listing.roots}>{(root) => (
                      <button
                        type="button"
                        classList={{ active: isPathInsideRoot(listing.path, root) }}
                        aria-pressed={isPathInsideRoot(listing.path, root)}
                        onClick={() => void browseRemote(root)}
                      >{root}</button>
                    )}</For>
                  </div>
                </div>
              </Show>

              <nav class="remote-directory-breadcrumbs" aria-label="Current project location">
                <For each={directoryBreadcrumbs(listing)}>{(crumb, index) => (
                  <>
                    <Show when={index() > 0}><span aria-hidden="true">/</span></Show>
                    <button type="button" disabled={crumb.path === listing.path} onClick={() => void browseRemote(crumb.path)}>{crumb.label}</button>
                  </>
                )}</For>
              </nav>

              <div class="remote-directory-toolbar">
                <Show when={listing.parent} keyed fallback={<span>At workspace root</span>}>{(parent) => (
                  <button type="button" class="secondary-button" onClick={() => void browseRemote(parent)}>Up one level</button>
                )}</Show>
                <code title={listing.path}>{listing.path}</code>
              </div>
              <div class="remote-directory-boundary">
                This host lets Studio browse inside {listing.roots.join(" or ")}. Higher folders stay private to the host.
              </div>

              <div class="remote-project-create">
                <div>
                  <strong>Start a new project</strong>
                  <span>Create a folder here and use it immediately.</span>
                </div>
                <div>
                  <input
                    type="text"
                    value={newFolder()}
                    placeholder="project-name"
                    aria-label={`New project folder inside ${listing.path}`}
                    autocomplete="off"
                    autocapitalize="none"
                    spellcheck={false}
                    disabled={creatingFolder()}
                    onInput={(event) => setNewFolder(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      void createRemoteFolder(listing.path);
                    }}
                  />
                  <button
                    type="button"
                    class="primary-button"
                    disabled={!newFolder().trim() || creatingFolder()}
                    onClick={() => void createRemoteFolder(listing.path)}
                  >{creatingFolder() ? "Creating…" : "Create & use"}</button>
                </div>
              </div>
              <Show when={error()} keyed>{(message) => <div class="remote-directory-error" role="alert">{message}</div>}</Show>

              <div class="remote-directory-list-heading">
                <strong>Folders</strong>
                <span>{listing.directories.length} available</span>
              </div>
              <ul class="remote-directory-list">
                <For each={listing.directories}>{(directory) => (
                  <li><button type="button" onClick={() => void browseRemote(directory.path)}>
                    <span>{directory.name}</span><small>Open</small>
                  </button></li>
                )}</For>
                <Show when={!listing.directories.length}>
                  <li class="remote-directory-empty">
                    <strong>No folders here yet</strong>
                    <span>Create a project above, or use this folder as-is.</span>
                  </li>
                </Show>
              </ul>
            </div>

            <footer class="remote-directory-footer">
              <div><span>Use current folder</span><code title={listing.path}>{listing.path}</code></div>
              <button type="button" class="primary-button" onClick={() => chooseRemoteFolder(listing.path)}>Choose this folder</button>
            </footer>
          </section>
        )}</Show>

        <details
          class="advanced-composition"
          open={!props.initial.capabilityName && !props.initial.resumeId}
          inert={Boolean(remoteDirectories())}
          aria-hidden={Boolean(remoteDirectories())}
        >
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

        <Show when={error() && !remoteDirectories()}><div class="form-error">{error()}</div></Show>

        <div class="dialog-footer" inert={Boolean(remoteDirectories())} aria-hidden={Boolean(remoteDirectories())}>
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
