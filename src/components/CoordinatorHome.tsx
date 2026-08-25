import { createMemo, createSignal, Show } from "solid-js";
import { ArrowUp, Check, ChevronRight, Cloud, Folder, Monitor, Sparkles } from "lucide-solid";
import { appendAttachmentFiles, appendComposerAttachments, hasAttachmentFiles, isSupportedBrowserFile } from "../attachments";
import type { ComposerAttachment, StoredSession } from "../protocol";
import type { RuntimeStatus } from "../transport";
import type { RuntimeHost } from "../transport";
import type { TranscriptionStatus } from "../transport";
import { computeConnectionPrompt } from "../computeConnection";
import type { AudioRecording } from "../transcription";
import { storedSessionResumeBlocker, storedSessionShouldList } from "../sessionAvailability";
import { projectDisplayName } from "../projectDisplayName";
import { AttachmentStrip } from "./AttachmentStrip";
import { VoiceInputButton } from "./VoiceInputButton";

interface Props {
  sessions: StoredSession[];
  transport: string;
  runtime?: RuntimeStatus;
  checking: boolean;
  installing: boolean;
  error?: string;
  onSend: (text: string, attachments: ComposerAttachment[]) => Promise<void>;
  onResume: (session: StoredSession) => void | Promise<void>;
  projectDir: string;
  onChooseProject: () => Promise<void>;
  remoteRuntime: boolean;
  onInstall: () => void;
  onConfigureProvider: () => void;
  providerSetupSupported: boolean;
  onSettings: () => void;
  computeHost?: RuntimeHost;
  computeAccessRequired: boolean;
  onComputeConnection: () => void;
  attachments: ComposerAttachment[];
  onAttachments: (attachments: ComposerAttachment[]) => void;
  onPickAttachments: () => Promise<ComposerAttachment[]>;
  transcription?: TranscriptionStatus;
  onTranscribe: (recording: AudioRecording) => Promise<string>;
}

export function CoordinatorHome(props: Props) {
  const [text, setText] = createSignal("");
  const attachments = () => props.attachments;
  const [draggingAttachments, setDraggingAttachments] = createSignal(false);
  const [starting, setStarting] = createSignal(false);
  const [localError, setLocalError] = createSignal<string>();
  const [dictating, setDictating] = createSignal(false);
  const [locationOpen, setLocationOpen] = createSignal(false);
  const latest = createMemo(() => props.sessions
    .filter(storedSessionShouldList)
    .find((session) => !storedSessionResumeBlocker(session, true)));
  const runtimeAvailable = () => props.runtime?.installed === true && props.runtime?.current === true;
  const providerStatusAvailable = () => props.runtime?.providerStatusAvailable === true;
  const ready = () => runtimeAvailable() && providerStatusAvailable() && props.runtime?.providerConfigured === true;
  const connectionPrompt = createMemo(() => computeConnectionPrompt(
    props.computeHost,
    props.computeAccessRequired,
    props.runtime?.message || props.error,
  ));

  const run = async (action: () => Promise<void>) => {
    if (starting()) return;
    setStarting(true);
    setLocalError(undefined);
    try {
      await action();
    } catch (error) {
      setLocalError(String(error).replace(/^Error:\s*/, ""));
    } finally {
      setStarting(false);
    }
  };

  const send = async () => {
    const value = text().trim() || (attachments().length ? "Please review the attached file(s)." : "");
    if (!value || !ready()) return;
    await run(async () => {
      await props.onSend(value, attachments());
      setText("");
      props.onAttachments([]);
    });
  };

  const addFiles = async (files: File[]) => {
    try {
      props.onAttachments(await appendAttachmentFiles(attachments(), files));
      setLocalError(undefined);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Could not read the dropped file.");
    }
  };

  const pickFiles = async () => {
    try {
      const selected = await props.onPickAttachments();
      if (selected.length) props.onAttachments(appendComposerAttachments(attachments(), selected));
      setLocalError(undefined);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Could not add the selected files.");
    }
  };

  return (
    <main class="coordinator-home">
      <section class="home-conversation">
        <div class="home-conversation-intro">
          <div class="home-machine-mark" aria-hidden="true"><Sparkles /></div>
          <div class="eyebrow">AMPLIFIER AGENT</div>
          <h1>What are we building?</h1>
          <p>Describe the outcome. Amplifier Agent can organize the run, bring in specialists, and keep the work visible.</p>
          <Show when={latest()}>{(session) => (
            <button type="button" class="home-continue" disabled={starting()} onClick={() => void props.onResume(session())}>
              <span>Continue recent work</span>
              <strong>{session().name}</strong>
              <small>{session().summary}</small>
              <i aria-hidden="true"><ChevronRight /></i>
            </button>
          )}</Show>
        </div>

        <Show when={!props.checking && !runtimeAvailable()}>
          <div class="runtime-setup-card home-runtime-card" role="status">
            <div><span>{connectionPrompt().kicker}</span><strong>{connectionPrompt().title}</strong></div>
            <p>{connectionPrompt().description}</p>
            <div>
              <Show when={props.runtime?.installSupported} fallback={<button class="primary-button" onClick={props.onComputeConnection}>{connectionPrompt().action}</button>}>
                <button class="primary-button" disabled={props.installing} onClick={props.onInstall}>{props.installing ? props.runtime?.installed ? "Updating…" : "Installing…" : props.runtime?.installed ? "Update Amplifier runtime" : "Install Amplifier runtime"}</button>
                <button class="secondary-button" onClick={props.onSettings}>Use compute host</button>
              </Show>
            </div>
          </div>
        </Show>

        <Show when={!props.checking && runtimeAvailable() && !providerStatusAvailable()}>
          <div class="runtime-setup-card home-runtime-card" role="status">
            <div><span>RUNTIME UPDATE</span><strong>Update Amplifier to verify provider readiness</strong></div>
            <p>{props.runtime?.providerMessage || "This Amplifier runtime predates provider readiness checks, so Studio cannot safely accept a prompt yet."}</p>
            <div>
              <button class="primary-button" disabled={props.installing} onClick={props.onInstall}>{props.installing ? "Updating…" : "Update Amplifier runtime"}</button>
              <button class="secondary-button" onClick={props.onSettings}>Use compute host</button>
            </div>
          </div>
        </Show>

        <Show when={!props.checking && runtimeAvailable() && providerStatusAvailable() && !props.runtime?.providerConfigured}>
          <div class="runtime-setup-card home-runtime-card provider-setup-card" role="status">
            <div><span>PROVIDER SETUP</span><strong>Connect a model provider before starting a run</strong></div>
            <p>{props.runtime?.providerMessage || "Amplifier is installed, but no usable model provider credentials were detected."}</p>
            <div>
              <Show when={props.providerSetupSupported}>
                <button class="primary-button" onClick={props.onConfigureProvider}>Configure provider</button>
              </Show>
              <button class="secondary-button" onClick={props.onSettings}>Use compute host</button>
            </div>
          </div>
        </Show>

        <div
          class="home-composer"
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
            setDraggingAttachments(false);
            void addFiles(Array.from(event.dataTransfer?.files || []));
          }}
        >
          <Show when={draggingAttachments()}><div class="composer-drop-target">Drop files to start with</div></Show>
          <div class="home-composer-label"><span classList={{ active: ready() }} />{starting() ? "Starting Amplifier Agent…" : ready() ? "Ready when you are" : props.checking ? "Checking compute…" : runtimeAvailable() && !providerStatusAvailable() ? "Runtime update required" : runtimeAvailable() ? "Provider setup required" : connectionPrompt().composerLabel}</div>
          <textarea
            value={text()}
            disabled={!ready() || starting()}
            readOnly={dictating()}
            placeholder={ready() ? "Tell Amplifier what you want to build, investigate, or organize…" : runtimeAvailable() && !providerStatusAvailable() ? "Update Amplifier to verify provider readiness" : runtimeAvailable() ? "Configure a model provider to start a run" : connectionPrompt().composerPlaceholder}
            aria-label="Message Amplifier"
            onInput={(event) => setText(event.currentTarget.value)}
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
          <Show when={attachments().length}>
            <AttachmentStrip
              attachments={attachments()}
              onRemove={(id) => props.onAttachments(attachments().filter((item) => item.id !== id))}
            />
          </Show>
          <div class="home-composer-actions">
            <div class="home-composer-tools">
              <button
                type="button"
                class="home-project-trigger"
                title={props.projectDir || "Choose a project folder"}
                onClick={() => void props.onChooseProject()}
              >
                <Folder aria-hidden="true" />
                <span>{projectDisplayName(props.projectDir)}</span>
              </button>
              <button type="button" onClick={() => void pickFiles()}>Add files</button>
              <VoiceInputButton
                draft={text()}
                disabled={!ready() || starting()}
                available={props.transcription?.available === true}
                unavailableReason={props.transcription?.message}
                onDraft={setText}
                onTranscribe={props.onTranscribe}
                onActiveChange={setDictating}
              />
              <div class="home-location-control">
                <button
                  type="button"
                  class="home-location-trigger"
                  aria-expanded={locationOpen()}
                  aria-haspopup="menu"
                  title={props.remoteRuntime ? "This run uses the configured remote host" : "This run uses this computer"}
                  onClick={() => setLocationOpen((value) => !value)}
                >
                  {props.remoteRuntime ? <Cloud aria-hidden="true" /> : <Monitor aria-hidden="true" />}
                  <span>{props.remoteRuntime ? "Remote host" : "This computer"}</span>
                </button>
                <Show when={locationOpen()}>
                  <div class="home-location-menu" role="menu" aria-label="Where this run executes">
                    <button type="button" role="menuitem" classList={{ selected: !props.remoteRuntime }} onClick={() => props.remoteRuntime && props.onSettings()}>
                      <Monitor aria-hidden="true" />
                      <span><strong>On this computer</strong><small>Uses local files and the local Amplifier runtime</small></span>
                      <i aria-hidden="true">{!props.remoteRuntime ? <Check /> : null}</i>
                    </button>
                    <button type="button" role="menuitem" classList={{ selected: props.remoteRuntime }} onClick={() => props.onSettings()}>
                      <Cloud aria-hidden="true" />
                      <span><strong>{props.remoteRuntime ? "Remote host" : "Cloud or remote"}</strong><small>{props.remoteRuntime ? "Connected securely to this compute host" : "Not configured yet · open Settings"}</small></span>
                      <i aria-hidden="true">{props.remoteRuntime ? <Check /> : null}</i>
                    </button>
                  </div>
                </Show>
              </div>
              <span><kbd>↵</kbd> send · <kbd>⇧↵</kbd> newline</span>
            </div>
            <button type="button" disabled={(!text().trim() && !attachments().length) || !ready() || starting()} onClick={() => void send()}>Send <span aria-hidden="true"><ArrowUp /></span></button>
          </div>
          <Show when={localError() || (!props.computeAccessRequired && props.error)}><small class="home-composer-error">{localError() || props.error}</small></Show>
        </div>

        <div class="home-transport">
          <span classList={{ active: ready() }} />
          {props.transport}
          {props.runtime?.version ? ` · ${props.runtime.version}` : ""}
        </div>
      </section>
    </main>
  );
}
