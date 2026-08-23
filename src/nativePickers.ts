import { invoke } from "@tauri-apps/api/core";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { appendAttachmentFiles } from "./attachments";
import type { ComposerAttachment } from "./protocol";
import { isDesktopRuntime, isMobileRuntime, isTauriRuntime, type NativeAttachment } from "./transport";

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
  return projectPickerAvailableForRuntime(isTauriRuntime(), isMobileRuntime());
}

export function projectPickerAvailableForRuntime(tauri: boolean, mobile: boolean): boolean {
  return tauri && !mobile;
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
  // Mobile has no host filesystem to read: fall back to the WebView picker.
  if (!isDesktopRuntime()) return pickBrowserAttachments();
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
  if (isDesktopRuntime()) {
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

export async function savePngFile(defaultName: string, contents: Blob): Promise<string | undefined> {
  if (isDesktopRuntime()) {
    const selected = await saveDialog({
      title: "Save Amplifier visual as PNG",
      defaultPath: defaultName,
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    const selectedPath = typeof selected === "string" && selected.trim() ? selected : undefined;
    if (!selectedPath) return undefined;
    const path = /\.png$/i.test(selectedPath) ? selectedPath : `${selectedPath}.png`;
    const dataBase64 = await blobBase64(contents);
    await invoke("write_visual_png", { path, dataBase64 });
    return path;
  }

  const url = URL.createObjectURL(contents);
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

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Could not prepare the PNG for saving."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) reject(new Error("Could not encode the PNG for saving."));
      else resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
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
