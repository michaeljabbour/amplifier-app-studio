import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { BookOpen, X } from "lucide-solid";
import { keepModalFocus } from "../focusTrap";
import { conversationEntries, type ConversationEntry, type HistoryOperation } from "../sessionHistory";
import type { ProtocolRecord } from "../protocol";
import { Markdown } from "./Markdown";

interface Props {
  title: string;
  supported: boolean;
  request: (op: HistoryOperation, args: Record<string, unknown>) => Promise<ProtocolRecord>;
  onClose: () => void;
}

/** A bounded conversation browser, independent of the live transcript and composer. */
export function ConversationHistory(props: Props) {
  const [entries, setEntries] = createSignal<ConversationEntry[]>([]);
  const [windowEntries, setWindowEntries] = createSignal<ConversationEntry[]>([]);
  const [selected, setSelected] = createSignal<string>();
  const [generation, setGeneration] = createSignal<string>();
  const [nextCursor, setNextCursor] = createSignal<string>();
  const [page, setPage] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  const [windowLoading, setWindowLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let cursors: Array<string | undefined> = [undefined];
  let selectionVersion = 0;
  let disposed = false;
  let closeButton: HTMLButtonElement | undefined;
  let detailPanel: HTMLElement | undefined;
  const initialFocus = document.activeElement;

  const load = async (pageIndex: number) => {
    selectionVersion += 1;
    setLoading(true);
    setWindowLoading(false);
    setError(undefined);
    setWindowEntries([]);
    setSelected(undefined);
    try {
      const response = await props.request("history.outline", { cursor: cursors[pageIndex], limit: 50 });
      if (disposed) return;
      if (typeof response.generation !== "string") throw new Error("The runtime did not identify this history generation");
      setEntries(conversationEntries(response, "entries"));
      setGeneration(response.generation);
      setNextCursor(typeof response.next_cursor === "string" ? response.next_cursor : undefined);
      setPage(pageIndex);
    } catch (caught) {
      if (!disposed) {
        setEntries([]);
        setNextCursor(undefined);
        setError(String(caught).replace(/^Error:\s*/, ""));
      }
    } finally {
      if (!disposed) setLoading(false);
    }
  };

  const select = async (entry: ConversationEntry) => {
    const version = ++selectionVersion;
    setSelected(entry.eventId);
    setWindowEntries([]);
    setWindowLoading(true);
    setError(undefined);
    try {
      const response = await props.request("history.window", { event_id: entry.eventId, generation: generation(), before: 2, after: 2 });
      if (disposed || version !== selectionVersion) return;
      setWindowEntries(conversationEntries(response, "records"));
      detailPanel?.scrollTo?.({ top: 0 });
    } catch (caught) {
      if (!disposed && version === selectionVersion) setError(String(caught).replace(/^Error:\s*/, ""));
    } finally {
      if (!disposed && version === selectionVersion) setWindowLoading(false);
    }
  };

  onMount(() => {
    closeButton?.focus();
    if (props.supported) void load(0);
  });
  onCleanup(() => {
    disposed = true;
    if (initialFocus instanceof HTMLElement && initialFocus.isConnected) initialFocus.focus();
  });

  return (
    <div class="modal-backdrop conversation-history-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) props.onClose();
    }} onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); props.onClose(); }
      else keepModalFocus(event, '[aria-labelledby="conversation-history-title"]');
    }}>
      <section class="conversation-history" role="dialog" aria-modal="true" aria-labelledby="conversation-history-title">
        <header class="conversation-history-header">
          <div><span class="eyebrow">CONVERSATION</span><h2 id="conversation-history-title"><BookOpen aria-hidden="true" /> Conversation outline</h2><p>{props.title}</p></div>
          <button ref={closeButton} class="icon-button" type="button" aria-label="Close conversation outline" onClick={props.onClose}><X aria-hidden="true" /></button>
        </header>
        <p class="conversation-history-intro">Browse earlier prompts and responses while the live session continues. Select an entry to read the conversation around it.</p>
        <Show when={props.supported} fallback={<p class="conversation-history-unavailable" role="status">This runtime does not support conversation navigation. Use the session transcript, or connect with an updated Runtime.</p>}>
          <Show when={error()}>{(message) => <div class="conversation-history-error" role="alert"><p>{message()}</p><button type="button" disabled={loading()} onClick={() => { cursors = [undefined]; void load(0); }}>Reload outline</button></div>}</Show>
          <div class="conversation-history-content">
            <nav class="conversation-history-list" aria-label="Conversation entries" aria-busy={loading()}>
              <Show when={!loading()} fallback={<p role="status">Loading outline…</p>}>
                <Show when={entries().length} fallback={<p>No conversation entries are available.</p>}>
                  <For each={entries()}>{(entry) => <button type="button" classList={{ selected: selected() === entry.eventId }} aria-current={selected() === entry.eventId ? "true" : undefined} onClick={() => void select(entry)}><span>{entry.kind === "prompt_submit" ? "You" : "Amplifier"}</span><p>{entry.text || "Empty message"}</p></button>}</For>
                </Show>
              </Show>
            </nav>
            <section ref={detailPanel} class="conversation-history-detail" aria-label="Selected conversation" aria-busy={windowLoading()}>
              <Show when={!windowLoading()} fallback={<p role="status">Loading conversation…</p>}>
                <Show when={windowEntries().length} fallback={<p class="conversation-history-empty">Select a prompt or response from the outline.</p>}>
                  <For each={windowEntries()}>{(entry) => <article classList={{ target: selected() === entry.eventId }}><header><strong>{entry.kind === "prompt_submit" ? "You" : "Amplifier"}</strong><Show when={selected() === entry.eventId}><span>Selected entry</span></Show></header><Markdown text={entry.text} /></article>}</For>
                </Show>
              </Show>
            </section>
          </div>
          <footer class="conversation-history-footer"><span>Page {page() + 1} · up to 50 entries</span><div><button type="button" disabled={loading() || page() === 0} onClick={() => void load(page() - 1)}>Previous</button><button type="button" disabled={loading() || !nextCursor()} onClick={() => { cursors[page() + 1] = nextCursor(); void load(page() + 1); }}>Next</button></div></footer>
        </Show>
      </section>
    </div>
  );
}
