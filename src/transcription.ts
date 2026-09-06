export interface AudioRecording {
  mediaType: string;
  data: string;
  durationMs?: number;
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
  onLevel?: (level: number, device: string) => void,
): Promise<AudioCaptureSession> {
  if (!scope?.navigator?.mediaDevices?.getUserMedia || !scope.MediaRecorder) {
    throw new Error("Microphone recording is not available in this WebView.");
  }
  const stream = await scope.navigator.mediaDevices.getUserMedia({ audio: true });
  const track = stream.getAudioTracks()[0];
  let meter: AudioContext | undefined;
  let meterTimer: ReturnType<typeof setInterval> | undefined;
  try {
    if (onLevel && scope.AudioContext) {
      meter = new scope.AudioContext();
      const analyser = meter.createAnalyser();
      analyser.fftSize = 256;
      meter.createMediaStreamSource(stream).connect(analyser);
      await meter.resume();
      const samples = new Uint8Array(analyser.fftSize);
      meterTimer = setInterval(() => {
        analyser.getByteTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, v) => sum + ((v - 128) / 128) ** 2, 0) / samples.length);
        onLevel(Math.min(1, rms * 5), track?.label || "Default microphone");
      }, 100);
    }
  } catch { /* Meter support must not prevent audio capture. */ }
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
  // Capture errors can arrive before the caller asks to stop. Keep the rejection
  // handled while still returning the original rejected promise from stop().
  void recording.catch(() => undefined);
  const startedAt = Date.now();
  const closeTracks = () => {
    if (meterTimer) clearInterval(meterTimer);
    void meter?.close().catch(() => undefined);
    stream.getTracks().forEach((track) => track.stop());
  };

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
    const durationMs = Date.now() - startedAt;
    if (!chunks.length) {
      rejectRecording?.(new Error("No audio was captured. Wait for Listening before speaking, then try again."));
      return;
    }
    const blob = new Blob(chunks, { type: recorder.mimeType || mediaType || "audio/webm" });
    void blobToBase64(blob).then((data) => resolveRecording?.({ mediaType: blob.type, data, durationMs }), rejectRecording);
  };
  // Collect regularly, including the final dataavailable event before onstop.
  // This also avoids relying on a single long WebKit recording chunk.
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("The microphone did not become ready. Try again.")), 5000);
      recorder.onstart = () => { clearTimeout(timeout); resolve(); };
      try { recorder.start(250); } catch (error) { clearTimeout(timeout); reject(error); }
    });
  } catch (error) {
    settled = true;
    if (recorder.state !== "inactive") recorder.stop();
    closeTracks();
    throw error;
  }

  return {
    stop: () => {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
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

export function appendTranscript(baseDraft: string, transcript: string): string {
  const base = baseDraft.trimEnd();
  const spoken = transcript.trim();
  if (!spoken) return baseDraft;
  if (!base) return spoken;
  return `${base} ${spoken}`;
}

function preferredMediaType(Recorder: typeof MediaRecorder): string | undefined {
  return ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"]
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
