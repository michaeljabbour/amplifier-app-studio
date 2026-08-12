import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { appendAttachmentFiles, appendComposerAttachments, hasAttachmentFiles, isSupportedBrowserFile } from "../attachments";
import { machinePresence } from "../machinePresence";
import type { ComposerAttachment, SessionViewState } from "../protocol";
import type { AudioRecording } from "../transcription";
import { AttachmentStrip } from "./AttachmentStrip";
import { VoiceInputButton } from "./VoiceInputButton";

interface Props {
  state: SessionViewState;
  onSend: (text: string, attachments: ComposerAttachment[]) => Promise<boolean>;
  onDraft: (text: string) => void;
  onAttachments: (attachments: ComposerAttachment[]) => void;
  onPickAttachments: () => Promise<ComposerAttachment[]>;
  onAutopilot: () => void;
  autopilotActive: boolean;
  autopilotAvailable: boolean;
  transcriptionAvailable: boolean;
  transcriptionMessage?: string;
  onTranscribe: (recording: AudioRecording) => Promise<string>;
}

export function Composer(props: Props) {
  const [sending, setSending] = createSignal(false);
  const [startersOpen, setStartersOpen] = createSignal(false);
  const [draggingAttachments, setDraggingAttachments] = createSignal(false);
  const [attachmentError, setAttachmentError] = createSignal<string>();
  const [dictating, setDictating] = createSignal(false);
  let textarea: HTMLTextAreaElement | undefined;
  const presence = createMemo(() => machinePresence(props.state));

  createEffect(() => {
    const lines = Math.min(7, Math.max(1, props.state.composerDraft.split("\n").length));
    if (textarea) textarea.style.height = `${Math.max(48, lines * 22 + 24)}px`;
  });

  const send = async () => {
    const attachments = props.state.composerAttachments;
    const value = props.state.composerDraft.trim() || (attachments.length ? "Please review the attached file(s)." : "");
    if (!value || sending()) return;
    setSending(true);
    try {
      if (await props.onSend(value, attachments)) {
        props.onDraft("");
        props.onAttachments([]);
        setAttachmentError(undefined);
      }
    } finally {
      setSending(false);
    }
  };

  const addFiles = async (files: File[]) => {
    try {
      props.onAttachments(await appendAttachmentFiles(props.state.composerAttachments, files));
      setAttachmentError(undefined);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "Could not read the dropped file.");
    }
  };

  const pickFiles = async () => {
    try {
      const attachments = await props.onPickAttachments();
      if (attachments.length) props.onAttachments(appendComposerAttachments(props.state.composerAttachments, attachments));
      setAttachmentError(undefined);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "Could not add the selected files.");
    }
  };

  const useStarter = (prompt: string) => {
    const current = props.state.composerDraft.trim();
    props.onDraft(current ? `${current}\n\n${prompt}` : prompt);
    setStartersOpen(false);
    queueMicrotask(() => textarea?.focus());
  };

  return (
    <div
      class="composer-shell"
      classList={{ "dragging-attachments": draggingAttachments() }}
      onDragEnter={(event) => {
        const transfer = event.dataTransfer;
        if (transfer && hasAttachmentFiles(transfer)) {
          event.preventDefault();
          setDraggingAttachments(true);
        }
      }}
      onDragOver={(event) => {
        const transfer = event.dataTransfer;
        if (transfer && hasAttachmentFiles(transfer)) {
          event.preventDefault();
          transfer.dropEffect = "copy";
          setDraggingAttachments(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingAttachments(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setDraggingAttachments(false);
        void addFiles(Array.from(event.dataTransfer?.files || []));
      }}
    >
      <Show when={draggingAttachments()}><div class="composer-drop-target">Drop files to attach</div></Show>
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
        readOnly={dictating()}
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
        onPaste={(event) => {
          const files = Array.from(event.clipboardData?.files || []).filter(isSupportedBrowserFile);
          if (files.length) {
            event.preventDefault();
            void addFiles(files);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <Show when={props.state.composerAttachments.length}>
        <AttachmentStrip
          attachments={props.state.composerAttachments}
          onRemove={(id) => props.onAttachments(props.state.composerAttachments.filter((item) => item.id !== id))}
        />
      </Show>
      <Show when={attachmentError()}><div class="composer-attachment-error" role="alert">{attachmentError()}</div></Show>
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
          <button type="button" class="attachment-trigger" disabled={sending()} onClick={() => void pickFiles()}>Add files</button>
          <VoiceInputButton
            draft={props.state.composerDraft}
            disabled={sending() || props.state.phase !== "ready"}
            available={props.transcriptionAvailable}
            unavailableReason={props.transcriptionMessage}
            onDraft={props.onDraft}
            onTranscribe={props.onTranscribe}
            onActiveChange={setDictating}
          />
          <span><kbd>↵</kbd> {props.state.busy ? "steer" : "send"} · <kbd>⇧↵</kbd> newline</span>
        </div>
        <button disabled={(!props.state.composerDraft.trim() && !props.state.composerAttachments.length) || sending() || props.state.phase !== "ready"} onClick={() => void send()}>
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
