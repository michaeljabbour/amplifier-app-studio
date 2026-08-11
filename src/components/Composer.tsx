import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { machinePresence } from "../machinePresence";
import type { SessionViewState } from "../protocol";

interface Props {
  state: SessionViewState;
  onSend: (text: string) => Promise<boolean>;
  onDraft: (text: string) => void;
  onAutopilot: () => void;
  autopilotActive: boolean;
  autopilotAvailable: boolean;
}

export function Composer(props: Props) {
  const [sending, setSending] = createSignal(false);
  const [startersOpen, setStartersOpen] = createSignal(false);
  let textarea: HTMLTextAreaElement | undefined;
  const presence = createMemo(() => machinePresence(props.state));

  createEffect(() => {
    const lines = Math.min(7, Math.max(1, props.state.composerDraft.split("\n").length));
    if (textarea) textarea.style.height = `${Math.max(48, lines * 22 + 24)}px`;
  });

  const send = async () => {
    const value = props.state.composerDraft.trim();
    if (!value || sending()) return;
    setSending(true);
    try {
      if (await props.onSend(value)) props.onDraft("");
    } finally {
      setSending(false);
    }
  };

  const useStarter = (prompt: string) => {
    const current = props.state.composerDraft.trim();
    props.onDraft(current ? `${current}\n\n${prompt}` : prompt);
    setStartersOpen(false);
    queueMicrotask(() => textarea?.focus());
  };

  return (
    <div class="composer-shell">
      <div class="composer-mode">
        <div class={`machine-presence ${presence().tone}`} role="status" aria-live="polite">
          <span class="machine-avatar" classList={{ live: presence().live }} aria-hidden="true"><i /><i /><b /></span>
          <span><strong>{presence().label}</strong><small>{presence().detail}</small></span>
        </div>
        <div class="composer-intent">
          <button
            type="button"
            class="composer-autopilot"
            classList={{ active: props.autopilotActive }}
            disabled={!props.autopilotAvailable}
            onClick={props.onAutopilot}
            title={props.state.autopilotPending
              ? "Waiting for Amplifier to confirm the goal state"
              : props.autopilotActive
                ? "Turn off Amplifier's autonomous goal loop after the current step"
                : "Let Amplifier evaluate and continue the latest goal until it is achieved or stopped"}
          ><i aria-hidden="true" />{props.state.autopilotPending
              ? (props.autopilotActive ? "STOPPING…" : "STARTING…")
              : props.autopilotActive ? "AUTOPILOT ON" : "AUTOPILOT"}</button>
          {props.state.busy && props.state.queuedSteers > 0 && <small>{props.state.queuedSteers}/32 queued</small>}
        </div>
      </div>
      <textarea
        ref={textarea}
        value={props.state.composerDraft}
        disabled={sending() || props.state.phase !== "ready"}
        placeholder={props.state.restoreProgress && props.state.phase !== "ready"
          ? "Restoring this conversation…"
          : props.state.busy
            ? "Course-correct the current run…"
            : "Tell the coordinator what to build, investigate, or organize…"}
        aria-label={props.state.restoreProgress && props.state.phase !== "ready"
          ? "Restoring Amplifier conversation"
          : props.state.busy
            ? "Steer current turn"
            : "Message Amplifier"}
        onInput={(event) => props.onDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <Show when={startersOpen()}>
        <div class="starter-menu" role="region" aria-label="Ways to start">
          <div><strong>Ways to start</strong><span>Choose one, then make it yours before sending.</span></div>
          <div class="starter-grid">
            <For each={STARTERS}>{(starter) => (
              <button type="button" onClick={() => useStarter(starter.prompt)}>
                <strong>{starter.title}</strong><span>{starter.description}</span>
              </button>
            )}</For>
          </div>
        </div>
      </Show>
      <div class="composer-actions">
        <div class="composer-left-actions">
          <button type="button" class="starter-trigger" aria-expanded={startersOpen()} onClick={() => setStartersOpen((open) => !open)}>Ways to start</button>
          <span><kbd>↵</kbd> {props.state.busy ? "steer" : "send"} · <kbd>⇧↵</kbd> newline</span>
        </div>
        <button disabled={!props.state.composerDraft.trim() || sending() || props.state.phase !== "ready"} onClick={() => void send()}>
          {props.state.busy ? "Steer" : "Send"}<span aria-hidden="true">↑</span>
        </button>
      </div>
    </div>
  );
}

const STARTERS = [
  {
    title: "Build with specialists",
    description: "Frame an outcome, choose agents, execute, and verify.",
    prompt: "Help me turn this outcome into a coordinated run: [describe the outcome]. Frame the work, delegate independent parts when useful, keep me oriented, and verify the result before calling it complete.",
  },
  {
    title: "Investigate in parallel",
    description: "Compare independent evidence before deciding.",
    prompt: "Investigate this from several independent angles in parallel: [question]. Show each specialist's evidence, reconcile disagreements, and give me a decision-ready synthesis.",
  },
  {
    title: "Research to decision",
    description: "Separate evidence, inference, and recommendation.",
    prompt: "Turn this question into a decision: [question]. Gather the relevant evidence, distinguish observation from inference, state uncertainty and trade-offs, then recommend the smallest defensible next move.",
  },
  {
    title: "Visualize the run",
    description: "Map agents, tools, decisions, loops, and handoffs.",
    prompt: "Visualize this system: [system or workflow]. Map its agents, tools, decisions, handoffs, feedback loops, and failure paths. Produce a clear diagram source plus a concise explanation of the important patterns.",
  },
  {
    title: "Review the human-agent fit",
    description: "Inspect control, approvals, recovery, and trust.",
    prompt: "Review this agent experience for human control and ergonomics: [experience]. Map authority, progress visibility, intervention, recovery, memory, and completion evidence; then propose testable improvements.",
  },
  {
    title: "Create a polished output",
    description: "Plan, produce, inspect, and refine an artifact.",
    prompt: "Create a polished [document, visualization, image, analysis, or application] for [audience and purpose]. Plan the output, use the right specialists and tools, inspect the rendered result, and refine it until it is ready to share.",
  },
] as const;
