export interface GithubRepositoryIdentity {
  owner: string;
  name: string;
  repository: string;
}

export function parseGithubRepositoryUrl(value: string): GithubRepositoryIdentity {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a GitHub repository URL such as https://github.com/owner/repository");
  }
  if (url.protocol !== "https:"
    || url.hostname !== "github.com"
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash) {
    throw new Error("Use a plain HTTPS GitHub repository URL without credentials, a port, query, or fragment.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new Error("Use the repository URL itself, not a branch, issue, file, or organization page.");
  }
  const owner = parts[0];
  const name = parts[1].replace(/\.git$/, "");
  if (!/^(?!-)[A-Za-z0-9-]{1,39}(?<!-)$/.test(owner)
    || !/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/.test(name)) {
    throw new Error("The GitHub owner or repository name is invalid.");
  }
  return { owner, name, repository: `${owner}/${name}` };
}

export function githubCloneDestination(value: string, remoteHostName?: string): string {
  try {
    const { name } = parseGithubRepositoryUrl(value);
    return remoteHostName ? `${remoteHostName} · dev/${name}` : `~/dev/${name}`;
  } catch {
    return remoteHostName ? `${remoteHostName} · dev/<repository>` : "~/dev/<repository>";
  }
}
