import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { SessionViewState, TranscriptBlock } from "../protocol";
import { loadOutputPreview } from "../transport";
import { AttachmentStrip } from "./AttachmentStrip";
import { Markdown } from "./Markdown";

interface Props {
  state: SessionViewState;
  onInterrupt: () => void;
  onRetryRestore: () => void;
  onOpenRestoreAnyway: () => void;
  onThinkingExpanded: (blockId: string, expanded: boolean) => void;
  onRetry?: () => void;
  retryLabel?: string;
  onResume?: () => void;
  onExport: () => void;
}

/**
 * Minimum gap between markdown re-renders of the streaming answer.
 *
 * The live tail re-parses and re-sanitizes the ENTIRE accumulated answer on every delta, so the
 * cost grows with answer length while the delta count grows too. Measured with the real marked +
 * DOMPurify pipeline: a 30 KB answer arriving in ~30-char deltas cost 2,242 ms of main-thread
 * work across 1,000 renders, against 4.4 ms for a single render of the finished text. Throttling
 * bounds that to ~1 render per interval without changing what the reader eventually sees --
 * the finalized answer is re-rendered as a normal block regardless.
 */
const LIVE_MARKDOWN_INTERVAL_MS = 80;

/** Samples `value` at most once per `intervalMs`, always settling on the latest value. */
function throttled(value: () => string, intervalMs: number): () => string {
  const [sampled, setSampled] = createSignal(value());
  let timer: number | undefined;
  let latest = value();

  createEffect(() => {
    latest = value();
    if (timer !== undefined) return;
    setSampled(latest);
    timer = window.setTimeout(() => {
      timer = undefined;
      // Settle on whatever arrived while the window was closed.
      setSampled(latest);
    }, intervalMs);
  });

  onCleanup(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  });

  return sampled;
}

export function Transcript(props: Props) {
  let scroller: HTMLDivElement | undefined;
  let latestAnchor: HTMLDivElement | undefined;
  let scrollFrame = 0;
  let focusedRestoreKey = "";
  let focusedPointerPan: { clientY: number; scrollTop: number; pointerId: number } | undefined;
  const [now, setNow] = createSignal(Date.now());
  const [following, setFollowing] = createSignal(true);
  // Keep status polling and unrelated session updates from snapping a reader
  // back to the bottom. The memo only notifies the effect when visible
  // transcript content actually changes.
  const contentMarker = createMemo(() => transcriptScrollMarker(props.state));
  const liveTailText = throttled(() => props.state.liveTail?.text || "", LIVE_MARKDOWN_INTERVAL_MS);

  onMount(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    const preserveFocusedComposer = (event: TouchEvent) => {
      // Solid's delegated touch listener is passive in WKWebView. This native
      // non-passive listener is required to cancel the focus-transfer default.
      if (focusedPointerPan) event.preventDefault();
    };
    scroller?.addEventListener("touchstart", preserveFocusedComposer, { passive: false });
    onCleanup(() => {
      window.clearInterval(timer);
      window.cancelAnimationFrame(scrollFrame);
      scroller?.removeEventListener("touchstart", preserveFocusedComposer);
    });
  });

  const elapsed = () => {
    const started = props.state.turnStartedAtMs;
    return started ? formatDuration(Math.max(0, now() - started)) : "";
  };
  const activeLanes = () => Object.values(props.state.lanes).filter((lane) => lane.status === "running" || lane.status === "attention");
  const activeOperations = () => activeLanes().flatMap((lane) =>
    lane.tools.filter((tool) => tool.status === "running").map((tool) => ({ agent: lane.agent, ...tool })),
  );
  const visibleBlocks = createMemo(() => {
    const fatalMessage = props.state.phase === "error" ? props.state.error?.trim() : undefined;
    if (!fatalMessage) return props.state.blocks;
    return props.state.blocks.filter((block) =>
      !(block.kind === "notice" && block.level === "error" && block.text.trim() === fatalMessage),
    );
  });

  createEffect(() => {
    void contentMarker();
    if (!following()) return;
    window.cancelAnimationFrame(scrollFrame);
    scrollFrame = window.requestAnimationFrame(() => scrollTranscriptToLatest(scroller, latestAnchor));
  });

  createEffect(() => {
    const state = props.state;
    const restored = state.phase === "ready"
      && state.restoreProgress?.history === true
      && state.restoreProgress.status === true;
    const conversation = state.blocks.filter((block) => block.kind === "user" || block.kind === "answer");
    const key = restored && conversation.length
      ? `${state.runtimeSessionId || state.resumeId || state.guiId}:${conversation.at(-1)?.id}`
      : "";
    if (!key || key === focusedRestoreKey) return;
    focusedRestoreKey = key;
    setFollowing(false);
    window.requestAnimationFrame(() => {
      const restoredConversation = scroller?.querySelectorAll<HTMLElement>("[data-conversation-message='true']");
      restoredConversation?.item(restoredConversation.length - 1).scrollIntoView({ block: "center" });
    });
  });

  const detachFromLatest = () => {
    window.cancelAnimationFrame(scrollFrame);
    setFollowing(false);
  };

  const updateFollowing = () => {
    if (!scroller) return;
    if (transcriptAtBottom(scroller.scrollHeight, scroller.scrollTop, scroller.clientHeight)) {
      setFollowing(true);
    } else {
      detachFromLatest();
    }
  };

  const jumpToLatest = () => {
    window.cancelAnimationFrame(scrollFrame);
    releaseFocusedEditorForTranscriptJump(document.activeElement);
    scrollTranscriptToLatest(scroller, latestAnchor);
    setFollowing(true);
    // WKWebView can finish expanding the visual viewport after the editor
    // releases focus. Re-assert the bottom once that resize has settled.
    scrollFrame = window.requestAnimationFrame(() => scrollTranscriptToLatest(scroller, latestAnchor));
  };

  const beginPointerPan = (event: PointerEvent) => {
    const target = event.target as Element | null;
    if (
      window.innerWidth > 760
      || !isFocusedEditorTarget(document.activeElement)
      || target?.closest("a, button, input, textarea, select, summary, [role='button']")
      || !scroller
    ) return;
    focusedPointerPan = {
      clientY: event.clientY,
      scrollTop: scroller.scrollTop,
      pointerId: event.pointerId,
    };
    // The transcript is keyboard-focusable on desktop. Capture this mobile
    // drag before its default focus transfer can steal the composer focus.
    event.preventDefault();
    (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
  };

  const continuePointerPan = (event: PointerEvent) => {
    if (!focusedPointerPan || focusedPointerPan.pointerId !== event.pointerId || !scroller) return;
    // WKWebView stops advancing nested overflow scrollers while an editor has
    // focus. Keep the keyboard stable and drive only that focused pan here;
    // unfocused gestures stay on the native momentum scroller.
    event.preventDefault();
    scroller.scrollTop = transcriptPointerScrollTop(
      focusedPointerPan.scrollTop,
      focusedPointerPan.clientY,
      event.clientY,
      scroller.scrollHeight,
      scroller.clientHeight,
    );
    updateFollowing();
  };

  const endPointerPan = (event: PointerEvent) => {
    if (focusedPointerPan?.pointerId !== event.pointerId) return;
    (event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId);
    focusedPointerPan = undefined;
  };

  return (
    <section class="transcript-frame" aria-label="Conversation history">
      <main
        class="transcript"
        ref={scroller}
        tabIndex={0}
        aria-label="Amplifier Agent transcript"
        onWheel={(event) => {
          if (event.deltaY < 0) detachFromLatest();
        }}
        onKeyDown={(event) => {
          if (["ArrowUp", "PageUp", "Home"].includes(event.key)) detachFromLatest();
        }}
        onPointerDown={beginPointerPan}
        onPointerMove={continuePointerPan}
        onPointerUp={endPointerPan}
        onPointerCancel={endPointerPan}
        onScroll={updateFollowing}
      >
        <div class="transcript-inner">
        <Show when={props.state.phase === "starting"}>
          <div class="boot-card" role="status" aria-live="polite">
            <div class="boot-orbit"><span /></div>
            <div>
              <div class="eyebrow">{props.state.restoreProgress ? "SESSION RESTORE" : "RUNTIME BOOT"}</div>
              <h2>{props.state.bootLabel}</h2>
              <p>{props.state.restoreProgress
                ? "Loading durable history and the authoritative model, context, and spend state. The composer unlocks when the session is ready."
                : "Preparing the Python runtime out of process. This can take a few minutes for a cold bundle."}</p>
            </div>
          </div>
        </Show>

        <Show when={props.state.phase === "degraded" && props.state.restoreIssue} keyed>
          {(issue) => (
            <div class="restore-card" role="alert">
              <div class="eyebrow">SESSION RESTORE · ATTEMPT {issue.attempt}</div>
              <h2>Restoration did not finish</h2>
              <p>{issue.message}</p>
              <small>Still waiting for {issue.missing.map((step) => step === "history" ? "durable history" : "runtime status").join(" and ")}.</small>
              <div class="recovery-actions">
                <button class="primary-button" onClick={props.onRetryRestore}>Retry restore</button>
                <button class="secondary-button" onClick={props.onOpenRestoreAnyway}>Open anyway</button>
              </div>
              <p class="recovery-caution">Opening anyway keeps unknown agent completions marked as detached and may omit earlier transcript content.</p>
            </div>
          )}
        </Show>

        <Show when={props.state.replaying}>
          <div class="replay-banner"><span class="mini-spinner" /> Rebuilding durable session history…</div>
        </Show>

        <For each={visibleBlocks()}>{(block) => <BlockView
          block={block}
          projectDir={props.state.projectDir}
          hostUrl={props.state.hostUrl}
          hostId={props.state.hostId}
          onThinkingExpanded={props.onThinkingExpanded}
        />}</For>

        <Show when={props.state.liveTail?.text ? props.state.liveTail : undefined} keyed>
          {(tail) => (
            <Show
              when={tail.blockType !== "thinking"}
              fallback={
                <details class="live-reasoning" open>
                  <summary><span>Reasoning</span><small>live</small></summary>
                  <div><Markdown text={liveTailText() || tail.text} class="thinking-text-live" /><span class="stream-caret" /></div>
                </details>
              }
            >
              <article class="block live-response">
                <div class="block-gutter"><span class="live-spark">✦</span></div>
                <div class="block-body">
                  <div class="block-label">AMPLIFIER · LIVE</div>
                  {/* The streaming answer is the product's primary output and was the one
                      region with no live region announcement: screen-reader users got the boot,
                      working and fatal cards but never the answer itself. `polite` and
                      non-atomic so it reads incrementally instead of restarting each delta. */}
                  <div class="answer-text live-markdown" aria-live="polite" aria-atomic="false"><Markdown text={liveTailText() || tail.text} /><span class="stream-caret" /></div>
                </div>
              </article>
            </Show>
          )}
        </Show>

        <Show when={props.state.busy && props.state.phase === "ready"}>
          <div class="working-card" role="status" aria-live="polite">
            <div class="working-head">
              <span class="working-glyph">✳</span>
              <strong>{props.state.activity}</strong>
              <span class="working-dots"><i /><i /><i /></span>
              <Show when={elapsed()}><time>{elapsed()}</time></Show>
              <button onClick={props.onInterrupt}>Interrupt</button>
            </div>
            <Show when={activeLanes().length > 0}>
              <div class="working-agents">
                {activeLanes().length} delegate{activeLanes().length === 1 ? "" : "s"} active
                <Show when={activeOperations().length}> · {activeOperations().length} operation{activeOperations().length === 1 ? "" : "s"}</Show>
              </div>
            </Show>
            <Show when={activeLanes().length === 0}>
              <div class="working-agents">Amplifier Agent active · delegate workspaces will appear in the left panel if this turn creates them</div>
            </Show>
            <Show when={activeOperations().length > 0}>
              <div class="working-tree">
                <For each={activeOperations()}>{(operation) => (
                  <div><span>└</span><strong>{operation.agent}</strong><code>{operation.label}</code></div>
                )}</For>
              </div>
            </Show>
          </div>
        </Show>

        <Show when={props.state.phase === "error" && props.state.error}>
          <div class="fatal-card" role="alert">
            <div class="eyebrow">{runtimeFailureCopy(props.state).kicker}</div>
            <strong>{runtimeFailureCopy(props.state).title}</strong>
            <p>{runtimeFailureCopy(props.state).detail}</p>
            <Show when={props.state.logs.length}>
              <details>
                <summary>Technical details</summary>
                <pre>{props.state.logs.slice(-30).join("\n")}</pre>
              </details>
            </Show>
            <div class="recovery-actions">
              <Show when={Boolean(props.onRetry)}><button class="primary-button" onClick={() => props.onRetry?.()}>{props.retryLabel || "Retry"}</button></Show>
              <Show when={Boolean(props.onResume)}><button class="secondary-button" onClick={() => props.onResume?.()}>Resume last durable session</button></Show>
              <button class="secondary-button" onClick={props.onExport}>Export diagnostics</button>
            </div>
          </div>
        </Show>
          <div class="transcript-latest-anchor" ref={latestAnchor} aria-hidden="true" />
        </div>
      </main>
      <Show when={!following()}>
        <button
          type="button"
          class="transcript-jump-latest"
          onPointerDown={(event) => {
            if (event.pointerType === "touch") {
              event.preventDefault();
              jumpToLatest();
            }
          }}
          onClick={jumpToLatest}
        >
          Jump to latest
        </button>
      </Show>
    </section>
  );
}

export interface TranscriptScrollTarget {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  scrollTo?: (options: ScrollToOptions) => void;
}

export interface TranscriptLatestAnchor {
  scrollIntoView?: (options?: ScrollIntoViewOptions) => void;
}

export interface FocusedEditorTarget {
  matches?: (selector: string) => boolean;
  blur?: () => void;
}

export function isFocusedEditorTarget(
  activeElement: FocusedEditorTarget | null | undefined,
): boolean {
  return Boolean(activeElement?.matches?.("input, textarea, select, [contenteditable='true']"));
}

export function releaseFocusedEditorForTranscriptJump(
  activeElement: FocusedEditorTarget | null | undefined,
): boolean {
  if (!isFocusedEditorTarget(activeElement)) return false;
  activeElement?.blur?.();
  return true;
}

export function transcriptPointerScrollTop(
  startScrollTop: number,
  startClientY: number,
  currentClientY: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const bottom = Math.max(0, scrollHeight - clientHeight);
  return Math.min(bottom, Math.max(0, startScrollTop + startClientY - currentClientY));
}

export function scrollTranscriptToLatest(
  scroller: TranscriptScrollTarget | undefined,
  anchor?: TranscriptLatestAnchor,
): void {
  if (!scroller) return;
  const bottom = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  scroller.scrollTop = bottom;
  scroller.scrollTo?.({ top: bottom, behavior: "auto" });
  anchor?.scrollIntoView?.({ block: "end", inline: "nearest", behavior: "auto" });
  // scrollIntoView may choose an ancestor when the WebView is transformed;
  // make the transcript's own scroll position authoritative.
  scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
}

export function runtimeFailureCopy(state: SessionViewState): { kicker: string; title: string; detail: string } {
  const technical = state.logs.join("\n");
  if (/choice .+ is not one of/i.test(technical)) {
    return {
      kicker: "SESSION STOPPED · RESPONSE ROUTING",
      title: "Studio sent an answer to the wrong Amplifier request",
      detail: "The stored conversation is intact. Retry resume reopens the last durable state; Studio now keeps project decisions and tool approvals on separate lanes.",
    };
  }
  if (state.exitCode === 4) {
    return {
      kicker: "SESSION MOVE DETECTED · RESUME NEEDED",
      title: "This project location has only an incomplete session copy",
      detail: "Choose the repository's current folder when you retry. Studio will recover the complete transcript from its original store and preserve that recovery copy.",
    };
  }
  if (state.exitCode === 2) {
    return {
      kicker: "SESSION LOCATION NEEDED",
      title: "Amplifier could not find this session in the selected project",
      detail: "Retry resume and choose the folder that currently contains the project. Studio will look across prior project locations for the durable history.",
    };
  }
  return {
    kicker: `SESSION STOPPED${state.exitCode ? ` · RUNTIME EXIT ${state.exitCode}` : ""}`,
    title: state.error || "Amplifier stopped unexpectedly",
    detail: "Studio preserved the durable session data it received. Retry resumes the latest stored session; technical details remain available for diagnosis.",
  };
}

export function transcriptScrollMarker(state: SessionViewState): string {
  const last = state.blocks.at(-1);
  const content = !last
    ? ""
    : last.kind === "tool"
      ? `${last.summary}:${last.detail}`
      : last.kind === "recipe"
        ? `${last.name}:${last.status}:${last.steps.map((step) => `${step.index}:${step.status}`).join(",")}:${last.messages.join("|")}`
      : last.kind === "output"
        ? `${last.output.kind}:${last.output.path}`
      : last.kind === "thinking" || last.kind === "user" || last.kind === "answer" || last.kind === "notice"
        ? last.text
        : "";
  return `${state.blocks.length}:${last?.kind || "none"}:${content.length}:${state.liveTail?.blockType || ""}:${state.liveTail?.text.length || 0}`;
}

export function transcriptAtBottom(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= 0.5;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function BlockView(props: {
  block: TranscriptBlock;
  projectDir: string;
  hostUrl?: string;
  hostId?: string;
  onThinkingExpanded: (blockId: string, expanded: boolean) => void;
}) {
  const block = () => props.block;
  return (
    <Show
      when={block().kind !== "tool" && block().kind !== "thinking" && block().kind !== "recipe" && block().kind !== "output"}
      fallback={block().kind === "output"
        ? <OutputView
          block={block() as Extract<TranscriptBlock, { kind: "output" }>}
          projectDir={props.projectDir}
          hostUrl={props.hostUrl}
          hostId={props.hostId}
        />
        : block().kind === "tool"
        ? <ToolView block={block() as Extract<TranscriptBlock, { kind: "tool" }>} />
        : block().kind === "recipe"
          ? <RecipeView block={block() as Extract<TranscriptBlock, { kind: "recipe" }>} />
          : <ThinkingView block={block() as Extract<TranscriptBlock, { kind: "thinking" }>} onExpanded={props.onThinkingExpanded} />}
    >
      <article
        class={`block block-${block().kind}`}
        data-conversation-message={block().kind === "user" || block().kind === "answer" ? "true" : undefined}
      >
        <div class="block-gutter">
          {block().kind === "user" ? <span class="user-avatar">YOU</span> : block().kind === "answer" ? <span class="answer-glyph">✦</span> : <span class={`notice-dot ${(block() as Extract<TranscriptBlock, { kind: "notice" }>).level}`} />}
        </div>
        <div class="block-body">
          <Show when={block().kind === "user"}>
            <div class="block-label">YOU · {(block() as Extract<TranscriptBlock, { kind: "user" }>).mode || "auto"}</div>
            <Markdown class="user-text" text={(block() as Extract<TranscriptBlock, { kind: "user" }>).text} />
            <Show when={(block() as Extract<TranscriptBlock, { kind: "user" }>).attachments?.length}>
              <AttachmentStrip
                attachments={(block() as Extract<TranscriptBlock, { kind: "user" }>).attachments || []}
                transcript
              />
            </Show>
          </Show>
          <Show when={block().kind === "answer"}>
            <div class="block-label">AMPLIFIER AGENT{(block() as Extract<TranscriptBlock, { kind: "answer" }>).final ? " · FINAL" : ""}</div>
            <Markdown class="answer-text" text={(block() as Extract<TranscriptBlock, { kind: "answer" }>).text} />
          </Show>
          <Show when={block().kind === "notice"}>
            <Markdown
              class={`notice-text ${(block() as Extract<TranscriptBlock, { kind: "notice" }>).level}`}
              text={(block() as Extract<TranscriptBlock, { kind: "notice" }>).text}
            />
          </Show>
        </div>
      </article>
    </Show>
  );
}

function OutputView(props: {
  block: Extract<TranscriptBlock, { kind: "output" }>;
  projectDir: string;
  hostUrl?: string;
  hostId?: string;
}) {
  let card: HTMLDivElement | undefined;
  const [preview, setPreview] = createSignal<{ mediaType: string; data: string }>();
  const [error, setError] = createSignal("");

  onMount(() => {
    const load = () => {
      void loadOutputPreview(props.projectDir, props.block.output.path, props.hostUrl, props.hostId)
        .then(setPreview)
        .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    };
    if (!("IntersectionObserver" in window) || !card) {
      load();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      load();
    }, { rootMargin: "800px 0px" });
    observer.observe(card);
    onCleanup(() => observer.disconnect());
  });

  return (
    <article class="block block-output">
      <div class="block-gutter"><span class="answer-glyph">✦</span></div>
      <div class="block-body">
        <div class="block-label">AMPLIFIER · GENERATED IMAGE</div>
        <div class="inline-output-card" ref={card}>
          <Show
            when={preview()}
            fallback={<div class="inline-output-loading">{error() || "Loading generated image…"}</div>}
            keyed
          >
            {(loaded) => (
              <img
                src={`data:${loaded.mediaType};base64,${loaded.data}`}
                alt={props.block.output.title}
              />
            )}
          </Show>
          <div class="inline-output-caption">
            <strong>{props.block.output.title}</strong>
            <span>{props.block.output.source || "Generated output"}</span>
          </div>
        </div>
      </div>
    </article>
  );
}

function RecipeView(props: { block: Extract<TranscriptBlock, { kind: "recipe" }> }) {
  const completed = () => props.block.steps.filter((step) => step.status === "completed").length;
  const progress = () => props.block.status === "completed"
    ? `${props.block.total} steps completed`
    : props.block.total
      ? `${Math.min(completed() + (props.block.steps.some((step) => step.status === "running") ? 1 : 0), props.block.total)} of ${props.block.total}`
      : "activity";
  return (
    <article class={`recipe-row ${props.block.status}`}>
      <details>
        <summary>
          <span class="recipe-status" aria-hidden="true">
            {props.block.status === "completed" ? "✓" : props.block.status === "failed" ? "!" : props.block.status === "attention" ? "·" : "◌"}
          </span>
          <span class="recipe-heading"><small>RECIPE</small><strong>{props.block.name}</strong></span>
          <span class="recipe-progress">{progress()}</span>
          <span class="tool-chevron">›</span>
        </summary>
        <div class="recipe-detail">
          <Show when={props.block.steps.length > 0}>
            <ol>
              <For each={props.block.steps}>{(step) => (
                <li class={step.status}>
                  <span>{step.status === "completed" ? "✓" : step.status === "failed" ? "!" : step.status === "running" ? "→" : "·"}</span>
                  <strong>{step.name}</strong>
                  <Show when={step.kind}><small>{step.kind}</small></Show>
                </li>
              )}</For>
            </ol>
          </Show>
          <Show when={props.block.messages.length > 0}>
            <div class="recipe-messages">
              <For each={props.block.messages}>{(message) => <p>{message}</p>}</For>
            </div>
          </Show>
        </div>
      </details>
    </article>
  );
}

function ToolView(props: { block: Extract<TranscriptBlock, { kind: "tool" }> }) {
  return (
    <article class={`tool-row ${props.block.status}`}>
      <details>
        <summary>
          <span class="tool-status" aria-hidden="true">
            {props.block.status === "running" ? "◌" : props.block.status === "completed" ? "✓" : "!"}
          </span>
          <span>{props.block.summary}</span>
          <span class="tool-chevron">›</span>
        </summary>
        <pre>{props.block.detail}</pre>
      </details>
    </article>
  );
}

function ThinkingView(props: {
  block: Extract<TranscriptBlock, { kind: "thinking" }>;
  onExpanded: (blockId: string, expanded: boolean) => void;
}) {
  return (
    <article class="tool-row thinking-row">
      <details
        open={props.block.expanded}
        onToggle={(event) => props.onExpanded(props.block.id, event.currentTarget.open)}
      >
        <summary><span class="tool-status">◇</span><span>Thinking</span><span class="tool-chevron">›</span></summary>
        <Markdown class="thinking-text" text={props.block.text || "Content withheld by provider"} />
      </details>
    </article>
  );
}
