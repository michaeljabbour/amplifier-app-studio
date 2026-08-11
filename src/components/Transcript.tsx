import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { SessionViewState, TranscriptBlock } from "../protocol";
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

export function Transcript(props: Props) {
  let scroller: HTMLDivElement | undefined;
  let pinned = true;
  let scrollFrame = 0;
  const [now, setNow] = createSignal(Date.now());

  onMount(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    onCleanup(() => {
      window.clearInterval(timer);
      window.cancelAnimationFrame(scrollFrame);
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

  createEffect(() => {
    const marker = `${props.state.blocks.length}:${props.state.liveTail?.text.length ?? 0}`;
    void marker;
    if (!pinned) return;
    window.cancelAnimationFrame(scrollFrame);
    scrollFrame = window.requestAnimationFrame(() => scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "auto" }));
  });

  return (
    <main
      class="transcript"
      ref={scroller}
      onScroll={() => {
        if (!scroller) return;
        pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96;
      }}
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

        <For each={props.state.blocks}>{(block) => <BlockView block={block} onThinkingExpanded={props.onThinkingExpanded} />}</For>

        <Show when={props.state.liveTail?.text ? props.state.liveTail : undefined} keyed>
          {(tail) => (
            <Show
              when={tail.blockType !== "thinking"}
              fallback={
                <details class="live-reasoning" open>
                  <summary><span>Reasoning</span><small>live</small></summary>
                  <div><Markdown text={tail.text} class="thinking-text-live" /><span class="stream-caret" /></div>
                </details>
              }
            >
              <article class="block live-response">
                <div class="block-gutter"><span class="live-spark">✦</span></div>
                <div class="block-body">
                  <div class="block-label">AMPLIFIER · LIVE</div>
                  <div class="answer-text live-markdown"><Markdown text={tail.text} /><span class="stream-caret" /></div>
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
              <div class="working-agents">Coordinator active · delegate workspaces will appear in the left panel if this turn creates them</div>
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
          <div class="fatal-card">
            <div class="eyebrow">SESSION ERROR{props.state.exitCode ? ` · EXIT ${props.state.exitCode}` : ""}</div>
            <strong>{props.state.error}</strong>
            <Show when={props.state.logs.length}>
              <details>
                <summary>Runtime log</summary>
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
      </div>
    </main>
  );
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function BlockView(props: { block: TranscriptBlock; onThinkingExpanded: (blockId: string, expanded: boolean) => void }) {
  const block = () => props.block;
  return (
    <Show
      when={block().kind !== "tool" && block().kind !== "thinking"}
      fallback={block().kind === "tool" ? <ToolView block={block() as Extract<TranscriptBlock, { kind: "tool" }>} /> : <ThinkingView block={block() as Extract<TranscriptBlock, { kind: "thinking" }>} onExpanded={props.onThinkingExpanded} />}
    >
      <article class={`block block-${block().kind}`}>
        <div class="block-gutter">
          {block().kind === "user" ? <span class="user-avatar">YOU</span> : block().kind === "answer" ? <span class="answer-glyph">✦</span> : <span class={`notice-dot ${(block() as Extract<TranscriptBlock, { kind: "notice" }>).level}`} />}
        </div>
        <div class="block-body">
          <Show when={block().kind === "user"}>
            <div class="block-label">YOU · {(block() as Extract<TranscriptBlock, { kind: "user" }>).mode || "auto"}</div>
            <Markdown class="user-text" text={(block() as Extract<TranscriptBlock, { kind: "user" }>).text} />
          </Show>
          <Show when={block().kind === "answer"}>
            <div class="block-label">AMPLIFIER · COORDINATOR{(block() as Extract<TranscriptBlock, { kind: "answer" }>).final ? " · FINAL" : ""}</div>
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
