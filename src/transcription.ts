export interface AudioRecording {
  mediaType: string;
  data: string;
}

export interface AudioCaptureSession {
  stop: () => Promise<AudioRecording>;
  abort: () => void;
}

type AudioCaptureWindow = Window & typeof globalThis;

export function audioCaptureAvailable(scope: AudioCaptureWindow | undefined = typeof window === "undefined" ? undefined : window): boolean {
  return Boolean(scope?.navigator?.mediaDevices?.getUserMedia && scope.MediaRecorder);
}

export async function startAudioCapture(
  scope: AudioCaptureWindow | undefined = typeof window === "undefined" ? undefined : window,
): Promise<AudioCaptureSession> {
  if (!scope?.navigator?.mediaDevices?.getUserMedia || !scope.MediaRecorder) {
    throw new Error("Microphone recording is not available in this WebView.");
  }
  const stream = await scope.navigator.mediaDevices.getUserMedia({ audio: true });
  const mediaType = preferredMediaType(scope.MediaRecorder);
  const recorder = mediaType ? new scope.MediaRecorder(stream, { mimeType: mediaType }) : new scope.MediaRecorder(stream);
  const chunks: Blob[] = [];
  let settled = false;
  let resolveRecording: ((recording: AudioRecording) => void) | undefined;
  let rejectRecording: ((error: Error) => void) | undefined;
  const recording = new Promise<AudioRecording>((resolve, reject) => {
    resolveRecording = resolve;
    rejectRecording = reject;
  });
  const closeTracks = () => stream.getTracks().forEach((track) => track.stop());

  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data.size) chunks.push(event.data);
  };
  recorder.onerror = () => {
    if (settled) return;
    settled = true;
    closeTracks();
    rejectRecording?.(new Error("Microphone recording failed."));
  };
  recorder.onstop = () => {
    if (settled) return;
    settled = true;
    closeTracks();
    const blob = new Blob(chunks, { type: recorder.mimeType || mediaType || "audio/webm" });
    void blobToBase64(blob).then((data) => resolveRecording?.({ mediaType: blob.type, data }), rejectRecording);
  };
  recorder.start(250);

  return {
    stop: () => {
      if (recorder.state !== "inactive") recorder.stop();
      return recording;
    },
    abort: () => {
      if (!settled) {
        settled = true;
        closeTracks();
      }
      if (recorder.state !== "inactive") recorder.stop();
    },
  };
}

export function appendDictation(baseDraft: string, transcript: string): string {
  const base = baseDraft.trimEnd();
  const spoken = transcript.trim();
  if (!spoken) return baseDraft;
  if (!base) return spoken;
  return `${base} ${spoken}`;
}

function preferredMediaType(Recorder: typeof MediaRecorder): string | undefined {
  return ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"]
    .find((mediaType) => Recorder.isTypeSupported(mediaType));
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
