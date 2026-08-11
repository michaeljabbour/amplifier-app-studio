import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "./transport";

export type AppUpdateStatus = "disabled" | "checking" | "current" | "available" | "downloading" | "installing" | "error";

export interface AppUpdateState {
  status: AppUpdateStatus;
  version?: string;
  currentVersion?: string;
  notes?: string;
  date?: string;
  progress?: number;
  message?: string;
}

interface UpdateMetadata {
  version: string;
  currentVersion: string;
  body?: string;
  date?: string;
}

type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export function appUpdatesEnabled(): boolean {
  const mobileWebView = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const override = import.meta.env.VITE_STUDIO_UPDATER_ENABLED;
  return isTauriRuntime()
    && !mobileWebView
    && override !== "false"
    && (import.meta.env.PROD || override === "true");
}

export async function checkForAppUpdate(): Promise<AppUpdateState> {
  if (!appUpdatesEnabled()) return { status: "disabled" };
  const update = await invoke<UpdateMetadata | null>("fetch_update");
  if (!update) return { status: "current" };
  return {
    status: "available",
    version: update.version,
    currentVersion: update.currentVersion,
    notes: update.body,
    date: update.date,
  };
}

export async function installAppUpdate(
  update: AppUpdateState,
  onState: (state: AppUpdateState) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | undefined;
  onState({ ...update, status: "downloading", progress: 0 });
  const unlisten = await listen<DownloadEvent>("app://update/progress", ({ payload }) => {
    if (payload.event === "Started") {
      total = payload.data.contentLength;
      onState({ ...update, status: "downloading", progress: 0 });
      return;
    }
    if (payload.event === "Progress") {
      downloaded += payload.data.chunkLength;
      const progress = total ? Math.min(99, Math.round((downloaded / total) * 100)) : undefined;
      onState({ ...update, status: "downloading", progress });
      return;
    }
    onState({ ...update, status: "installing", progress: 100 });
  });
  try {
    await invoke("install_update");
  } finally {
    unlisten();
  }
}
