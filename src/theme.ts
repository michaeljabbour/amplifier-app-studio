export type StudioTheme = "made" | "studio";

const THEME_STORAGE_KEY = "amplifier-studio.theme";

export function loadStudioTheme(storage: Pick<Storage, "getItem"> = localStorage): StudioTheme {
  return storage.getItem(THEME_STORAGE_KEY) === "studio" ? "studio" : "made";
}

export function applyStudioTheme(theme: StudioTheme): void {
  document.documentElement.dataset.theme = theme;
}

export function saveStudioTheme(theme: StudioTheme, storage: Pick<Storage, "setItem"> = localStorage): void {
  storage.setItem(THEME_STORAGE_KEY, theme);
  applyStudioTheme(theme);
}
