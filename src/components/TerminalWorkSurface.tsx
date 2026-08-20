import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ArrowLeft } from "lucide-solid";
import type {
  TerminalCoordinatorContract,
  TerminalCoordinatorSnapshot,
  TerminalInputRequest,
  TerminalProjectIdentity,
  TerminalSession,
} from "../terminal";
import { terminalPlainText } from "../terminalPlainText";
import "./TerminalWorkSurface.css";

interface Props {
  coordinator: TerminalCoordinatorContract;
  title?: string;
  project?: TerminalProjectIdentity;
  onClose?: () => void;
  confirmTerminate?: (terminal: TerminalSession) => boolean | Promise<boolean>;
}

export function TerminalWorkSurface(props: Props) {
  const [state, setState] = createSignal<TerminalCoordinatorSnapshot>(props.coordinator.snapshot());
  const [createName, setCreateName] = createSignal("");
  const [renameValue, setRenameValue] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  const [renaming, setRenaming] = createSignal(false);
  const [command, setCommand] = createSignal("");
  const [working, setWorking] = createSignal<string>();
  const [actionError, setActionError] = createSignal<string>();
  let terminalViewport: HTMLPreElement | undefined;
  let resizeObserver: ResizeObserver | undefined;

  const selected = createMemo(() => state().sessions.find((terminal) => terminal.id === state().selectedId));
  const visibleOutput = createMemo(() => terminalPlainText(`${selected()?.snapshot || ""}${selected()?.liveOutput || ""}`));

  onMount(() => {
    const unsubscribe = props.coordinator.subscribe(setState);
    onCleanup(unsubscribe);
    const initial = selected();
    if (initial?.connection.status === "detached") {
      void props.coordinator.attach(initial.id).catch((error) => setActionError(message(error)));
    } else if (state().sessions.length === 0) {
      void props.coordinator.refresh()
        .then((sessions) => sessions[0] && props.coordinator.attach(sessions[0].id))
        .catch((error) => setActionError(message(error)));
    }
  });

  createEffect(() => {
    const id = selected()?.id;
    const element = terminalViewport;
    resizeObserver?.disconnect();
    resizeObserver = undefined;
    if (!id || !element || typeof ResizeObserver === "undefined") return;
    resizeObserver = new ResizeObserver(([entry]) => {
      const columns = Math.max(20, Math.floor(entry.contentRect.width / 8.2));
      const rows = Math.max(6, Math.floor(entry.contentRect.height / 18));
      void props.coordinator.resize(id, { columns, rows });
    });
    resizeObserver.observe(element);
  });
  onCleanup(() => resizeObserver?.disconnect());

  createEffect(() => {
    visibleOutput();
    queueMicrotask(() => {
      if (terminalViewport) terminalViewport.scrollTop = terminalViewport.scrollHeight;
    });
  });

  const run = async (label: string, task: () => Promise<unknown>) => {
    if (working()) return;
    setWorking(label);
    setActionError(undefined);
    try {
      await task();
    } catch (error) {
      setActionError(message(error));
    } finally {
      setWorking(undefined);
    }
  };

  const createTerminal = async (event: SubmitEvent) => {
    event.preventDefault();
    const name = createName().trim();
    if (!name) return;
    await run("create", async () => {
      const terminal = await props.coordinator.create({ name, project: props.project });
      setCreateName("");
      setCreating(false);
      await props.coordinator.attach(terminal.id);
    });
  };

  const submitRename = async (event: SubmitEvent) => {
    event.preventDefault();
    const terminal = selected();
    const name = renameValue().trim();
    if (!terminal || !name) return;
    await run("rename", async () => {
      const renamed = await props.coordinator.rename(terminal.id, name);
      setRenaming(false);
      await props.coordinator.attach(renamed.id);
    });
  };

  const send = async (request: TerminalInputRequest) => {
    const terminal = selected();
    if (!terminal) return;
    await run("send", async () => {
      await props.coordinator.send(terminal.id, request);
      if (request.text) setCommand("");
    });
  };

  const selectTerminal = (terminal: TerminalSession) => {
    props.coordinator.select(terminal.id);
    if (terminal.connection.status === "detached") {
      void run("attach", () => props.coordinator.attach(terminal.id));
    }
  };

  const terminate = async () => {
    const terminal = selected();
    if (!terminal) return;
    const confirmed = props.confirmTerminate
      ? await props.confirmTerminate(terminal)
      : window.confirm(`Terminate ${terminal.name}? Its running processes will stop.`);
    if (confirmed) await run("terminate", () => props.coordinator.terminate(terminal.id));
  };

  return (
    <section class="terminal-work-surface" aria-label="Terminal sessions">
      <header class="terminal-work-heading">
        <div>
          <span class="eyebrow">COMPUTE WORKSPACE</span>
          <h2>{props.title || "Terminal sessions"}</h2>
          <p>Run and supervise durable PTY work without leaving Amplifier Studio.</p>
        </div>
        <div class="terminal-heading-actions">
          <Show when={props.onClose}>
            <button type="button" class="terminal-back" onClick={() => props.onClose?.()}>
              <ArrowLeft aria-hidden="true" />
              <span>Agent</span>
            </button>
          </Show>
          <button type="button" onClick={() => void run("refresh", () => props.coordinator.refresh())} disabled={state().refreshing || Boolean(working())}>
            {state().refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <button type="button" class="primary" onClick={() => setCreating((value) => !value)}>New terminal</button>
        </div>
      </header>

      <Show when={creating()}>
        <form class="terminal-create" onSubmit={(event) => void createTerminal(event)}>
          <label for="terminal-create-name">Terminal name</label>
          <input
            id="terminal-create-name"
            value={createName()}
            onInput={(event) => setCreateName(event.currentTarget.value)}
            placeholder="studio-build"
            autocomplete="off"
            autofocus
          />
          <button type="submit" class="primary" disabled={!createName().trim() || Boolean(working())}>Create</button>
          <button type="button" onClick={() => setCreating(false)}>Cancel</button>
        </form>
      </Show>

      <Show when={actionError() || state().error} keyed>{(error) => (
        <div class="terminal-error" role="alert">{error}</div>
      )}</Show>

      <div class="terminal-work-layout">
        <nav class="terminal-rail" aria-label="Available terminals">
          <Show when={state().sessions.length} fallback={<p>No terminals found on this host.</p>}>
            <For each={state().sessions}>{(terminal) => (
              <button
                type="button"
                class="terminal-rail-item"
                classList={{ active: terminal.id === state().selectedId, attention: terminal.attention.needsAttention }}
                aria-current={terminal.id === state().selectedId ? "page" : undefined}
                onClick={() => selectTerminal(terminal)}
              >
                <span class={`terminal-state-dot ${terminal.connection.status}`} aria-hidden="true" />
                <span>
                  <strong>{terminal.name}</strong>
                  <small>{terminal.project?.label || terminal.host.label}</small>
                </span>
                <Show when={terminal.attention.needsAttention}>
                  <b aria-label={`${terminal.attention.unseenCount} attention alerts`}>{terminal.attention.unseenCount}</b>
                </Show>
              </button>
            )}</For>
          </Show>
        </nav>

        <Show when={selected()} fallback={(
          <div class="terminal-empty"><strong>Select a terminal</strong><span>Its live output, controls, and history will appear here.</span></div>
        )} keyed>{(terminal) => (
          <article class="terminal-stage">
            <header class="terminal-session-heading">
              <div>
                <span>{terminal.host.label} · {terminal.project?.label || "No project"}</span>
                <Show when={renaming()} fallback={<h3>{terminal.name}</h3>}>
                  <form onSubmit={(event) => void submitRename(event)}>
                    <input value={renameValue()} onInput={(event) => setRenameValue(event.currentTarget.value)} aria-label="New terminal name" autofocus />
                    <button type="submit" disabled={!renameValue().trim() || Boolean(working())}>Save</button>
                    <button type="button" onClick={() => setRenaming(false)}>Cancel</button>
                  </form>
                </Show>
                <code>{terminal.cwd || terminal.project?.root || "Working directory unavailable"}</code>
              </div>
              <div class="terminal-session-actions">
                <span class={`terminal-connection ${terminal.connection.status}`}>{connectionLabel(terminal)}</span>
                <button type="button" onClick={() => {
                  setRenameValue(terminal.name);
                  setRenaming(true);
                }} disabled={!terminal.capabilities.rename || Boolean(working())}>Rename</button>
                <Show
                  when={terminal.connection.status !== "detached"}
                  fallback={<button type="button" onClick={() => void run("attach", () => props.coordinator.attach(terminal.id))} disabled={!terminal.capabilities.attach || Boolean(working())}>Attach</button>}
                >
                  <button type="button" onClick={() => void run("detach", () => props.coordinator.detach(terminal.id))} disabled={!terminal.capabilities.detach || Boolean(working())}>Detach</button>
                </Show>
                <button type="button" class="danger" onClick={() => void terminate()} disabled={!terminal.capabilities.terminate || Boolean(working())}>Terminate</button>
              </div>
            </header>

            <Show when={terminal.connection.status === "reconnecting" || terminal.connection.status === "error"}>
              <div class="terminal-reconnect" role="status">
                <span>{terminal.connection.message || "The live stream is interrupted."}</span>
                <button type="button" onClick={() => void run("reconnect", () => props.coordinator.reconnect(terminal.id))} disabled={Boolean(working())}>Reconnect</button>
              </div>
            </Show>

            <Show when={terminal.capabilities.send !== "input"}>
              <div class="terminal-readonly" role="status">
                <strong>Read-only terminal</strong>
                <span>Live output and scrollback remain available. Input requires an operator-approved host policy.</span>
              </div>
            </Show>

            <div class="terminal-screen-shell">
              <div class="terminal-screen-toolbar">
                <span>{terminal.scrollback ? `${terminal.scrollback.total} retained rows` : "Live pane"}</span>
                <button
                  type="button"
                  disabled={!terminal.scrollback?.hasMore || Boolean(working())}
                  onClick={() => void run("older", () => props.coordinator.loadOlder(terminal.id))}
                >Load older output</button>
              </div>
              <pre ref={terminalViewport} class="terminal-screen" tabindex="0" aria-label={`Terminal output for ${terminal.name}`}>
                {visibleOutput() || "Waiting for terminal output…"}
              </pre>
            </div>

            <form class="terminal-command-bar" onSubmit={(event) => {
              event.preventDefault();
              if (command().trim()) void send({ text: command(), enter: true, captureLines: 200, mode: "command" });
            }}>
              <label for={`terminal-command-${terminal.id}`}>Send to {terminal.name}</label>
              <textarea
                id={`terminal-command-${terminal.id}`}
                rows="2"
                value={command()}
                onInput={(event) => setCommand(event.currentTarget.value)}
                placeholder={terminal.capabilities.send === "input" ? "Type a command or response…" : "Input is disabled by host policy"}
                disabled={terminal.capabilities.send !== "input" || Boolean(working())}
              />
              <div>
                <button type="button" onClick={() => void send({ keys: ["C-c"], mode: "command" })} disabled={terminal.capabilities.send !== "input" || Boolean(working())}>Stop</button>
                <button type="button" onClick={() => void send({ keys: ["Escape"], mode: "command" })} disabled={terminal.capabilities.send !== "input" || Boolean(working())}>Escape</button>
                <button type="submit" class="primary" disabled={terminal.capabilities.send !== "input" || !command().trim() || Boolean(working())}>
                  {working() === "send" ? "Sending…" : "Send"}
                </button>
              </div>
            </form>
          </article>
        )}</Show>
      </div>
    </section>
  );
}

function connectionLabel(terminal: TerminalSession): string {
  const labels: Record<TerminalSession["connection"]["status"], string> = {
    detached: "Detached",
    attaching: "Attaching",
    attached: "Live",
    reconnecting: "Reconnecting",
    "read-only": "Live · read-only",
    error: "Connection error",
    terminated: "Ended",
  };
  return labels[terminal.connection.status];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
