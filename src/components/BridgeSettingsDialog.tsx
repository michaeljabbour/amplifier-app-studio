import { createSignal, Show } from "solid-js";

interface Props {
  initialUrl: string;
  locked: boolean;
  onCancel: () => void;
  onSave: (url: string) => void;
}

export function BridgeSettingsDialog(props: Props) {
  const [url, setUrl] = createSignal(props.initialUrl);
  const [error, setError] = createSignal("");

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    try {
      props.onSave(url());
    } catch (caught) {
      setError(String(caught).replace(/^Error:\s*/, ""));
    }
  };

  return (
    <div class="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && props.onCancel()}>
      <form class="session-dialog bridge-dialog" onSubmit={submit}>
        <div class="dialog-heading">
          <div><div class="eyebrow">RUNTIME CONNECTION</div><h2>Rust bridge</h2></div>
          <button type="button" class="icon-button" aria-label="Close dialog" onClick={props.onCancel}>×</button>
        </div>
        <label class="field full-field bridge-field">
          <span>Bridge URL <em>mobile / remote mode</em></span>
          <input
            value={url()}
            disabled={props.locked}
            onInput={(event) => setUrl(event.currentTarget.value)}
            placeholder="https://studio-bridge.example.com"
            inputMode="url"
            autofocus
          />
          <small>Leave empty on desktop to use the local Tauri process bridge. Native iOS and Android builds connect to a Rust bridge host here. Use HTTPS outside local development.</small>
        </label>
        <Show when={props.locked}><div class="form-error bridge-warning">Close live sessions before changing the bridge.</div></Show>
        <Show when={error()}><div class="form-error">{error()}</div></Show>
        <div class="dialog-footer">
          <div class="process-note"><span>◆</span> The URL is stored only on this device.</div>
          <button type="button" class="secondary-button" onClick={props.onCancel}>Cancel</button>
          <button type="submit" class="primary-button" disabled={props.locked}>Save</button>
        </div>
      </form>
    </div>
  );
}
