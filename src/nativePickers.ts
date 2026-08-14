import { invoke } from "@tauri-apps/api/core";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { appendAttachmentFiles } from "./attachments";
import type { ComposerAttachment } from "./protocol";
import { isTauriRuntime, type NativeAttachment } from "./transport";

const ATTACHMENT_FILTER = {
  name: "Images and documents",
  extensions: [
    "png", "jpg", "jpeg", "gif", "webp", "pdf", "docx", "txt", "md", "markdown", "json", "jsonl", "csv", "tsv",
    "yaml", "yml", "toml", "xml", "html", "htm", "css", "scss", "less", "js", "mjs", "cjs", "ts", "tsx", "jsx",
    "py", "rs", "go", "java", "kt", "swift", "c", "cc", "cpp", "h", "hpp", "sh", "bash", "zsh", "fish", "ps1",
    "log", "sql", "rtf", "env", "ini", "cfg", "conf", "properties",
  ],
};

export function nativeProjectPickerAvailable(): boolean {
  return isTauriRuntime();
}

export async function pickProjectDirectory(defaultPath?: string): Promise<string | undefined> {
  if (!nativeProjectPickerAvailable()) return undefined;
  const selected = await open({
    title: "Choose an Amplifier project folder",
    directory: true,
    multiple: false,
    defaultPath: defaultPath?.trim() || undefined,
  });
  return normalizePickerPaths(selected)[0];
}

export async function pickAttachments(): Promise<ComposerAttachment[]> {
  if (!isTauriRuntime()) return pickBrowserAttachments();
  const selected = await open({
    title: "Add files to Amplifier",
    directory: false,
    multiple: true,
    filters: [ATTACHMENT_FILTER],
  });
  const paths = normalizePickerPaths(selected);
  if (!paths.length) return [];
  const attachments = await invoke<NativeAttachment[]>("load_attachment_paths", { paths });
  return attachments.map((attachment, index) => ({
    ...attachment,
    id: globalThis.crypto?.randomUUID?.() || `picked-attachment-${Date.now()}-${index}`,
  }));
}

export async function saveDiagnosticsFile(defaultName: string, contents: string): Promise<string | undefined> {
  if (isTauriRuntime()) {
    const selected = await saveDialog({
      title: "Export Amplifier Studio diagnostics",
      defaultPath: defaultName,
      filters: [{ name: "JSON diagnostics", extensions: ["json"] }],
    });
    const path = typeof selected === "string" && selected.trim() ? selected : undefined;
    if (!path) return undefined;
    await invoke("write_diagnostics", { path, contents });
    return path;
  }

  const blob = new Blob([contents], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = defaultName;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  queueMicrotask(() => URL.revokeObjectURL(url));
  return defaultName;
}

export function normalizePickerPaths(selected: unknown): string[] {
  if (typeof selected === "string") return selected.trim() ? [selected] : [];
  if (!Array.isArray(selected)) return [];
  return selected.filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
}

async function pickBrowserAttachments(): Promise<ComposerAttachment[]> {
  const files = await new Promise<File[]>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp,.pdf,.docx,.txt,.md,.markdown,.json,.jsonl,.csv,.tsv,.yaml,.yml,.toml,.xml,.html,.htm,.css,.scss,.less,.js,.mjs,.cjs,.ts,.tsx,.jsx,.py,.rs,.go,.java,.kt,.swift,.c,.cc,.cpp,.h,.hpp,.sh,.bash,.zsh,.fish,.ps1,.log,.sql,.rtf,.env,.ini,.cfg,.conf,.properties";
    input.multiple = true;
    input.addEventListener("change", () => resolve(Array.from(input.files || [])), { once: true });
    input.addEventListener("cancel", () => resolve([]), { once: true });
    input.click();
  });
  return files.length ? appendAttachmentFiles([], files) : [];
}
