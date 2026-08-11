import { createMemo, createSignal, For, Show } from "solid-js";
import type { StoredSession } from "../protocol";

interface Props {
  sessions: StoredSession[];
  loading: boolean;
  error?: string;
  onClose: () => void;
  onRefresh: () => void;
  onResume: (session: StoredSession) => void;
}

export function SessionDrawer(props: Props) {
  const [query, setQuery] = createSignal("");
  const visible = createMemo(() => {
    const needle = query().trim().toLocaleLowerCase();
    const sessions = needle
      ? props.sessions.filter((session) =>
          [session.name, session.bundle, session.sessionId, session.projectDir, ...session.tags]
            .filter(Boolean)
            .some((value) => value?.toLocaleLowerCase().includes(needle)),
        )
      : props.sessions;
    return sessions.slice(0, 300);
  });

  return (
    <div class="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <aside class="session-drawer" aria-label="Stored sessions">
        <div class="drawer-heading">
          <div><div class="eyebrow">DURABLE HISTORY</div><h2>Stored sessions</h2></div>
          <button class="icon-button" onClick={props.onClose} aria-label="Close stored sessions">×</button>
        </div>
        <div class="drawer-search">
          <span>⌕</span>
          <input value={query()} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Search names, bundles, tags, ids…" autofocus />
          <button onClick={props.onRefresh} aria-label="Refresh sessions" title="Refresh">↻</button>
        </div>

        <Show when={props.loading}><div class="drawer-state"><span class="mini-spinner" /> Scanning ~/.amplifier/projects…</div></Show>
        <Show when={props.error}><div class="drawer-error">{props.error}</div></Show>
        <Show when={!props.loading && !props.error && visible().length === 0}>
          <div class="drawer-empty"><span>◇</span><strong>No matching sessions</strong><p>Completed Amplifier sessions will appear here.</p></div>
        </Show>

        <div class="stored-list">
          <For each={visible()}>
            {(session) => {
              const resumable = () => session.state === "ok" || session.state === "transcript_lost";
              return (
                <button class="stored-row" disabled={!resumable()} onClick={() => props.onResume(session)}>
                  <div class="stored-topline">
                    <strong>{session.name || `Session ${session.sessionId.slice(0, 8)}`}</strong>
                    <span>{timeAgo(session.mtimeMs)}</span>
                  </div>
                  <div class="stored-meta">
                    <span>{session.bundle}</span><i />
                    <span>{session.turnCount ?? "—"} turns</span><i />
                    <span>{session.messageCount} messages</span>
                  </div>
                  <div class="stored-path">{session.projectDir || session.projectSlug}</div>
                  <div class="stored-bottomline">
                    <code>{session.sessionId.slice(0, 12)}</code>
                    <Show when={session.tags.length}><span class="tag">{session.tags[0]}</span></Show>
                    <span class={`health-state ${session.state}`}>{healthLabel(session.state)}</span>
                  </div>
                  <Show when={!session.projectDir}><span class="unavailable-note">Choose the original project folder to resume</span></Show>
                </button>
              );
            }}
          </For>
        </div>
        <div class="drawer-footer">Showing {visible().length} of {props.sessions.length} top-level sessions</div>
      </aside>
    </div>
  );
}

function healthLabel(state: StoredSession["state"]): string {
  switch (state) {
    case "transcript_lost": return "history damaged";
    case "recovered": return "metadata recovered";
    case "indexing": return "indexing";
    case "corrupt": return "corrupt";
    default: return "ready";
  }
}

function timeAgo(timestamp: number): string {
  if (!timestamp) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(days / 365)}y ago`;
}
