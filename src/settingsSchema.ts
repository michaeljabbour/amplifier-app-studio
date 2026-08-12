export type RuntimeSettingKind = "bool" | "int" | "float" | "str" | "list" | "choice" | "secret";
export type RuntimeSettingScope = "global" | "project" | "local";

export interface RuntimeSettingsSection {
  id: string;
  title: string;
  summary: string;
}

export interface RuntimeSettingDefinition {
  path: string;
  section: string;
  label: string;
  kind: RuntimeSettingKind;
  help: string;
  choices?: string[];
  placeholder?: string;
}

export const RUNTIME_SETTINGS_SECTIONS: RuntimeSettingsSection[] = [
  { id: "providers", title: "Providers", summary: "Credentials loaded when Amplifier starts" },
  { id: "models-routing", title: "Models & routing", summary: "Routing matrix and opt-in behavior" },
  { id: "bundles", title: "Bundles", summary: "Active, always-on, and deferred bundles" },
  { id: "directory-access", title: "Directory access", summary: "Write boundaries and approval posture" },
  { id: "notifications", title: "Notifications", summary: "Desktop and ntfy delivery" },
  { id: "behavior", title: "Behavior", summary: "Context, compaction, hooks, pricing, and preflight" },
];

export const RUNTIME_SETTINGS_FIELDS: RuntimeSettingDefinition[] = [
  { path: "providers.anthropic.api_key", section: "providers", label: "Anthropic API key", kind: "secret", help: "Stored in ~/.amplifier/keys.env and never displayed." },
  { path: "providers.openai.api_key", section: "providers", label: "OpenAI API key", kind: "secret", help: "Stored in ~/.amplifier/keys.env and never displayed." },
  { path: "providers.azure-openai.api_key", section: "providers", label: "Azure OpenAI API key", kind: "secret", help: "Stored in ~/.amplifier/keys.env and never displayed." },
  { path: "providers.azure-openai.endpoint", section: "providers", label: "Azure OpenAI endpoint", kind: "str", help: "The Azure OpenAI endpoint URL used at boot.", placeholder: "https://resource.openai.azure.com" },
  { path: "providers.gemini.api_key", section: "providers", label: "Gemini API key", kind: "secret", help: "Stored in ~/.amplifier/keys.env and never displayed." },
  { path: "providers.google.api_key", section: "providers", label: "Google API key", kind: "secret", help: "Gemini alias stored in ~/.amplifier/keys.env and never displayed." },
  { path: "providers.github-copilot.token", section: "providers", label: "GitHub Copilot token", kind: "secret", help: "Stored in ~/.amplifier/keys.env and never displayed." },
  { path: "routing.matrix", section: "models-routing", label: "Routing matrix name", kind: "str", help: "Naming a matrix implicitly opts into routing when the explicit switch is unset.", placeholder: "balanced" },
  { path: "routing.enabled", section: "models-routing", label: "Routing enabled", kind: "bool", help: "Explicit routing switch. Unset lets a named matrix opt in." },
  { path: "tui.bundle.active", section: "bundles", label: "Active bundle", kind: "str", help: "Default bundle for the next session.", placeholder: "tui" },
  { path: "bundle.app", section: "bundles", label: "Always-on overlay bundle URIs", kind: "list", help: "Comma-separated overlays composed onto every session." },
  { path: "tui.bundle.deferred", section: "bundles", label: "Deferred overlay bundle URIs", kind: "list", help: "Comma-separated overlays held back at boot for on-demand loading." },
  { path: "tui.permissions.write_boundary", section: "directory-access", label: "Write boundary", kind: "choice", help: "Open allows project-tree writes; guarded asks first.", choices: ["open", "guarded"] },
  { path: "tui.permissions.governance", section: "directory-access", label: "Governance posture", kind: "choice", help: "Gated parks risky actions for approval in the default posture.", choices: ["open", "gated"] },
  { path: "notifications.suppress", section: "notifications", label: "Suppress all notifications", kind: "bool", help: "Silence bell, desktop delivery, and ntfy push." },
  { path: "notifications.desktop.enabled", section: "notifications", label: "Desktop notifications enabled", kind: "bool", help: "Force desktop notifications on or off; unset preserves runtime detection." },
  { path: "notifications.push.enabled", section: "notifications", label: "ntfy push enabled", kind: "bool", help: "Enable or disable off-machine ntfy delivery." },
  { path: "notifications.push.server", section: "notifications", label: "ntfy server URL", kind: "str", help: "Server used for ntfy delivery.", placeholder: "https://ntfy.sh" },
  { path: "notifications.push.priority", section: "notifications", label: "ntfy priority", kind: "choice", help: "Delivery priority for ntfy messages.", choices: ["min", "low", "default", "high", "urgent"] },
  { path: "notifications.push.tags", section: "notifications", label: "ntfy emoji tags", kind: "list", help: "Comma-separated tags sent with ntfy notifications." },
  { path: "notifications.push.topic", section: "notifications", label: "ntfy secret topic", kind: "secret", help: "Stored in ~/.amplifier/keys.env and never displayed." },
  { path: "context.max_tokens", section: "behavior", label: "Context maximum tokens", kind: "int", help: "Positive token cap for the session context module.", placeholder: "131072" },
  { path: "context.compact_threshold", section: "behavior", label: "Compaction threshold", kind: "float", help: "Fraction of the context window that triggers compaction; greater than 0 and at most 1.", placeholder: "0.8" },
  { path: "context.auto_compact", section: "behavior", label: "Automatic compaction", kind: "bool", help: "Compact automatically at the configured threshold." },
  { path: "tui.hooks.suppress", section: "behavior", label: "Suppressed hook module IDs", kind: "list", help: "Comma-separated hook module IDs left unmounted at boot." },
  { path: "tui.pricing.live", section: "behavior", label: "Live model pricing", kind: "bool", help: "Fetch live pricing instead of using only the packaged fallback table." },
  { path: "tui.resume.use_active_bundle", section: "behavior", label: "Resume using active bundle", kind: "bool", help: "Use the currently active bundle instead of the session's recorded bundle." },
  { path: "tui.preflight.verify_provider", section: "behavior", label: "Verify provider before boot", kind: "bool", help: "Validate provider configuration before starting a session." },
  { path: "tui.preflight.verify_live", section: "behavior", label: "Run live provider verification", kind: "bool", help: "Also run the networked models-list check during preflight." },
];

export function settingsFieldsInSection(section: string): RuntimeSettingDefinition[] {
  return RUNTIME_SETTINGS_FIELDS.filter((field) => field.section === section);
}

export function runtimeSettingByPath(path: string): RuntimeSettingDefinition | undefined {
  return RUNTIME_SETTINGS_FIELDS.find((field) => field.path === path);
}
