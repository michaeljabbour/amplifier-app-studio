import { createSignal } from "solid-js";
import { VisualArtifact } from "./components/VisualArtifact";
import { VoiceInputButton } from "./components/VoiceInputButton";

const dotSource = `digraph "Real window DOT" {
  rankdir=LR;
  graph [bgcolor="transparent", pad="0.25"];
  node [shape=box, style="rounded,filled", fillcolor="#f8f4ee", color="#9b7a43"];
  source [label="  Session history  "];
  sanitize [label="Sanitize SVG"];
  window [label="Real app window"];
  source -> sanitize -> window;
}`;

const svgSource = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 220">
  <title>Sanitized SVG smoke</title>
  <rect width="640" height="220" rx="18" fill="#f4efe8"/>
  <path d="M72 110h496" stroke="#b68235" stroke-width="3"/>
  <circle cx="120" cy="110" r="34" fill="#d7e8dc"/>
  <circle cx="320" cy="110" r="34" fill="#e8dcc7"/>
  <circle cx="520" cy="110" r="34" fill="#dce4ee"/>
  <text x="120" y="116" text-anchor="middle">source</text>
  <text x="320" y="116" text-anchor="middle">safe</text>
  <text x="520" y="116" text-anchor="middle">visible</text>
  <script>alert("must be removed")</script>
</svg>`;

const htmlSource = `<title>Sandboxed HTML smoke</title>
<main style="font:16px system-ui;max-width:720px;margin:auto">
  <h1>HTML artifact is contained</h1>
  <p>This content scrolls inside its own frame and cannot access Studio or the network.</p>
  <table style="border-collapse:collapse;width:100%">
    <tr><th style="text-align:left;border-bottom:1px solid #999">Surface</th><th style="text-align:left;border-bottom:1px solid #999">Expected</th></tr>
    <tr><td>DOT</td><td>Rendered SVG</td></tr><tr><td>Voice</td><td>Actionable state</td></tr>
  </table>
</main>`;

export default function RealWindowSmoke() {
  const [draft, setDraft] = createSignal("Existing editable draft.");

  return (
    <main class="real-window-smoke" aria-label="Amplifier Studio real window smoke test">
      <header>
        <span>RELEASE QUALIFICATION</span>
        <h1>Artifacts and voice in a real Studio window</h1>
        <p>This build renders the shipping components under the packaged WebView and production CSP.</p>
      </header>
      <section class="real-window-smoke-grid" aria-label="Artifact viewers">
        <VisualArtifact format="dot" source={dotSource} />
        <VisualArtifact format="svg" source={svgSource} />
        <VisualArtifact format="html" source={htmlSource} />
      </section>
      <section class="real-window-smoke-voice" aria-label="Voice input state">
        <div>
          <span>VOICE INPUT</span>
          <strong>Button and failure copy remain operable in the packaged WebView</strong>
          <p>{draft()}</p>
        </div>
        <VoiceInputButton
          draft={draft()}
          available={false}
          unavailableReason="Smoke build has no transcription provider; the microphone control is reachable."
          onDraft={setDraft}
          onTranscribe={async () => ""}
        />
      </section>
    </main>
  );
}
