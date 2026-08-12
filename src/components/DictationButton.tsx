import { createSignal, onCleanup, Show } from "solid-js";
import { appendDictation, audioCaptureAvailable, startAudioCapture, type AudioCaptureSession, type AudioRecording } from "../transcription";

interface Props {
  draft: string;
  available: boolean;
  unavailableReason?: string;
  disabled?: boolean;
  onDraft: (draft: string) => void;
  onTranscribe: (recording: AudioRecording) => Promise<string>;
  onActiveChange?: (active: boolean) => void;
}

export function DictationButton(props: Props) {
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
        const recording = await current.stop();
        const transcript = await props.onTranscribe(recording);
        props.onDraft(appendDictation(baseDraft, transcript));
      } catch (cause) {
        setError(cause instanceof Error
          ? cause.message
          : typeof cause === "string"
            ? cause
            : "Dictation could not be transcribed.");
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
    ? "Microphone recording is not available in this WebView"
    : !props.available
      ? props.unavailableReason || "Configure transcription on the runtime host"
      : active()
        ? "Stop recording, transcribe, and edit the draft before sending"
        : `Record a bounded clip for transcription. Studio places the result in the draft and never submits automatically. ${props.unavailableReason || ""}`;
  const label = () => processing() ? "Transcribing" : active() ? "Listening" : "Mic";

  return (
    <span class="dictation-control">
      <button
        type="button"
        class="dictation-trigger"
        classList={{ active: active(), processing: processing() }}
        disabled={props.disabled || processing() || !usable()}
        aria-pressed={active()}
        aria-label={active() ? "Stop and transcribe dictation" : "Dictate a message"}
        title={tooltip()}
        onClick={() => void toggle()}
      ><span aria-hidden="true">{processing() ? "◌" : active() ? "■" : "●"}</span>{label()}</button>
      <Show when={error()} keyed>{(message) => <small role="alert">{message}</small>}</Show>
    </span>
  );
}
