import { popoverDismiss } from "./popoverDismiss";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { SessionViewState } from "../protocol";

export function ModeControl(props: { state: SessionViewState; onRefresh?: () => void; onSet?: (names: string[]) => void }) {
  const [open, setOpen] = createSignal(false);
  let popoverRoot: HTMLDivElement | undefined;
  const dismiss = popoverDismiss(() => popoverRoot, open, () => setOpen(false));
  const [query, setQuery] = createSignal("");
  const [selection, setSelection] = createSignal<string[]>([]);
  const supported = () => Boolean(props.state.runtimeCapabilities?.operations["modes.get"]);
  const canSet = () => Boolean(props.state.runtimeCapabilities?.operations["modes.set"]);
  const modes = () => props.state.nativeModes;
  const incompatible = () => selection().length > 1 && selection().some((name) => modes()?.modes.some((mode) => mode.name === name && mode.combinable === false));
  const changed = () => JSON.stringify(selection()) !== JSON.stringify(modes()?.active || []);
  const filtered = createMemo(() => (modes()?.modes || []).filter((mode) => `${mode.name} ${mode.description} ${mode.source}`.toLowerCase().includes(query().toLowerCase())));
  let lastSession: string | undefined;
  let lastActive: string | undefined;
  createEffect(() => {
    const id = props.state.guiId;
    const active = props.state.nativeModes?.active;
    if (id !== lastSession) { setOpen(false); setQuery(""); }
    const activeKey = JSON.stringify(active || []);
    if (id !== lastSession || activeKey !== lastActive) setSelection(active || []);
    lastSession = id; lastActive = activeKey;
  });
  let trigger: HTMLButtonElement | undefined;
  const close = () => { setOpen(false); trigger?.focus(); };
  return <div ref={popoverRoot} class="mode-control" onFocusOut={dismiss} onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
    <button ref={trigger} type="button" class="footer-mode" aria-haspopup="dialog" aria-expanded={open()} aria-label="Choose Amplifier modes" onClick={() => {
      setSelection(modes()?.active || []); setQuery(""); setOpen((value) => !value);
      if (open() && supported()) props.onRefresh?.();
    }}>Modes <Show when={modes()?.active.length}><strong>{modes()!.active.join(" + ")}</strong></Show><span aria-hidden="true">⌃</span></button>
    <Show when={open()}><section class="mode-popover" role="dialog" aria-label="Amplifier modes">
      <header><strong>Amplifier modes</strong><button type="button" onClick={close} aria-label="Close mode menu">×</button></header>
      <p>Session posture: {props.state.mode}. Modes add bundle-specific instructions and tool policies.</p>
      <Show when={supported()} fallback={<p role="status">{props.state.runtimeCapabilities ? "This runtime does not expose mode controls yet. A runtime update is needed for this menu." : "Waiting for the runtime to report its capabilities…"}</p>}>
        <Show when={modes()} fallback={<p role="status">Loading this session’s modes…</p>}>
          <p>{modes()!.maxActive === 1 ? "This runtime enforces one mode at a time. Selecting another replaces it." : `Select up to ${modes()!.maxActive} modes. All instructions apply; the strictest tool rule wins.`}</p>
          <input type="search" autocapitalize="off" autocorrect="off" spellcheck={false} aria-label="Search Amplifier modes" placeholder="Find a mode…" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} />
          <div class="mode-options">
            <For each={filtered()}>{(mode) => <label>
              <input type={modes()!.maxActive === 1 ? "radio" : "checkbox"} name="amplifier-native-mode" checked={selection().includes(mode.name)} disabled={Boolean(modes()?.pendingRequest) || props.state.busy || !canSet()} onChange={() => setSelection((current) => modes()!.maxActive === 1 ? [mode.name] : current.includes(mode.name) ? current.filter((name) => name !== mode.name) : current.length < modes()!.maxActive ? [...current, mode.name] : current)} />
              <span><strong>{mode.name}</strong><small>{mode.source}{mode.combinable === false ? " · individual only" : ""}{!mode.advertised ? " · human-only" : ""}{modes()!.active.includes(mode.name) ? " · active" : ""}</small><span>{mode.description}</span></span>
            </label>}</For>
            <Show when={!filtered().length}><p>No matching modes in this session’s bundle.</p></Show>
          </div>
          <Show when={incompatible()}><p role="alert">Modes marked individual only add runtime capabilities and must run on their own.</p></Show>
          <Show when={modes()?.error}><p class="mode-error" role="alert">{modes()!.error}</p></Show>
          <Show when={props.state.busy}><p role="status">Mode changes are available after this turn finishes.</p></Show>
          <footer><button type="button" disabled={!canSet() || props.state.busy || Boolean(modes()?.pendingRequest)} onClick={() => setSelection([])}>Clear selection</button><button type="button" disabled={incompatible() || !changed() || !canSet() || props.state.busy || Boolean(modes()?.pendingRequest)} onClick={() => props.onSet?.(selection())}>{modes()?.pendingRequest ? "Applying…" : "Apply modes"}</button></footer>
        </Show>
        <button type="button" class="mode-refresh" onClick={() => props.onRefresh?.()}>Refresh available modes</button>
      </Show>
    </section></Show>
  </div>;
}
