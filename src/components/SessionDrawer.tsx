import { createMemo, createSignal, For, Show } from "solid-js";
import { Blocks, FolderKanban, History, MessageCircle, Plus, RadioTower, RefreshCw, Search, Settings, X } from "lucide-solid";
import type { SessionViewState, StoredSession } from "../protocol";
import { storedSessionResumeBlocker, storedSessionWarning } from "../sessionAvailability";
import { storedSessionMatchesQuery } from "../storedSessions";

interface Props {
  sessions: StoredSession[];
  openSessions: SessionViewState[];
  activeId?: string;
  loading: boolean;
  error?: string;
  warning?: string;
  sourceName: string;
  sessionHomeName: string;
  onClose: () => void;
  onRefresh: () => void;
  onResume: (session: StoredSession) => void | Promise<void>;
  onSelectOpen: (id: string) => void;
  onNew: () => void;
  onCapabilities: () => void;
  onSettings: () => void;
}

export function SessionDrawer(props: Props) {
  const [query, setQuery] = createSignal("");
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [limit, setLimit] = createSignal(300);
  const matching = createMemo(() => {
    const needle = query().trim();
    return needle
      ? props.sessions.filter((session) => storedSessionMatchesQuery(session, needle))
      : props.sessions;
  });
  const visible = createMemo(() => matching().slice(0, limit()));

  return (
    <div class="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <aside class="session-drawer" aria-label="Stored sessions">
        <div class="mobile-drawer-shell">
          <div class="mobile-drawer-header">
            <h2>Amplifier</h2>
            <div>
              <button
                type="button"
                aria-label={searchOpen() ? "Hide session search" : "Search sessions"}
                classList={{ active: searchOpen() }}
                onClick={() => setSearchOpen((open) => !open)}
              ><Search aria-hidden="true" /></button>
              <button type="button" aria-label="Close navigation" onClick={props.onClose}><X aria-hidden="true" /></button>
            </div>
          </div>

          <Show when={searchOpen()}>
            <label class="mobile-drawer-search">
              <Search aria-hidden="true" />
              <input
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search conversations, projects, hosts…"
                aria-label="Search sessions"
                autofocus
              />
              <button type="button" onClick={props.onRefresh} aria-label="Refresh sessions"><RefreshCw aria-hidden="true" /></button>
            </label>
          </Show>

          <nav class="mobile-drawer-nav" aria-label="Amplifier navigation">
            <button type="button" onClick={() => { props.onClose(); props.onNew(); }}><Plus aria-hidden="true" /><span>New session</span></button>
            <button type="button" onClick={() => { props.onClose(); props.onNew(); }}><FolderKanban aria-hidden="true" /><span>Projects</span></button>
            <button type="button" onClick={() => { props.onClose(); props.onCapabilities(); }}><Blocks aria-hidden="true" /><span>Capabilities</span></button>
            <button type="button" onClick={() => { props.onClose(); props.onSettings(); }}><RadioTower aria-hidden="true" /><span>Remote compute</span></button>
          </nav>

          <Show when={props.openSessions.length > 0}>
            <section class="mobile-open-sessions" aria-labelledby="mobile-open-heading">
              <h3 id="mobile-open-heading">Open</h3>
              <For each={props.openSessions}>{(session) => (
                <button
                  type="button"
                  classList={{ active: session.guiId === props.activeId }}
                  onClick={() => { props.onSelectOpen(session.guiId); props.onClose(); }}
                >
                  <MessageCircle aria-hidden="true" />
                  <span><strong>{session.title}</strong><small>{session.activity || session.phase}</small></span>
                  <i class={`phase-${session.phase}`} aria-hidden="true" />
                </button>
              )}</For>
            </section>
          </Show>

          <section class="mobile-recent-sessions" aria-labelledby="mobile-recent-heading">
            <h3 id="mobile-recent-heading"><History aria-hidden="true" /> Recent</h3>
          </section>
        </div>

        <div class="drawer-heading">
          <div><div class="eyebrow">DURABLE HISTORY · {props.sourceName}</div><h2>Stored sessions</h2></div>
          <button class="icon-button" onClick={props.onClose} aria-label="Close stored sessions">×</button>
        </div>
        <div class="drawer-search">
          <span>⌕</span>
          <input value={query()} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Search conversations, projects, hosts…" autofocus />
          <button onClick={props.onRefresh} aria-label="Refresh sessions" title="Refresh">↻</button>
        </div>

        <Show when={props.loading}><div class="drawer-state"><span class="mini-spinner" /> Scanning ~/.amplifier/projects…</div></Show>
        <Show when={props.error}><div class="drawer-error">{props.error}</div></Show>
        <Show when={!props.loading && !props.error && visible().length === 0}>
          <div class="drawer-empty"><span>◇</span><strong>No matching sessions</strong><p>Completed Amplifier sessions will appear here.</p></div>
        </Show>

        <div class="stored-list">
          <Show when={props.warning}><div class="drawer-warning">{props.warning}</div></Show>
          <For each={visible()}>
            {(session) => {
              const blocker = () => storedSessionResumeBlocker(session, false);
              const note = () => blocker() || storedSessionWarning(session);
              return (
                <button class="stored-row" classList={{ "needs-recovery": Boolean(blocker()) }} title={note()} onClick={() => void props.onResume(session)}>
                  <div class="stored-topline">
                    <strong>{session.name}</strong>
                    <span>{timeAgo(session.mtimeMs)}</span>
                  </div>
                  <p class="stored-summary">{session.summary}</p>
                  <div class="stored-meta">
                    <span>{session.hostName || "This computer"}</span><i />
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
                  <Show when={note()} keyed>{(message) => <span class="unavailable-note">{message}</span>}</Show>
                </button>
              );
            }}
          </For>
          <Show when={visible().length < matching().length}>
            <button class="drawer-load-more" type="button" onClick={() => setLimit((value) => value + 300)}>
              Show 300 more <span>{matching().length - visible().length} remaining</span>
            </button>
          </Show>
        </div>
        <div class="drawer-footer">
          {props.sourceName} · showing {visible().length} of {matching().length} matches · search covers {props.sessions.length} sessions across compute
        </div>
        <div class="mobile-drawer-footer">
          <button type="button" class="mobile-new-session" onClick={() => { props.onClose(); props.onNew(); }}><Plus aria-hidden="true" /><span>New session</span></button>
          <button type="button" class="mobile-runtime-settings" onClick={() => { props.onClose(); props.onSettings(); }}>
            <span class="mobile-runtime-avatar"><RadioTower aria-hidden="true" /></span>
            <span><strong>{props.sessionHomeName}</strong><small>Default for new sessions</small></span>
            <Settings aria-hidden="true" />
          </button>
        </div>
      </aside>
    </div>
  );
}

function healthLabel(state: StoredSession["state"]): string {
  switch (state) {
    case "transcript_lost": return "history damaged";
    case "recovered": return "metadata recovered";
    case "indexing": return "metadata missing";
    case "empty": return "empty run";
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
