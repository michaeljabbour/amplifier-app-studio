import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ArrowLeft, Plus, RefreshCw } from "lucide-solid";
import type {
  TerminalCoordinatorContract,
  TerminalCoordinatorSnapshot,
  TerminalProjectIdentity,
  TerminalSession,
} from "../terminal";
import {
  renameDraftFor,
  renameDraftSubmission,
  type TerminalRenameDraft,
} from "../terminal/sessionDrafts";
import { TerminalEmulator } from "./TerminalEmulator";
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
  const [creating, setCreating] = createSignal(false);
  const [renameDraft, setRenameDraft] = createSignal<TerminalRenameDraft>();
  const [working, setWorking] = createSignal<string>();
  const [actionError, setActionError] = createSignal<string>();

  const selected = createMemo(() => state().sessions.find((terminal) => terminal.id === state().selectedId));

  onMount(() => {
    const unsubscribe = props.coordinator.subscribe(setState);
    onCleanup(unsubscribe);
    const initial = selected();
    if (initial?.connection.status === "detached") {
      void props.coordinator.attach(initial.id).catch(showError);
    } else if (state().sessions.length === 0) {
      void props.coordinator.refresh()
        .then((sessions) => sessions[0] && props.coordinator.attach(sessions[0].id))
        .catch(showError);
    }
  });

  const showError = (error: unknown) => setActionError(message(error));

  const run = async (label: string, task: () => Promise<unknown>) => {
    if (working()) return;
    setWorking(label);
    setActionError(undefined);
    try {
      await task();
    } catch (error) {
      showError(error);
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

  const submitRename = async (event: SubmitEvent, terminalId: string) => {
    event.preventDefault();
    const submission = renameDraftSubmission(renameDraft(), terminalId);
    if (!submission) return;
    await run("rename", async () => {
      const renamed = await props.coordinator.rename(submission.terminalId, submission.value);
      setRenameDraft(undefined);
      await props.coordinator.attach(renamed.id);
    });
  };

  const selectTerminal = (terminal: TerminalSession) => {
    props.coordinator.select(terminal.id);
    if (terminal.connection.status === "detached") {
      void run("attach", () => props.coordinator.attach(terminal.id));
    }
  };

  const terminate = async (terminal: TerminalSession) => {
    const confirmed = props.confirmTerminate
      ? await props.confirmTerminate(terminal)
      : window.confirm(`Terminate ${terminal.name}? Its running processes will stop.`);
    if (confirmed) await run("terminate", () => props.coordinator.terminate(terminal.id));
  };

  return (
    <section class="terminal-work-surface" aria-label="Terminal sessions">
      <Show when={actionError() || state().error} keyed>{(error) => (
        <div class="terminal-error" role="alert">{error}</div>
      )}</Show>

      <div class="terminal-work-layout">
        <nav class="terminal-rail" aria-label="Available terminals">
          <div class="terminal-rail-heading">
            <div>
              <Show when={props.onClose}>
                <button type="button" class="terminal-back" onClick={() => props.onClose?.()} aria-label="Return to Agent">
                  <ArrowLeft aria-hidden="true" />
                </button>
              </Show>
              <strong>{props.title || "Terminals"}</strong>
            </div>
            <div>
              <button
                type="button"
                title="Refresh terminals"
                aria-label="Refresh terminals"
                onClick={() => void run("refresh", () => props.coordinator.refresh())}
                disabled={state().refreshing || Boolean(working())}
              ><RefreshCw aria-hidden="true" /></button>
              <button
                type="button"
                class="primary"
                title="New terminal"
                aria-label="New terminal"
                onClick={() => setCreating((value) => !value)}
              ><Plus aria-hidden="true" /></button>
            </div>
          </div>

          <Show when={creating()}>
            <form class="terminal-create" onSubmit={(event) => void createTerminal(event)}>
              <label for="terminal-create-name">New terminal</label>
              <input
                id="terminal-create-name"
                value={createName()}
                onInput={(event) => setCreateName(event.currentTarget.value)}
                placeholder="session-name"
                autocomplete="off"
                autofocus
              />
              <div>
                <button type="submit" class="primary" disabled={!createName().trim() || Boolean(working())}>Create</button>
                <button type="button" onClick={() => setCreating(false)}>Cancel</button>
              </div>
            </form>
          </Show>

          <div class="terminal-rail-list">
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
          </div>
        </nav>

        <Show when={selected()?.id} keyed fallback={(
          <div class="terminal-empty"><strong>Select a terminal</strong><span>Its live session will appear here.</span></div>
        )}>{(terminalId) => {
          const terminal = () => state().sessions.find((candidate) => candidate.id === terminalId)!;
          return (
            <article class="terminal-stage">
              <header class="terminal-session-heading">
                <div class="terminal-session-identity">
                  <Show when={renameDraftFor(renameDraft(), terminalId) !== undefined} fallback={(
                    <>
                      <strong>{terminal().name}</strong>
                      <code>{terminal().cwd || terminal().project?.root || "Working directory unavailable"}</code>
                    </>
                  )}>
                    <form onSubmit={(event) => void submitRename(event, terminalId)}>
                      <input
                        value={renameDraftFor(renameDraft(), terminalId) || ""}
                        onInput={(event) => setRenameDraft({ terminalId, value: event.currentTarget.value })}
                        aria-label="New terminal name"
                        autofocus
                      />
                      <button type="submit" disabled={!renameDraftSubmission(renameDraft(), terminalId) || Boolean(working())}>Save</button>
                      <button type="button" onClick={() => setRenameDraft(undefined)}>Cancel</button>
                    </form>
                  </Show>
                </div>
                <div class="terminal-session-actions">
                  <span class={`terminal-connection ${terminal().connection.status}`}>{connectionLabel(terminal())}</span>
                  <button type="button" onClick={() => setRenameDraft({ terminalId, value: terminal().name })} disabled={!terminal().capabilities.rename || Boolean(working())}>Rename</button>
                  <Show
                    when={terminal().connection.status !== "detached"}
                    fallback={<button type="button" onClick={() => void run("attach", () => props.coordinator.attach(terminalId))} disabled={!terminal().capabilities.attach || Boolean(working())}>Attach</button>}
                  >
                    <button type="button" onClick={() => void run("detach", () => props.coordinator.detach(terminalId))} disabled={!terminal().capabilities.detach || Boolean(working())}>Detach</button>
                  </Show>
                  <button type="button" class="danger" onClick={() => void terminate(terminal())} disabled={!terminal().capabilities.terminate || Boolean(working())}>Terminate</button>
                </div>
              </header>

              <Show when={terminal().connection.status === "reconnecting" || terminal().connection.status === "error"}>
                <div class="terminal-reconnect" role="status">
                  <span>{terminal().connection.message || "The live stream is interrupted."}</span>
                  <button type="button" onClick={() => void run("reconnect", () => props.coordinator.reconnect(terminalId))} disabled={Boolean(working())}>Reconnect</button>
                </div>
              </Show>

              <Show when={terminal().capabilities.send !== "input"}>
                <div class="terminal-readonly" role="status">
                  <strong>Read-only</strong>
                  <span>This host permits viewing but not terminal input.</span>
                </div>
              </Show>

              <div class="terminal-screen-shell">
                <TerminalEmulator session={terminal()} coordinator={props.coordinator} onError={showError} />
              </div>
            </article>
          );
        }}</Show>
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
    "read-only": "Read-only",
    error: "Error",
    terminated: "Ended",
  };
  return labels[terminal.connection.status];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
