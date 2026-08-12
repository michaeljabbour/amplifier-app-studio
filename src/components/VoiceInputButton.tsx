import { createSignal, onCleanup, Show } from "solid-js";
import { appendTranscript, audioCaptureAvailable, startAudioCapture, type AudioCaptureSession, type AudioRecording } from "../transcription";

const CAPTURE_STOP_TIMEOUT_MS = 8_000;
const TRANSCRIPTION_TIMEOUT_MS = 45_000;

interface Props {
  draft: string;
  available: boolean;
  unavailableReason?: string;
  disabled?: boolean;
  onDraft: (draft: string) => void;
  onTranscribe: (recording: AudioRecording) => Promise<string>;
  onActiveChange?: (active: boolean) => void;
}

export function VoiceInputButton(props: Props) {
  const [active, setActive] = createSignal(false);
  const [processing, setProcessing] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const captureAvailable = audioCaptureAvailable();
  let capture: AudioCaptureSession | undefined;
  let baseDraft = "";

  const setBlocked = (blocked: boolean) => props.onActiveChange?.(blocked);

  const toggle = async () => {
    if (processing()) return;
    if (active()) {
      const current = capture;
      capture = undefined;
      setActive(false);
      setProcessing(true);
      try {
        if (!current) throw new Error("The microphone recording is no longer available.");
        const recording = await promiseWithTimeout(
          current.stop(),
          CAPTURE_STOP_TIMEOUT_MS,
          "The microphone did not finish the recording. Try again.",
        );
        const transcript = await promiseWithTimeout(
          props.onTranscribe(recording),
          TRANSCRIPTION_TIMEOUT_MS,
          "Transcription took too long. Check the network connection and try again.",
        );
        props.onDraft(appendTranscript(baseDraft, transcript));
      } catch (cause) {
        setError(cause instanceof Error
          ? cause.message
          : typeof cause === "string"
            ? cause
            : "Voice input could not be transcribed.");
      } finally {
        setProcessing(false);
        setBlocked(false);
      }
      return;
    }

    setError(undefined);
    baseDraft = props.draft;
    try {
      capture = await startAudioCapture();
      setActive(true);
      setBlocked(true);
    } catch (cause) {
      setError(cause instanceof Error
        ? cause.message
        : typeof cause === "string"
          ? cause
          : "Microphone recording could not start.");
      setBlocked(false);
    }
  };

  onCleanup(() => capture?.abort());

  const usable = () => captureAvailable && props.available;
  const tooltip = () => !captureAvailable
    ? "Voice input is not available in this WebView"
    : !props.available
      ? props.unavailableReason || "Configure speech-to-text on the runtime host"
      : active()
        ? "Stop voice input and place the transcript in the draft"
        : `Use speech-to-text to fill the editable draft. Studio never submits automatically. ${props.unavailableReason || ""}`;
  const status = () => processing() ? "Transcribing voice input" : active() ? "Listening · click again to transcribe" : "";

  return (
    <span class="voice-input-control">
      <button
        type="button"
        class="voice-input-trigger"
        classList={{ active: active(), processing: processing() }}
        disabled={props.disabled || processing() || !usable()}
        aria-pressed={active()}
        aria-label={active() ? "Stop voice input and transcribe" : "Start voice input"}
        title={tooltip()}
        onClick={() => void toggle()}
      >
        <Show when={processing()} fallback={<MicrophoneIcon stop={active()} />}>
          <span class="voice-input-spinner" aria-hidden="true" />
        </Show>
      </button>
      <Show when={status()}>{(message) => <span class="voice-input-status" aria-live="polite">{message()}</span>}</Show>
      <Show when={error()} keyed>{(message) => (
        <small role="alert">
          <span>{message}</span>
          <button type="button" aria-label="Dismiss voice input error" onClick={() => setError(undefined)}>×</button>
        </small>
      )}</Show>
    </span>
  );
}

function MicrophoneIcon(props: { stop: boolean }) {
  return props.stop
    ? <span class="voice-input-stop" aria-hidden="true" />
    : (
      <svg class="voice-input-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 15.25a3.75 3.75 0 0 0 3.75-3.75v-4a3.75 3.75 0 1 0-7.5 0v4A3.75 3.75 0 0 0 12 15.25Z" />
        <path d="M5.75 11.25v.5a6.25 6.25 0 0 0 12.5 0v-.5M12 18v3M9 21h6" />
      </svg>
    );
}

export function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}
