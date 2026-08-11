import { createSignal, Show } from "solid-js";
import type { RuntimeStatus } from "../transport";

interface Props {
  onClose: () => void;
  onConfigured: (status: RuntimeStatus) => void;
  configure: (input: {
    providerType: string;
    apiKey: string;
    model?: string;
    baseUrl?: string;
  }) => Promise<RuntimeStatus>;
}

export function ProviderSetupDialog(props: Props) {
  const [providerType, setProviderType] = createSignal("anthropic");
  const [apiKey, setApiKey] = createSignal("");
  const [model, setModel] = createSignal("");
  const [baseUrl, setBaseUrl] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string>();

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (saving() || !providerType().trim() || !apiKey().trim()) return;
    setSaving(true);
    setError(undefined);
    try {
      const status = await props.configure({
        providerType: providerType(),
        apiKey: apiKey(),
        model: model(),
        baseUrl: baseUrl(),
      });
      setApiKey("");
      props.onConfigured(status);
      props.onClose();
    } catch (reason) {
      setError(String(reason).replace(/^Error:\s*/, ""));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <form class="provider-setup-dialog" aria-labelledby="provider-setup-title" onSubmit={submit}>
        <div class="dialog-heading">
          <div><div class="eyebrow">AMPLIFIER SETUP</div><h2 id="provider-setup-title">Connect a model provider</h2></div>
          <button type="button" class="icon-button" onClick={props.onClose} aria-label="Close provider setup">×</button>
        </div>
        <p>Studio passes the credential directly to Amplifier over stdin. It is not placed in process arguments or WebView storage.</p>
        <label>
          Provider
          <select value={providerType()} onChange={(event) => setProviderType(event.currentTarget.value)}>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="gemini">Google Gemini</option>
            <option value="azure-openai">Azure OpenAI</option>
            <option value="vllm">OpenAI-compatible / vLLM</option>
          </select>
        </label>
        <label>
          API key
          <input type="password" autocomplete="off" spellcheck={false} value={apiKey()} onInput={(event) => setApiKey(event.currentTarget.value)} />
        </label>
        <div class="provider-setup-optional">
          <label>Model <input value={model()} placeholder="Use provider default" onInput={(event) => setModel(event.currentTarget.value)} /></label>
          <label>Base URL <input value={baseUrl()} placeholder="Optional" onInput={(event) => setBaseUrl(event.currentTarget.value)} /></label>
        </div>
        <Show when={error()}><div class="dialog-error" role="alert">{error()}</div></Show>
        <div class="dialog-actions">
          <button type="button" class="secondary-button" onClick={props.onClose}>Cancel</button>
          <button type="submit" class="primary-button" disabled={saving() || !providerType().trim() || !apiKey().trim()}>{saving() ? "Connecting…" : "Connect provider"}</button>
        </div>
      </form>
    </div>
  );
}
