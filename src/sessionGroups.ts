/** Group by exact directory and compute identity; never merge two hosts' paths. */
export function groupByDirectory<T>(items: readonly T[], location: (item: T) => { path?: string; host?: string; hostName?: string }) {
  const groups = new Map<string, { key: string; path: string; name: string; hostName: string; items: T[] }>();
  for (const item of items) {
    const value = location(item);
    const path = value.path || "Directory unavailable";
    const key = `${value.host || "local"}\u0000${path}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, path, name: path.split(/[\\/]/).filter(Boolean).at(-1) || path, hostName: value.hostName || "This computer", items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  return [...groups.values()];
}

export function shortBundleName(bundle: string) {
  return bundle.split(/[\\/]/).filter(Boolean).at(-1) || bundle;
}


export interface SessionBranch<T> {
  session: T;
  children: SessionBranch<T>[];
}

/** Keep host identities separate and preserve orphaned or malformed lineage. */
export function sessionTree<T extends { sessionId: string; hostId?: string; parentSessionId?: string; projectSlug?: string }>(sessions: readonly T[]): SessionBranch<T>[] {
  const key = (id: string, host?: string) => `${host || "local"}\u0000${id}`;
  const nodes = sessions.map((session) => ({ session, children: [] as SessionBranch<T>[] }));
  const byId = new Map<string, typeof nodes>();
  for (const node of nodes) {
    const id = key(node.session.sessionId, node.session.hostId);
    byId.set(id, [...(byId.get(id) || []), node]);
  }
  const parentOf = (session: T) => {
    if (!session.parentSessionId) return undefined;
    const candidates = byId.get(key(session.parentSessionId, session.hostId)) || [];
    return candidates.find((node) => node.session.projectSlug === session.projectSlug)
      || (candidates.length === 1 ? candidates[0] : undefined);
  };
  const roots: SessionBranch<T>[] = [];
  for (const node of nodes) {
    const seen = new Set<SessionBranch<T>>([node]);
    let ancestor = parentOf(node.session);
    let cyclic = false;
    while (ancestor) {
      if (seen.has(ancestor)) { cyclic = true; break; }
      seen.add(ancestor);
      ancestor = parentOf(ancestor.session);
    }
    const parent = parentOf(node.session);
    if (parent && !cyclic) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Search retains the ancestors needed to understand a matching child. */
export function filterSessionTree<T>(nodes: SessionBranch<T>[], matches: (session: T) => boolean): SessionBranch<T>[] {
  return nodes.flatMap((node) => {
    if (matches(node.session)) return [node];
    const children = filterSessionTree(node.children, matches);
    return children.length ? [{ ...node, children }] : [];
  });
}
