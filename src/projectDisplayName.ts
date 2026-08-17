export function projectDisplayName(projectDir: string): string {
  const normalized = projectDir.trim().replace(/[\\/]+$/, "");
  if (!normalized) return "Choose project";
  return normalized.split(/[\\/]/).at(-1) || normalized;
}
