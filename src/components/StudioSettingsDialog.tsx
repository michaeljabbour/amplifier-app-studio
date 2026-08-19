import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import {
  RUNTIME_SETTINGS_SECTIONS,
  runtimeSettingByPath,
  settingsFieldsInSection,
  type RuntimeSettingDefinition,
  type RuntimeSettingScope,
} from "../settingsSchema";
import type { StudioTheme } from "../theme";
import { isPathInsideRoot } from "../projectFolders";
import {
  applyRuntimeSettings,
  isMobileRuntime,
  listHostDirectories,
  readRuntimeSettings,
  type HostDirectoryListing,
  type RuntimeSettingChange,
  type RuntimeSettingsSnapshot,
  type RuntimeHost,
} from "../transport";

type SettingsSectionId = "appearance" | "connection" | "maintenance" | string;

interface Props {
  initialProjectDir: string;
  initialTheme: StudioTheme;
  runtimeHosts: RuntimeHost[];
  initialSessionHomeHostId: string;
  runtimeSettingsAvailable: boolean;
  nativeProjectPicker: boolean;
  onPickProjectDir: (defaultPath?: string) => Promise<string | undefined>;
  onThemePreview: (theme: StudioTheme) => void;
  onCancel: () => void;
  onAddRuntimeHost: (url: string, token: string) => Promise<RuntimeHost>;
  onRemoveRuntimeHost: (id: string) => Promise<void>;
  onSaveStudio: (theme: StudioTheme, sessionHomeHostId: string) => Promise<void>;
}

const SETTINGS_CONTEXTS_KEY = "amplifier-studio.settings-project-contexts";

const STATIC_SECTIONS = [
  { id: "appearance", title: "Appearance", summary: "Studio visual language" },
  { id: "connection", title: "Connection", summary: "Local or remote Rust bridge" },
];

export function StudioSettingsDialog(props: Props) {
  const initialSettingsHostId = props.runtimeHosts.some((host) => host.id === props.initialSessionHomeHostId)
    ? props.initialSessionHomeHostId
    : "local";
  const initialSettingsHost = props.runtimeHosts.find((host) => host.id === initialSettingsHostId);
  const [settingsContexts, setSettingsContexts] = createSignal<Record<string, string>>(loadSettingsContexts());
  const [section, setSection] = createSignal<SettingsSectionId>("appearance");
  const [scope, setScope] = createSignal<RuntimeSettingScope>("global");
  const [settingsHostId, setSettingsHostId] = createSignal(initialSettingsHostId);
  const [projectDir, setProjectDir] = createSignal(
    preferredSettingsContext(
      initialSettingsHost,
      settingsContexts()[settingsContextKey(initialSettingsHost)],
      props.initialProjectDir,
    ),
  );
  const [theme, setTheme] = createSignal<StudioTheme>(props.initialTheme);
  const [url, setUrl] = createSignal("");
  const [token, setToken] = createSignal("");
  const [sessionHomeHostId, setSessionHomeHostId] = createSignal(props.initialSessionHomeHostId);
  const [snapshot, setSnapshot] = createSignal<RuntimeSettingsSnapshot>();
  const [changes, setChanges] = createSignal<Record<string, RuntimeSettingChange>>({});
  const [loading, setLoading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [picking, setPicking] = createSignal(false);
  const [reviewing, setReviewing] = createSignal(false);
  const [addingHost, setAddingHost] = createSignal(false);
  const [removingHost, setRemovingHost] = createSignal("");
  const [remoteDirectories, setRemoteDirectories] = createSignal<HostDirectoryListing>();
  const [error, setError] = createSignal("");
  const [query, setQuery] = createSignal("");

  const staged = createMemo(() => Object.values(changes()));
  const studioChanged = createMemo(() => theme() !== props.initialTheme
    || sessionHomeHostId() !== props.initialSessionHomeHostId);
  const settingsHost = createMemo(() => props.runtimeHosts.find((host) => host.id === settingsHostId())
    || props.runtimeHosts.find((host) => host.id === "local")
    || props.runtimeHosts[0]);
  const currentRuntimeSection = createMemo(() => RUNTIME_SETTINGS_SECTIONS.find((item) => item.id === section()));
  const visibleFields = createMemo(() => {
    const needle = query().trim().toLocaleLowerCase();
    const fields = settingsFieldsInSection(section());
    return needle
      ? fields.filter((field) => `${field.label} ${field.path} ${field.help}`.toLocaleLowerCase().includes(needle))
      : fields;
  });

  onMount(() => {
    if (props.runtimeSettingsAvailable) void loadSettings(projectDir(), settingsHost());
  });

  const close = () => {
    props.onThemePreview(props.initialTheme);
    props.onCancel();
  };

  const previewTheme = (value: StudioTheme) => {
    setTheme(value);
    props.onThemePreview(value);
  };

  const rememberSettingsContext = (host: RuntimeHost | undefined, directory: string) => {
    if (!directory.trim()) return;
    setSettingsContexts((current) => {
      const next = { ...current, [settingsContextKey(host)]: directory.trim() };
      localStorage.setItem(SETTINGS_CONTEXTS_KEY, JSON.stringify(next));
      return next;
    });
  };

  const loadSettings = async (directory: string, host = settingsHost()) => {
    if (!props.runtimeSettingsAvailable || !directory.trim()) return;
    setLoading(true);
    setError("");
    try {
      setSnapshot(await readRuntimeSettings(directory, host?.url || undefined, host?.id));
      setChanges({});
      rememberSettingsContext(host, directory);
    } catch (caught) {
      setSnapshot(undefined);
      setError(cleanError(caught));
    } finally {
      setLoading(false);
    }
  };

  const chooseProject = async () => {
    if (picking()) return;
    setPicking(true);
    setError("");
    try {
      const selected = await props.onPickProjectDir(projectDir());
      if (selected) {
        setProjectDir(selected);
        await loadSettings(selected, settingsHost());
      }
    } catch (caught) {
      setError(cleanError(caught));
    } finally {
      setPicking(false);
    }
  };

  const selectSettingsHost = async (id: string) => {
    if (staged().length) {
      setError("Review or undo the staged runtime edits before changing the settings host.");
      return;
    }
    const host = props.runtimeHosts.find((candidate) => candidate.id === id);
    if (!host) return;
    const directory = preferredSettingsContext(
      host,
      settingsContexts()[settingsContextKey(host)],
      host.id === props.initialSessionHomeHostId ? props.initialProjectDir : "",
    );
    setSettingsHostId(host.id);
    setProjectDir(directory);
    setRemoteDirectories(undefined);
    setSnapshot(undefined);
    setError("");
    if (directory) await loadSettings(directory, host);
  };

  const browseRemote = async (path?: string) => {
    const host = settingsHost();
    if (!host?.url || picking()) return;
    setPicking(true);
    setError("");
    try {
      setRemoteDirectories(await listHostDirectories(host.url, path, host.id));
    } catch (caught) {
      setError(cleanError(caught));
    } finally {
      setPicking(false);
    }
  };

  const useRemoteFolder = async (path: string) => {
    setProjectDir(path);
    setRemoteDirectories(undefined);
    await loadSettings(path, settingsHost());
  };

  const addHost = async () => {
    if (addingHost()) return;
    if (!url().trim() || !token().trim()) {
      setError("Enter both the compute host URL and bearer token.");
      return;
    }
    setAddingHost(true);
    setError("");
    try {
      const host = await props.onAddRuntimeHost(url(), token());
      setUrl("");
      setToken("");
      if (sessionHomeHostId() === "local" && props.runtimeHosts.filter((candidate) => candidate.id !== "local").length === 1) {
        setSessionHomeHostId(host.id);
      }
    } catch (caught) {
      setError(cleanError(caught));
    } finally {
      setAddingHost(false);
    }
  };

  const stage = (field: RuntimeSettingDefinition, action: "set" | "unset", value?: string) => {
    const targetScope = field.kind === "secret" ? "global" : scope();
    setChanges((current) => ({
      ...current,
      [field.path]: { path: field.path, action, value, scope: targetScope },
    }));
  };

  const clearStage = (path: string) => {
    setChanges((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
  };

  const beginReview = () => {
    setError("");
    if (!studioChanged() && staged().length === 0) {
      close();
      return;
    }
    setReviewing(true);
  };

  const apply = async () => {
    if (saving()) return;
    setSaving(true);
    setError("");
    try {
      if (staged().length) {
        const host = settingsHost();
        setSnapshot(await applyRuntimeSettings(projectDir(), staged(), host?.url || undefined, host?.id));
        setChanges({});
      }
      await props.onSaveStudio(theme(), sessionHomeHostId());
      props.onCancel();
    } catch (caught) {
      setReviewing(false);
      setError(cleanError(caught));
    } finally {
      setSaving(false);
    }
  };

  const removeHost = async (id: string) => {
    if (removingHost()) return;
    if (settingsHostId() === id && staged().length) {
      setError("Review or undo the staged runtime edits before removing their settings host.");
      return;
    }
    setRemovingHost(id);
    setError("");
    try {
      await props.onRemoveRuntimeHost(id);
      if (sessionHomeHostId() === id) setSessionHomeHostId("local");
      if (settingsHostId() === id) await selectSettingsHost("local");
    } catch (caught) {
      setError(cleanError(caught));
    } finally {
      setRemovingHost("");
    }
  };

  return (
    <div class="settings-backdrop" role="presentation">
      <section class="settings-window" role="dialog" aria-modal="true" aria-labelledby="studio-settings-title">
        <header class="settings-header">
          <div class="settings-wordmark" aria-hidden="true"><strong>AMPLIFIER</strong><span><i /><i /><i /><i /></span></div>
          <div>
            <div class="eyebrow">STUDIO CONTROL CENTRE</div>
            <h2 id="studio-settings-title">Settings</h2>
            <p>Durable Amplifier edits apply to the next session. Running sessions are never mutated.</p>
          </div>
          <button type="button" class="icon-button settings-close" onClick={close} aria-label="Close settings">×</button>
        </header>

        <div class="settings-layout">
          <aside class="settings-navigation" aria-label="Settings sections">
            <div class="settings-search">
              <span aria-hidden="true">⌕</span>
              <input value={query()} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Find a setting" aria-label="Find a setting" />
            </div>
            <label class="settings-mobile-section-picker">
              <span>Settings section</span>
              <select value={section()} onChange={(event) => setSection(event.currentTarget.value)}>
                <optgroup label="Studio">
                  <For each={STATIC_SECTIONS}>{(item) => <option value={item.id}>{item.title}</option>}</For>
                </optgroup>
                <optgroup label="Amplifier runtime">
                  <For each={RUNTIME_SETTINGS_SECTIONS}>{(item) => <option value={item.id} disabled={!props.runtimeSettingsAvailable}>{item.title}</option>}</For>
                </optgroup>
                <optgroup label="System">
                  <option value="maintenance" disabled={!props.runtimeSettingsAvailable}>Maintenance</option>
                </optgroup>
              </select>
            </label>
            <nav>
              <For each={STATIC_SECTIONS}>{(item) => <SettingsNavButton item={item} active={section() === item.id} onSelect={() => setSection(item.id)} />}</For>
              <div class="settings-nav-label">Amplifier runtime</div>
              <For each={RUNTIME_SETTINGS_SECTIONS}>{(item) => (
                <SettingsNavButton
                  item={item}
                  active={section() === item.id}
                  disabled={!props.runtimeSettingsAvailable}
                  count={settingsFieldsInSection(item.id).length}
                  onSelect={() => setSection(item.id)}
                />
              )}</For>
              <div class="settings-nav-label">System</div>
              <SettingsNavButton item={{ id: "maintenance", title: "Maintenance", summary: "Runtime state and file paths" }} active={section() === "maintenance"} disabled={!props.runtimeSettingsAvailable} onSelect={() => setSection("maintenance")} />
            </nav>
            <div class="settings-nav-footnote">29 durable runtime fields · 3 scopes · secrets redacted</div>
          </aside>

          <main class="settings-content">
            <Show when={error()}><div class="settings-error" role="alert">{error()}</div></Show>
            <Show when={section() === "appearance"}><AppearanceSection theme={theme()} onTheme={previewTheme} /></Show>
            <Show when={section() === "connection"}>
              <ConnectionSection
                mobile={isMobileRuntime()}
                url={url()}
                token={token()}
                hosts={props.runtimeHosts}
                sessionHomeHostId={sessionHomeHostId()}
                addingHost={addingHost()}
                removingHost={removingHost()}
                onUrl={setUrl}
                onToken={setToken}
                onAddHost={() => void addHost()}
                onSessionHomeHost={setSessionHomeHostId}
                onRemoveHost={(id) => void removeHost(id)}
              />
            </Show>
            <Show when={currentRuntimeSection()} keyed>{(activeSection) => (
              <RuntimeSection
                section={activeSection}
                fields={visibleFields()}
                snapshot={snapshot()}
                changes={changes()}
                scope={scope()}
                loading={loading()}
                projectDir={projectDir()}
                hosts={props.runtimeHosts}
                settingsHostId={settingsHostId()}
                nativeProjectPicker={props.nativeProjectPicker && !settingsHost()?.url}
                picking={picking()}
                remoteDirectories={remoteDirectories()}
                onScope={setScope}
                onProject={setProjectDir}
                onSettingsHost={(id) => void selectSettingsHost(id)}
                onPickProject={() => void chooseProject()}
                onBrowseRemote={(path) => void browseRemote(path)}
                onUseRemoteFolder={(path) => void useRemoteFolder(path)}
                onReload={() => void loadSettings(projectDir(), settingsHost())}
                onStage={stage}
                onClear={clearStage}
              />
            )}</Show>
            <Show when={section() === "maintenance"}><MaintenanceSection snapshot={snapshot()} loading={loading()} onReload={() => void loadSettings(projectDir(), settingsHost())} /></Show>
          </main>
        </div>

        <footer class="settings-footer">
          <div>
            <strong>{staged().length || (studioChanged() ? 1 : 0)}</strong>
            <span>{staged().length || studioChanged() ? "changes staged" : "No staged changes"}</span>
          </div>
          <button type="button" class="secondary-button" onClick={close}>Discard</button>
          <button type="button" class="primary-button" disabled={loading() || saving() || (!studioChanged() && staged().length === 0)} onClick={beginReview}>{saving() ? "Saving…" : "Review changes"}</button>
        </footer>

        <Show when={reviewing()}>
          <ReviewChanges
            changes={staged()}
            studioChanged={studioChanged()}
            theme={theme()}
            sessionHomeChanged={sessionHomeHostId() !== props.initialSessionHomeHostId}
            sessionHomeName={props.runtimeHosts.find((host) => host.id === sessionHomeHostId())?.name || "This computer"}
            saving={saving()}
            onBack={() => setReviewing(false)}
            onApply={() => void apply()}
          />
        </Show>
      </section>
    </div>
  );
}

function SettingsNavButton(props: {
  item: { id: string; title: string; summary: string };
  active: boolean;
  disabled?: boolean;
  count?: number;
  onSelect: () => void;
}) {
  return (
    <button type="button" class="settings-nav-item" classList={{ active: props.active }} aria-current={props.active ? "page" : undefined} disabled={props.disabled} onClick={props.onSelect}>
      <span><strong>{props.item.title}</strong><small>{props.item.summary}</small></span>
      <Show when={props.count !== undefined}><i>{props.count}</i></Show>
    </button>
  );
}

function SectionHeading(props: { kicker: string; title: string; description: string }) {
  return <div class="settings-section-heading"><div class="eyebrow">{props.kicker}</div><h3>{props.title}</h3><p>{props.description}</p></div>;
}

function AppearanceSection(props: { theme: StudioTheme; onTheme: (theme: StudioTheme) => void }) {
  return (
    <div class="settings-section">
      <SectionHeading kicker="APPEARANCE" title="Choose the room you work in" description="The interface can carry MADE’s editorial warmth or the original Studio night treatment. Appearance changes preview immediately and persist when you save." />
      <div class="theme-options" role="radiogroup" aria-label="Studio visual style">
        <button type="button" role="radio" aria-checked={props.theme === "made"} classList={{ selected: props.theme === "made" }} onClick={() => props.onTheme("made")}>
          <span class="theme-swatch made"><i /><i /><i /><i /></span>
          <strong>MADE Paper</strong><small>Warm paper, ink, gold hairlines, and a calm editorial rhythm.</small><b>Recommended</b>
        </button>
        <button type="button" role="radio" aria-checked={props.theme === "studio"} classList={{ selected: props.theme === "studio" }} onClick={() => props.onTheme("studio")}>
          <span class="theme-swatch studio"><i /><i /><i /><i /></span>
          <strong>Studio Night</strong><small>The original dark workbench with blue machine-state accents.</small>
        </button>
      </div>
      <div class="settings-callout"><strong>A theme, not a costume.</strong><p>The MADE option changes typography, palette, borders, density, and hierarchy while preserving Studio’s runtime states and accessibility semantics.</p></div>
    </div>
  );
}

function ConnectionSection(props: {
  mobile: boolean;
  url: string;
  token: string;
  hosts: RuntimeHost[];
  sessionHomeHostId: string;
  addingHost: boolean;
  removingHost: string;
  onUrl: (value: string) => void;
  onToken: (value: string) => void;
  onAddHost: () => void;
  onSessionHomeHost: (id: string) => void;
  onRemoveHost: (id: string) => void;
}) {
  const savedHosts = () => props.hosts.filter((host) => Boolean(host.url));
  return (
    <div class="settings-section">
      <SectionHeading kicker="CONNECTION" title="Runtime & compute pool" description={props.mobile
        ? "Connect this phone to an authenticated compute host. Studio proves the URL and token before making it the home for new sessions."
        : "Desktop sessions use the local Rust bridge by default. Save a remote URL and token to test the host, add it to this pool, and protect its credential in the operating system’s secure credential store."} />
      <div class="settings-field-stack">
        <label class="settings-form-field"><span>Bridge URL <em>mobile / remote</em></span><input value={props.url} onInput={(event) => props.onUrl(event.currentTarget.value)} placeholder="https://studio-bridge.example.com" inputMode="url" /><small>Use a loopback SSH tunnel on desktop, or HTTPS for a directly reachable remote host.</small></label>
        <label class="settings-form-field"><span>Bearer token <em>protected credential</em></span><input type="password" value={props.token} onInput={(event) => props.onToken(event.currentTarget.value)} placeholder="Paste the bridge bearer token" autocomplete="off" /><small>{props.mobile
          ? "The token remains private to this app session and is never placed in the URL."
          : "The token stays session-only until the host proves it can start a session. Studio then moves it to the operating system’s secure credential store—never settings, the host registry, or a shared URL."}</small></label>
        <div class="settings-form-actions"><button type="button" class="primary-button" disabled={props.addingHost || !props.url.trim() || !props.token.trim()} onClick={props.onAddHost}>{props.addingHost ? "Testing & adding…" : "Add compute host"}</button><small>The host is tested and added now. You can add another before choosing Session home and reviewing the remaining settings.</small></div>
      </div>
      <div class="compute-pool">
        <div class="compute-pool-heading"><div><span>AVAILABLE COMPUTE</span><strong>{savedHosts().length} saved host{savedHosts().length === 1 ? "" : "s"}</strong></div><small>Each new session remains pinned to the host you choose.</small></div>
        <Show when={savedHosts().length} fallback={<div class="settings-empty compact">No remote compute saved yet. Enter the URL and token above, then add the proven host to this pool.</div>}>
          <div class="compute-host-list">
            <For each={savedHosts()}>{(host) => (
              <article>
                <div><strong>{host.name}</strong><code>{host.url}</code><small>{host.defaultProjectRoot || "Choose a project root when starting"}</small></div>
                <span>{host.tokenRef.startsWith("keychain:") ? "SECURE" : host.tokenRef === "session" ? "SESSION" : "ENV"}</span>
                <button type="button" disabled={props.removingHost === host.id} onClick={() => props.onRemoveHost(host.id)}>{props.removingHost === host.id ? "Removing…" : "Remove"}</button>
              </article>
            )}</For>
          </div>
        </Show>
        <label class="settings-form-field session-home-field">
          <span>Session home <em>default for new sessions</em></span>
          <select value={props.sessionHomeHostId} onChange={(event) => props.onSessionHomeHost(event.currentTarget.value)}>
            <Show when={!props.mobile}><option value="local">This computer</option></Show>
            <For each={savedHosts()}>{(host) => <option value={host.id}>{host.name}</option>}</For>
          </select>
          <small>New sessions start here by default. History scans this computer and every available compute host, and each resumed session returns to the machine where it was created.</small>
        </label>
      </div>
    </div>
  );
}

function RuntimeSection(props: {
  section: { id: string; title: string; summary: string };
  fields: RuntimeSettingDefinition[];
  snapshot?: RuntimeSettingsSnapshot;
  changes: Record<string, RuntimeSettingChange>;
  scope: RuntimeSettingScope;
  loading: boolean;
  projectDir: string;
  hosts: RuntimeHost[];
  settingsHostId: string;
  nativeProjectPicker: boolean;
  picking: boolean;
  remoteDirectories?: HostDirectoryListing;
  onScope: (scope: RuntimeSettingScope) => void;
  onProject: (path: string) => void;
  onSettingsHost: (id: string) => void;
  onPickProject: () => void;
  onBrowseRemote: (path?: string) => void;
  onUseRemoteFolder: (path: string) => void;
  onReload: () => void;
  onStage: (field: RuntimeSettingDefinition, action: "set" | "unset", value?: string) => void;
  onClear: (path: string) => void;
}) {
  const remoteHost = () => props.hosts.find((host) => host.id === props.settingsHostId)?.url;
  return (
    <div class="settings-section">
      <SectionHeading kicker="AMPLIFIER RUNTIME" title={props.section.title} description={`${props.section.summary}. Each edit is staged, redacted for review, and applies when the next session starts.`} />
      <label class="settings-target-host">
        <span>Settings host</span>
        <select value={props.settingsHostId} onChange={(event) => props.onSettingsHost(event.currentTarget.value)}>
          <For each={props.hosts}>{(host) => <option value={host.id}>{host.name}{host.url ? " · remote" : " · local"}</option>}</For>
        </select>
        <small>Read and edit settings on this machine. Session home is selected separately under Connection.</small>
      </label>
      <div class="settings-context-bar">
        <div><span>Project context</span><strong title={props.projectDir}>{props.projectDir || "No project selected"}</strong></div>
        <Show when={remoteHost()} fallback={
          <Show when={props.nativeProjectPicker} fallback={<input value={props.projectDir} onInput={(event) => props.onProject(event.currentTarget.value)} aria-label="Settings project folder" />}>
            <button type="button" class="secondary-button" disabled={props.picking} onClick={props.onPickProject}>{props.picking ? "Choosing…" : "Choose folder…"}</button>
          </Show>
        }>
          <button type="button" class="secondary-button" disabled={props.picking} onClick={() => props.onBrowseRemote(props.projectDir || undefined)}>{props.picking ? "Loading…" : "Browse host…"}</button>
        </Show>
        <button type="button" class="icon-button" disabled={props.loading} onClick={props.onReload} aria-label="Reload effective settings" title="Reload effective settings">↻</button>
      </div>
      <Show when={props.remoteDirectories} keyed>{(listing) => (
        <div class="settings-remote-directory-browser">
          <div><strong>{listing.path}</strong></div>
          <div class="remote-directory-actions">
            <button type="button" class="secondary-button" onClick={() => props.onUseRemoteFolder(listing.path)}>Use this folder</button>
            <Show when={listing.parent} keyed>{(parent) => <button type="button" class="secondary-button" onClick={() => props.onBrowseRemote(parent)}>Up</button>}</Show>
          </div>
          <div class="remote-directory-list">
            <For each={listing.directories}>{(directory) => <button type="button" onClick={() => props.onBrowseRemote(directory.path)}>{directory.name}</button>}</For>
            <Show when={!listing.directories.length}><span>No child folders</span></Show>
          </div>
        </div>
      )}</Show>
      <div class="scope-control" role="group" aria-label="Settings write scope">
        <span>Write new edits to</span>
        <For each={["global", "project", "local"] as RuntimeSettingScope[]}>{(item) => <button type="button" classList={{ active: props.scope === item }} onClick={() => props.onScope(item)}>{item}</button>}</For>
        <small>{scopeDescription(props.scope)}</small>
      </div>
      <Show when={!props.loading} fallback={<div class="settings-loading"><span class="mini-spinner" /> Reading effective settings and provenance…</div>}>
        <Show when={props.snapshot} fallback={<div class="settings-empty">Amplifier settings could not be loaded for this project context.</div>}>
          <div class="runtime-settings-list">
            <For each={props.fields}>{(field) => (
              <RuntimeField
                field={field}
                resolved={props.snapshot?.values.find((value) => value.path === field.path)}
                change={props.changes[field.path]}
                onStage={(action, value) => props.onStage(field, action, value)}
                onClear={() => props.onClear(field.path)}
              />
            )}</For>
          </div>
        </Show>
      </Show>
    </div>
  );
}

function RuntimeField(props: {
  field: RuntimeSettingDefinition;
  resolved?: RuntimeSettingsSnapshot["values"][number];
  change?: RuntimeSettingChange;
  onStage: (action: "set" | "unset", value?: string) => void;
  onClear: () => void;
}) {
  const displayValue = () => {
    if (props.change?.action === "set") return props.change.value || "";
    if (props.change?.action === "unset") return "";
    if (props.field.kind === "secret") return "";
    const value = props.resolved?.display || "";
    return ["unset", "not set", "(empty)"].includes(value) ? "" : value;
  };
  const setValue = (value: string) => props.onStage(value ? "set" : "unset", value || undefined);
  return (
    <article class="runtime-setting-field" classList={{ staged: Boolean(props.change) }}>
      <div class="runtime-setting-copy">
        <div><strong>{props.field.label}</strong><code>{props.field.path}</code></div>
        <p>{props.field.help}</p>
        <div class="setting-provenance"><span class={`source-${props.resolved?.source || "unknown"}`}>{sourceName(props.resolved?.source)}</span><small>{props.resolved?.sourceLabel || "unavailable"}</small><i>next session</i></div>
      </div>
      <div class="runtime-setting-control">
        <Show when={props.field.kind === "bool"}>
          <select value={displayValue()} onChange={(event) => setValue(event.currentTarget.value)} aria-label={props.field.label}>
            <option value="">Unset / inherit</option><option value="true">On</option><option value="false">Off</option>
          </select>
        </Show>
        <Show when={props.field.kind === "choice"}>
          <select value={displayValue()} onChange={(event) => setValue(event.currentTarget.value)} aria-label={props.field.label}>
            <option value="">Unset / inherit</option><For each={props.field.choices || []}>{(choice) => <option value={choice}>{choice}</option>}</For>
          </select>
        </Show>
        <Show when={props.field.kind === "secret"}>
          <input type="password" value={displayValue()} onInput={(event) => event.currentTarget.value ? props.onStage("set", event.currentTarget.value) : props.onClear()} placeholder={props.resolved?.display === "configured" ? "Configured — enter to replace" : "Not set"} autocomplete="off" aria-label={props.field.label} />
        </Show>
        <Show when={props.field.kind === "list"}>
          <textarea value={displayValue()} onInput={(event) => setValue(event.currentTarget.value)} placeholder="Comma-separated values" aria-label={props.field.label} />
        </Show>
        <Show when={["str", "int", "float"].includes(props.field.kind)}>
          <input type={props.field.kind === "str" ? "text" : "number"} step={props.field.kind === "float" ? "any" : undefined} value={displayValue()} onInput={(event) => setValue(event.currentTarget.value)} placeholder={props.field.placeholder || "Unset"} aria-label={props.field.label} />
        </Show>
        <div class="runtime-setting-actions">
          <button type="button" onClick={() => props.onStage("unset")}>{props.field.kind === "secret" ? "Remove stored key" : "Stage unset"}</button>
          <Show when={props.change}><button type="button" onClick={props.onClear}>Undo edit</button><span>{props.change?.scope}</span></Show>
        </div>
      </div>
    </article>
  );
}

function MaintenanceSection(props: { snapshot?: RuntimeSettingsSnapshot; loading: boolean; onReload: () => void }) {
  const paths = () => Object.entries(props.snapshot?.paths || {}).filter(([key]) => key !== "schema");
  return (
    <div class="settings-section">
      <SectionHeading kicker="MAINTENANCE" title="Installation & files" description="Read-only runtime state and safe inspection commands. Studio does not execute these commands from this page." />
      <div class="maintenance-summary"><div><span>Installed version</span><strong>{props.snapshot?.version || "Unavailable"}</strong></div><button type="button" class="secondary-button" disabled={props.loading} onClick={props.onReload}>Refresh state</button></div>
      <div class="maintenance-grid">
        <For each={paths()}>{([label, value]) => <div><span>{label.replaceAll("_", " ")}</span><code>{String(value)}</code></div>}</For>
      </div>
      <div class="maintenance-commands">
        <div><strong>Installed runtime</strong><code>amplifier-runtime --version</code><p>Verify that the shared session host is installed and callable.</p></div>
        <div><strong>Provider readiness</strong><code>amplifier-runtime provider status --format json</code><p>Inspect the redacted provider configuration Studio will use.</p></div>
        <div><strong>Settings locations</strong><code>amplifier-runtime config paths --json</code><p>Show the durable global, project, local, and key-file paths.</p></div>
      </div>
      <h4 class="maintenance-history-title">Five most recent redacted settings changes</h4>
      <Show when={props.snapshot?.recentChanges.length} fallback={<div class="settings-empty compact">No settings changes have been recorded yet.</div>}>
        <div class="maintenance-history"><For each={props.snapshot?.recentChanges}>{(change) => <code>{JSON.stringify(change)}</code>}</For></div>
      </Show>
    </div>
  );
}

function ReviewChanges(props: {
  changes: RuntimeSettingChange[];
  studioChanged: boolean;
  theme: StudioTheme;
  sessionHomeChanged: boolean;
  sessionHomeName: string;
  saving: boolean;
  onBack: () => void;
  onApply: () => void;
}) {
  return (
    <div class="settings-review-backdrop">
      <section class="settings-review" role="alertdialog" aria-modal="true" aria-labelledby="settings-review-title">
        <div class="eyebrow">REDACTED REVIEW</div><h3 id="settings-review-title">Save these changes?</h3><p>Runtime changes apply only to sessions started after this save.</p>
        <div class="settings-review-list">
          <Show when={props.studioChanged}><div><span>Studio</span><strong>{props.theme === "made" ? "MADE Paper" : "Studio Night"}</strong><small>{props.sessionHomeChanged ? `session home → ${props.sessionHomeName}` : "appearance"}</small></div></Show>
          <For each={props.changes}>{(change) => {
            const field = runtimeSettingByPath(change.path);
            const rendered = change.action === "unset" ? "unset" : field?.kind === "secret" ? "configured" : change.value;
            return <div><span>{change.scope}</span><strong>{field?.label || change.path}</strong><small>{change.action} → {rendered}</small></div>;
          }}</For>
        </div>
        <div class="settings-review-note">Credentials and secret topics are never shown in this review or returned by the runtime.</div>
        <footer><button type="button" class="secondary-button" disabled={props.saving} onClick={props.onBack}>Back to edit</button><button type="button" class="primary-button" disabled={props.saving} onClick={props.onApply}>{props.saving ? "Saving…" : "Save for next session"}</button></footer>
      </section>
    </div>
  );
}

function sourceName(source?: string): string {
  switch (source) {
    case "env": return "Environment";
    case "keys.env": return "Keys file";
    case "local": return "Local";
    case "project": return "Project";
    case "global": return "Global";
    case "default": return "Default";
    default: return "Unavailable";
  }
}

function scopeDescription(scope: RuntimeSettingScope): string {
  if (scope === "global") return "Your user default across projects";
  if (scope === "project") return "Team-shared .amplifier/settings.yaml";
  return "Machine-specific .amplifier/settings.local.yaml";
}

function cleanError(error: unknown): string {
  return String(error).replace(/^Error:\s*/, "");
}

export function preferredSettingsContext(host: RuntimeHost | undefined, remembered: string | undefined, fallback: string): string {
  const defaultRoot = host?.defaultProjectRoot?.trim() || "";
  const discoveredRoot = defaultRoot || fallback.trim();
  const saved = remembered?.trim() || "";
  if (host?.url && saved && discoveredRoot && !isPathInsideRoot(saved, discoveredRoot)) return discoveredRoot;
  return saved || discoveredRoot;
}

export function settingsContextKey(host: RuntimeHost | undefined): string {
  if (!host) return "local";
  const url = host.url.trim().replace(/\/+$/, "");
  return url ? `${host.id}@${url}` : host.id;
}

function loadSettingsContexts(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_CONTEXTS_KEY) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}
