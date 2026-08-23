import { createMemo, createSignal, For, Show } from "solid-js";
import { Blocks, FolderKanban, History, MessageCircle, MoreHorizontal, Plus, RadioTower, RefreshCw, Search, Settings, Square, Unplug, X } from "lucide-solid";
import type { SessionViewState, StoredSession } from "../protocol";
import { storedSessionResumeBlocker, storedSessionShouldList, storedSessionWarning } from "../sessionAvailability";
import { storedSessionMatchesQuery, storedSessionSourceKind, storedSessionSourceLabel } from "../storedSessions";
import { keepModalFocus } from "../focusTrap";

interface Props {
  sessions: StoredSession[];
  openSessions: SessionViewState[];
  detachedSessionIds: string[];
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
  onDetachOpen: (id: string) => void | Promise<void>;
  onStopOpen: (id: string) => void | Promise<void>;
  onNew: () => void;
  onCapabilities: () => void;
  onSettings: () => void;
}

export function SessionDrawer(props: Props) {
  const [query, setQuery] = createSignal("");
  const [sourceFilter, setSourceFilter] = createSignal<"all" | "local" | "remote">("all");
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [openSessionMenu, setOpenSessionMenu] = createSignal<string>();
  const [limit, setLimit] = createSignal(1_000);
  const detachedSessionIds = createMemo(() => new Set(props.detachedSessionIds));
  const detachedOpenSessions = createMemo(() => props.openSessions.filter((session) => detachedSessionIds().has(session.guiId)));
  const matching = createMemo(() => {
    const needle = query().trim();
    const source = sourceFilter();
    const resumable = props.sessions.filter(storedSessionShouldList);
    const fromSource = source === "all"
      ? resumable
      : resumable.filter((session) => storedSessionSourceKind(session) === source);
    return needle
      ? fromSource.filter((session) => storedSessionMatchesQuery(session, needle))
      : fromSource;
  });
  const sourceCounts = createMemo(() => props.sessions
    .filter(storedSessionShouldList)
    .reduce((counts, session) => {
      counts[storedSessionSourceKind(session)] += 1;
      return counts;
    }, { local: 0, remote: 0 }));
  const visible = createMemo(() => matching().slice(0, limit()));
  const revealMoreNearBottom = (event: Event) => {
    const list = event.currentTarget as HTMLDivElement;
    if (visible().length >= matching().length) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 320) {
      setLimit((value) => value + 500);
    }
  };

  return (
    <div
      class="drawer-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onClose();
        else keepModalFocus(event);
      }}
    >
      <aside class="session-drawer" role="dialog" aria-modal="true" aria-label="Stored sessions">
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
                <div class="mobile-open-session" classList={{ active: session.guiId === props.activeId }}>
                  <button
                    type="button"
                    class="mobile-open-session-select"
                    onClick={() => { props.onSelectOpen(session.guiId); props.onClose(); }}
                  >
                    <MessageCircle aria-hidden="true" />
                    <span><strong>{session.title}</strong><small>{session.activity || session.phase}</small></span>
                    <i class={`phase-${session.phase}`} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    class="mobile-open-session-more"
                    aria-label={`Session actions for ${session.title}`}
                    aria-expanded={openSessionMenu() === session.guiId}
                    onClick={() => setOpenSessionMenu((open) => open === session.guiId ? undefined : session.guiId)}
                  ><MoreHorizontal aria-hidden="true" /></button>
                  <Show when={openSessionMenu() === session.guiId}>
                    <div class="mobile-open-session-menu" role="menu" aria-label={`Actions for ${session.title}`}>
                      <Show
                        when={!detachedSessionIds().has(session.guiId)}
                        fallback={<button type="button" role="menuitem" onClick={() => { setOpenSessionMenu(undefined); props.onSelectOpen(session.guiId); props.onClose(); }}>
                          <MessageCircle aria-hidden="true" /><span><strong>Reopen</strong><small>Return to this live runtime</small></span>
                        </button>}
                      >
                        <button type="button" role="menuitem" onClick={() => { setOpenSessionMenu(undefined); void props.onDetachOpen(session.guiId); }}>
                          <Unplug aria-hidden="true" /><span><strong>Detach</strong><small>Leave the runtime running</small></span>
                        </button>
                      </Show>
                      <button type="button" role="menuitem" class="danger" onClick={() => { setOpenSessionMenu(undefined); void props.onStopOpen(session.guiId); }}>
                        <Square aria-hidden="true" /><span><strong>Stop</strong><small>End the runtime and close</small></span>
                      </button>
                    </div>
                  </Show>
                </div>
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
          <input value={query()} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Search conversations, projects, hosts…" aria-label="Search stored sessions" autofocus />
          <button onClick={props.onRefresh} aria-label="Refresh sessions" title="Refresh">↻</button>
        </div>

        <div class="history-source-filter" role="group" aria-label="Filter history by compute source">
          <button type="button" classList={{ active: sourceFilter() === "all" }} onClick={() => setSourceFilter("all")}>All <span>{sourceCounts().local + sourceCounts().remote}</span></button>
          <button type="button" classList={{ active: sourceFilter() === "local" }} onClick={() => setSourceFilter("local")}>Local <span>{sourceCounts().local}</span></button>
          <button type="button" classList={{ active: sourceFilter() === "remote" }} onClick={() => setSourceFilter("remote")}>Remote <span>{sourceCounts().remote}</span></button>
        </div>

        <div class="stored-list" onScroll={revealMoreNearBottom}>
          <Show when={detachedOpenSessions().length > 0}>
            <section class="drawer-detached-sessions" aria-labelledby="drawer-detached-heading">
              <h3 id="drawer-detached-heading">Live runtimes with detached views</h3>
              <For each={detachedOpenSessions()}>{(session) => (
                <div>
                  <button type="button" onClick={() => { props.onSelectOpen(session.guiId); props.onClose(); }}>
                    <MessageCircle aria-hidden="true" />
                    <span><strong>{session.title}</strong><small>{session.activity || session.phase}</small></span>
                  </button>
                  <button type="button" class="danger" aria-label={`Stop ${session.title}`} onClick={() => void props.onStopOpen(session.guiId)}>
                    <Square aria-hidden="true" />
                  </button>
                </div>
              )}</For>
            </section>
          </Show>
          <Show when={props.loading}><div class="drawer-state"><span class="mini-spinner" /> Scanning every configured compute host…</div></Show>
          <Show when={props.error}><div class="drawer-error">{props.error}</div></Show>
          <Show when={!props.loading && !props.error && visible().length === 0}>
            <div class="drawer-empty"><span>◇</span><strong>No matching sessions</strong><p>Completed Amplifier sessions will appear here.</p></div>
          </Show>
          <Show when={props.warning}><div class="drawer-warning">{props.warning}</div></Show>
          <For each={visible()}>
            {(session) => {
              const blocker = () => storedSessionResumeBlocker(session, false);
              const note = () => blocker() || storedSessionWarning(session);
              return (
                <button class="stored-row" classList={{ "needs-recovery": Boolean(blocker()) }} title={[storedSessionSourceLabel(session), note()].filter(Boolean).join(" · ")} onClick={() => void props.onResume(session)}>
                  <div class="stored-topline">
                    <strong>{session.name}</strong>
                    <span>{timeAgo(session.mtimeMs)}</span>
                  </div>
                  <div class="stored-mobile-origin">
                    <span class={`source-badge ${storedSessionSourceKind(session)}`}>{storedSessionSourceKind(session)}</span>
                    <span>{session.hostName || "This computer"}</span>
                  </div>
                  <p class="stored-summary">{session.summary}</p>
                  <div class="stored-meta">
                    <span class={`source-badge ${storedSessionSourceKind(session)}`}>{storedSessionSourceKind(session)}</span>
                    <span>{session.hostName || "This computer"}</span><i />
                    <span>{session.bundle}</span><i />
                    <span>{session.turnCount ?? "—"} turns</span><i />
                    <span>{session.messageCount} messages</span><i />
                    <span>{session.eventCount === undefined ? "history verified on open" : `${session.eventCount} records`}</span>
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
          {props.sourceName} · showing {visible().length} of {matching().length} resumable matches · {sourceFilter() === "all" ? "all sources" : `${sourceFilter()} only`}
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
