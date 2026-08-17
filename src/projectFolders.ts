import type { NewSessionInput } from "./protocol";
import type { HostDirectoryListing, RuntimeHost } from "./transport";

export interface ProjectBreadcrumb {
  label: string;
  path: string;
}

export function remoteProjectDefault(host: RuntimeHost | undefined, configuredDefault: string): string {
  return configuredDefault.trim() || host?.defaultProjectRoot?.trim() || "";
}

export function shouldRememberProjectLocally(input: Pick<NewSessionInput, "hostId" | "hostUrl">): boolean {
  return !input.hostUrl || input.hostId === "local";
}

export function isPathInsideRoot(path: string, root: string): boolean {
  const separator = pathSeparator(path);
  const comparableCurrent = comparablePath(trimTrailingSeparator(path.trim()), separator);
  const comparableRoot = comparablePath(trimTrailingSeparator(root.trim()), separator);
  if (!comparableCurrent || !comparableRoot) return false;
  const rootBoundary = comparableRoot.endsWith(separator) ? comparableRoot : `${comparableRoot}${separator}`;
  return comparableCurrent === comparableRoot || comparableCurrent.startsWith(rootBoundary);
}

export function directoryBreadcrumbs(listing: Pick<HostDirectoryListing, "path" | "roots">): ProjectBreadcrumb[] {
  const current = trimTrailingSeparator(listing.path.trim());
  if (!current) return [];
  const separator = pathSeparator(current);
  const root = listing.roots
    .map((candidate) => trimTrailingSeparator(candidate.trim()))
    .filter(Boolean)
    .filter((candidate) => isPathInsideRoot(current, candidate))
    .sort((left, right) => right.length - left.length)[0];
  if (!root) return [{ label: current, path: current }];

  const crumbs: ProjectBreadcrumb[] = [{ label: pathLabel(root, separator), path: root }];
  const relative = current.slice(root.length).replace(/^[/\\]+/, "");
  if (!relative) return crumbs;
  let path = root;
  for (const segment of relative.split(separator).filter(Boolean)) {
    path = joinPath(path, segment, separator);
    crumbs.push({ label: segment, path });
  }
  return crumbs;
}

function pathSeparator(path: string): "/" | "\\" {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

function trimTrailingSeparator(path: string): string {
  if (path === "/" || /^[A-Za-z]:[\\/]?$/.test(path)) return path.replace(/\/$/, "\\");
  return path.replace(/[/\\]+$/, "");
}

function comparablePath(path: string, separator: "/" | "\\"): string {
  const normalized = path.replaceAll(separator === "/" ? "\\" : "/", separator);
  return separator === "\\" ? normalized.toLowerCase() : normalized;
}

function pathLabel(path: string, separator: "/" | "\\"): string {
  if (path === "/") return "/";
  const parts = path.split(separator).filter(Boolean);
  return parts.at(-1) || path;
}

function joinPath(parent: string, child: string, separator: "/" | "\\"): string {
  if (parent === "/") return `/${child}`;
  if (parent.endsWith(separator)) return `${parent}${child}`;
  return `${parent}${separator}${child}`;
}
