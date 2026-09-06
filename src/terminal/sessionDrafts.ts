export interface TerminalRenameDraft {
  terminalId: string;
  value: string;
}

export interface TerminalDraftSubmission {
  terminalId: string;
  value: string;
}

export function commandDraftFor(drafts: Readonly<Record<string, string>>, terminalId: string): string {
  return drafts[terminalId] || "";
}

export function setCommandDraft(
  drafts: Readonly<Record<string, string>>,
  terminalId: string,
  value: string,
): Record<string, string> {
  return { ...drafts, [terminalId]: value };
}

export function clearCommandDraft(
  drafts: Readonly<Record<string, string>>,
  terminalId: string,
): Record<string, string> {
  if (!(terminalId in drafts)) return drafts;
  const next = { ...drafts };
  delete next[terminalId];
  return next;
}

export function commandDraftSubmission(
  drafts: Readonly<Record<string, string>>,
  terminalId: string,
): TerminalDraftSubmission | undefined {
  const value = commandDraftFor(drafts, terminalId);
  return value.trim() ? { terminalId, value } : undefined;
}

export function renameDraftFor(
  draft: TerminalRenameDraft | undefined,
  terminalId: string,
): string | undefined {
  return draft?.terminalId === terminalId ? draft.value : undefined;
}

export function renameDraftSubmission(
  draft: TerminalRenameDraft | undefined,
  terminalId: string,
): TerminalDraftSubmission | undefined {
  const value = renameDraftFor(draft, terminalId);
  return value?.trim() ? { terminalId, value: value.trim() } : undefined;
}

/** A readable default derived from the selected directory; tmux names are ASCII. */
export function suggestedTerminalName(directory: string, existingNames: readonly string[]): string {
  const folder = directory.split(/[\\/]/).filter(Boolean).at(-1) || "terminal";
  const base = (folder.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "") || "terminal").slice(0, 56);
  const used = new Set(existingNames);
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
