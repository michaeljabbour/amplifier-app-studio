import { createMemo, createSignal, For, Show } from "solid-js";
import { appendImageFiles, formatImageBytes, hasImageFiles, SUPPORTED_IMAGE_TYPES } from "../imageAttachments";
import type { ComposerImage, StoredSession } from "../protocol";
import type { RuntimeStatus } from "../transport";
import { storedSessionResumeBlocker } from "../sessionAvailability";

interface Props {
  sessions: StoredSession[];
  loading: boolean;
  transport: string;
  runtime?: RuntimeStatus;
  checking: boolean;
  installing: boolean;
  error?: string;
  onSend: (text: string, images: ComposerImage[]) => Promise<void>;
  onResume: (session: StoredSession) => Promise<void>;
  onNew: () => void;
  onDrawer: () => void;
  onInstall: () => void;
  onConfigureProvider: () => void;
  providerSetupSupported: boolean;
  onSettings: () => void;
}

export function CoordinatorHome(props: Props) {
  const [text, setText] = createSignal("");
  const [images, setImages] = createSignal<ComposerImage[]>([]);
  const [draggingImages, setDraggingImages] = createSignal(false);
  const [starting, setStarting] = createSignal(false);
  const [localError, setLocalError] = createSignal<string>();
  const recent = createMemo(() => props.sessions.slice(0, 24));
  const latest = createMemo(() => recent().find((session) => !storedSessionResumeBlocker(session, true)));
  const runtimeAvailable = () => props.runtime?.installed === true;
  const providerStatusAvailable = () => props.runtime?.providerStatusAvailable === true;
  const ready = () => runtimeAvailable() && providerStatusAvailable() && props.runtime?.providerConfigured === true;

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
    const value = text().trim() || (images().length ? "Please review the attached image(s)." : "");
    if (!value || !ready()) return;
    await run(async () => {
      await props.onSend(value, images());
      setText("");
      setImages([]);
    });
  };

  const addImageFiles = async (files: File[]) => {
    try {
      setImages(await appendImageFiles(images(), files));
      setLocalError(undefined);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Could not read the dropped image.");
    }
  };

  return (
    <main class="coordinator-home">
      <aside class="home-history" aria-label="Session history">
        <div class="home-history-heading">
          <div><span>AMPLIFIER</span><strong>History</strong></div>
          <button type="button" onClick={props.onNew}>New</button>
        </div>
        <Show when={!props.loading} fallback={<div class="home-history-state"><span class="mini-spinner" /> Loading history…</div>}>
          <Show when={recent().length > 0} fallback={<div class="home-history-state">Your Amplifier sessions will appear here.</div>}>
            <div class="home-history-list">
              <For each={recent()}>{(session) => (
                <button
                  type="button"
                  class="home-history-row"
                  disabled={Boolean(storedSessionResumeBlocker(session, true)) || starting()}
                  title={storedSessionResumeBlocker(session, true)}
                  onClick={() => void run(() => props.onResume(session))}
                >
                  <strong>{session.name || `Session ${session.sessionId.slice(0, 8)}`}</strong>
                  <span>{session.bundle} · {timeAgo(session.mtimeMs)}</span>
                  <Show when={storedSessionResumeBlocker(session, true)} keyed>{(reason) => <small>{reason}</small>}</Show>
                </button>
              )}</For>
            </div>
          </Show>
        </Show>
        <button type="button" class="home-all-history" onClick={props.onDrawer}>Browse all stored sessions</button>
      </aside>

      <section class="home-conversation">
        <div class="home-conversation-intro">
          <div class="home-machine-mark" aria-hidden="true"><span /></div>
          <div class="eyebrow">COORDINATOR CHAT</div>
          <h1>What are we building?</h1>
          <p>Describe the outcome. Amplifier can organize the run, bring in specialists, and keep the work visible.</p>
          <Show when={latest()}>{(session) => (
            <button type="button" class="home-continue" disabled={starting()} onClick={() => void run(() => props.onResume(session()))}>
              <span>Continue recent work</span>
              <strong>{session().name || `Session ${session().sessionId.slice(0, 8)}`}</strong>
              <i aria-hidden="true">→</i>
            </button>
          )}</Show>
        </div>

        <Show when={!props.checking && !runtimeAvailable()}>
          <div class="runtime-setup-card home-runtime-card">
            <div><span>ENGINE SETUP</span><strong>{props.runtime?.message || "Runtime check unavailable"}</strong></div>
            <p>Studio uses Amplifier’s existing Python runtime out of process.</p>
            <div>
              <Show when={props.runtime?.installSupported} fallback={<button class="secondary-button" onClick={props.onSettings}>Configure bridge</button>}>
                <button class="primary-button" disabled={props.installing} onClick={props.onInstall}>{props.installing ? "Installing…" : "Install Amplifier runtime"}</button>
              </Show>
              <button class="secondary-button" onClick={props.onSettings}>Use remote bridge</button>
            </div>
          </div>
        </Show>

        <Show when={!props.checking && runtimeAvailable() && !providerStatusAvailable()}>
          <div class="runtime-setup-card home-runtime-card" role="status">
            <div><span>RUNTIME UPDATE</span><strong>Update Amplifier to verify provider readiness</strong></div>
            <p>{props.runtime?.providerMessage || "This Amplifier runtime predates provider readiness checks, so Studio cannot safely accept a prompt yet."}</p>
            <div>
              <button class="primary-button" disabled={props.installing} onClick={props.onInstall}>{props.installing ? "Updating…" : "Update Amplifier runtime"}</button>
              <button class="secondary-button" onClick={props.onSettings}>Use remote bridge</button>
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
              <button class="secondary-button" onClick={props.onSettings}>Use remote bridge</button>
            </div>
          </div>
        </Show>

        <div
          class="home-composer"
          classList={{ "dragging-images": draggingImages() }}
          onDragEnter={(event) => {
            const transfer = event.dataTransfer;
            if (transfer && hasImageFiles(transfer)) {
              event.preventDefault();
              setDraggingImages(true);
            }
          }}
          onDragOver={(event) => {
            const transfer = event.dataTransfer;
            if (transfer && hasImageFiles(transfer)) {
              event.preventDefault();
              transfer.dropEffect = "copy";
              setDraggingImages(true);
            }
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingImages(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDraggingImages(false);
            void addImageFiles(Array.from(event.dataTransfer?.files || []));
          }}
        >
          <Show when={draggingImages()}><div class="composer-drop-target">Drop images to start with</div></Show>
          <div class="home-composer-label"><span classList={{ active: ready() }} />{starting() ? "Starting coordinator…" : ready() ? "Ready when you are" : props.checking ? "Checking runtime…" : runtimeAvailable() && !providerStatusAvailable() ? "Runtime update required" : runtimeAvailable() ? "Provider setup required" : "Runtime setup required"}</div>
          <textarea
            value={text()}
            disabled={!ready() || starting()}
            placeholder={ready() ? "Tell Amplifier what you want to build, investigate, or organize…" : runtimeAvailable() && !providerStatusAvailable() ? "Update Amplifier to verify provider readiness" : runtimeAvailable() ? "Configure a model provider to start a run" : "Install or connect the Amplifier runtime to start"}
            aria-label="Message Amplifier"
            onInput={(event) => setText(event.currentTarget.value)}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData?.files || []).filter((file) => SUPPORTED_IMAGE_TYPES.has(file.type));
              if (files.length) {
                event.preventDefault();
                void addImageFiles(files);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <Show when={images().length}>
            <div class="composer-images" aria-label="Attached images">
              <For each={images()}>{(image) => (
                <div class="composer-image">
                  <img src={`data:${image.mediaType};base64,${image.data}`} alt={image.name} />
                  <span><strong>{image.name}</strong><small>{formatImageBytes(image.size)}</small></span>
                  <button type="button" aria-label={`Remove ${image.name}`} onClick={() => setImages((items) => items.filter((item) => item.id !== image.id))}>×</button>
                </div>
              )}</For>
            </div>
          </Show>
          <div class="home-composer-actions">
            <div><button type="button" onClick={props.onNew}>Configure session</button><span><kbd>↵</kbd> send · <kbd>⇧↵</kbd> newline</span></div>
            <button type="button" disabled={(!text().trim() && !images().length) || !ready() || starting()} onClick={() => void send()}>Send <span aria-hidden="true">↑</span></button>
          </div>
          <Show when={localError() || props.error}><small class="home-composer-error">{localError() || props.error}</small></Show>
        </div>

        <div class="home-transport"><span classList={{ active: ready() }} />{props.transport}{props.runtime?.version ? ` · ${props.runtime.version}` : ""}</div>
      </section>
    </main>
  );
}

function timeAgo(timestamp: number): string {
  if (!timestamp) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d` : `${Math.floor(days / 30)}mo`;
}
