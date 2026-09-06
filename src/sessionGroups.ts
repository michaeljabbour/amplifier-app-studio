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
