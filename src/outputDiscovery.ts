import { isRecord, stringValue, type SessionOutput, type UIEvent } from "./protocol";

export interface DiscoveredOutput {
  path: string;
  kind: SessionOutput["kind"];
  provenance: NonNullable<SessionOutput["provenance"]>;
}

const TARGET_KEYS = ["file_path", "filePath", "path", "filename", "target_file", "TargetFile"];
const OUTPUT_KEYS = ["output_path", "outputPath", "output_file", "artifact_path", "destination"];
const ENVELOPES = ["result", "output", "value", "content"];

function toolLeaf(name: string): string {
  return name.trim().toLowerCase().replaceAll("-", "_").split(/[.:/]|__/).at(-1) || "";
}

function readsInput(name: string): boolean {
  return /(?:^|_)(?:read(?:_file)?|glob|grep|search|find|list|ls|stat|inspect|query|fetch|get)(?:_|$)/.test(toolLeaf(name));
}

function writesTarget(name: string): boolean {
  return /^(?:write|edit|patch|apply_patch|save|download|screenshot)(?:_|$)/.test(toolLeaf(name));
}

function producesOutput(name: string): boolean {
  if (/^(?:mkdir|create_directory|create_folder|make_directory)$/.test(toolLeaf(name))) return false;
  return writesTarget(name) || /(?:^|_)(?:create|generate|render|export)(?:_|$)/.test(toolLeaf(name)) || toolLeaf(name) === "imagegen";
}

function pathValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.trim();
  if (!path || /[\\/]$/.test(path) || ["/dev/null", "undefined", "null", "-"].includes(path) || /[\r\n\0]/.test(path)
    || /^[a-z][a-z\d+.-]*:\/\//i.test(path) || /^data:/i.test(path)) return undefined;
  return path;
}

export function outputKind(path: string): SessionOutput["kind"] {
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif", "avif", "svg"].includes(extension || "")) return "image";
  if (["dot", "gv", "mermaid", "mmd"].includes(extension || "")) return "diagram";
  if (["csv", "tsv", "json", "jsonl", "parquet"].includes(extension || "")) return "data";
  return "file";
}

function decoded(value: unknown): unknown {
  if (typeof value !== "string" || !/^[\s]*[\[{]/.test(value)) return value;
  try { return JSON.parse(value); } catch { return value; }
}

/** Amplifier ToolResult, amplifier-agent value envelopes and MCP text results. */
function resultObjects(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 7) return [];
  value = decoded(value);
  if (Array.isArray(value)) return value.flatMap((item) => resultObjects(item, depth + 1));
  if (!isRecord(value)) return [];
  const nested = ENVELOPES.flatMap((key) => resultObjects(value[key], depth + 1));
  if (value.type === "text") nested.push(...resultObjects(value.text, depth + 1));
  return [value, ...nested];
}

export function outputToolFailed(event: UIEvent): boolean {
  if (event.kind === "tool_error" || event.success === false || event.is_error === true) return true;
  return resultObjects(event.result).some((result) => result.success === false || result.ok === false
    || result.is_error === true || result.isError === true || Boolean(result.error)
    || ["denied", "rejected", "error", "failed"].includes(stringValue(result.status).toLowerCase())
    || [result.returncode, result.exit_code, result.exitCode].some((code) => typeof code === "number" && code !== 0));
}

/** Keep only naming fields while a tool runs, never its source text or command. */
export function outputTargetInput(input: unknown): Record<string, unknown> {
  input = decoded(input);
  if (!isRecord(input)) return {};
  return Object.fromEntries([...TARGET_KEYS, ...OUTPUT_KEYS].filter((key) => pathValue(input[key])).map((key) => [key, input[key]]));
}

export function toolInputPaths(input: unknown): string[] {
  const targets = outputTargetInput(input);
  return [...new Set([...TARGET_KEYS, ...OUTPUT_KEYS].flatMap((key) => pathValue(targets[key]) || []))];
}

function typedOutputs(value: unknown, provenance: DiscoveredOutput["provenance"]): DiscoveredOutput[] {
  value = decoded(value);
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const path = pathValue(isRecord(item) ? item.path ?? item.file_path ?? item.output_path : item);
    if (!path || (isRecord(item) && ["directory", "folder"].includes(stringValue(item.kind)))) return [];
    const kind = isRecord(item) ? stringValue(item.kind) : "";
    return [{ path, kind: ["file", "image", "diagram", "data"].includes(kind) ? kind as SessionOutput["kind"] : outputKind(path), provenance }];
  });
}

function reportedPaths(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line) => {
    // A numbered source excerpt, a command, or an arbitrary markdown link is
    // not a creation report. Only a whole stdout line beginning with the verb.
    const report = line.match(/^\s*(?:wrote|written(?:\s+to)?|saved(?:\s+(?:to|as))?|created|generated|exported|file created successfully at)\s*:?\s+(.+)$/i)?.[1];
    if (!report) return [];
    const markdown = report.match(/^\[[^\]]+\]\(([^)]+)\)/)?.[1];
    const quoted = report.match(/^[`"']([^`"']+)[`"']/)?.[1];
    const path = pathValue(markdown || quoted || report.split(/\s+/)[0]);
    // Plain prose and directories do not become downloadable files. Extension-
    // less outputs still work through explicit artifact/write-target metadata.
    return path && /\.[a-z\d]{1,12}$/i.test(path) ? [path] : [];
  });
}

export function discoverOutputArtifacts(event: UIEvent): DiscoveredOutput[] {
  if (event.kind === "artifact_write") {
    const path = pathValue(event.path);
    return path ? [{ path, kind: outputKind(path), provenance: "artifact-write" }] : [];
  }
  if (event.kind !== "tool_post" || outputToolFailed(event) || readsInput(stringValue(event.tool_name))) return [];
  const name = stringValue(event.tool_name);
  const results = resultObjects(event.result);
  const artifacts = typedOutputs(event.artifacts, "tool-artifact");
  for (const result of results) {
    for (const key of ["artifacts", "outputs", "created_files", "written_files", "generated_files"]) {
      artifacts.push(...typedOutputs(result[key], "tool-artifact"));
    }
    // A result's ordinary path is meaningful only for an output-producing
    // tool. Do not promote a bash/read/delegate input echo into an output.
    if (producesOutput(name)) {
      for (const key of ["path", "file_path", "filePath", "output_path", "outputPath", "artifact_path", "image_path"]) {
        const path = pathValue(result[key]);
        if (path) artifacts.push({ path, kind: outputKind(path), provenance: "tool-artifact" });
      }
    }
  }
  if (producesOutput(name)) {
    const targets = outputTargetInput(event.tool_input);
    for (const key of writesTarget(name) || toolLeaf(name) === "create_file" ? [...TARGET_KEYS, ...OUTPUT_KEYS] : OUTPUT_KEYS) {
      const path = pathValue(targets[key]);
      if (path) artifacts.push({ path, kind: outputKind(path), provenance: "write-target" });
    }
  }
  // Shell reports are useful evidence, but are labelled as reports, not an
  // independent filesystem verification. An explicit successful result is required.
  if (["bash", "shell", "exec", "exec_command"].includes(toolLeaf(name))
    && results.some((result) => result.success === true || result.returncode === 0 || result.exit_code === 0 || result.exitCode === 0)) {
    for (const result of results) {
      if (typeof result.stdout === "string") {
        artifacts.push(...reportedPaths(result.stdout).map((path) => ({ path, kind: outputKind(path), provenance: "tool-report" as const })));
      }
    }
  }
  const unique = new Map<string, DiscoveredOutput>();
  for (const artifact of artifacts) if (!unique.has(artifact.path)) unique.set(artifact.path, artifact);
  return [...unique.values()];
}
