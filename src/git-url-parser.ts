/**
 * Parse a Git URL to extract the base repository URL and optional ref (branch/commit/tag).
 * Supports multiple formats from different Git hosting platforms:
 *
 * GitHub:
 * - https://github.com/user/repo/tree/{ref}
 * - https://github.com/user/repo/commit/{sha}
 * - https://github.com/user/repo/releases/tag/{tag}
 *
 * GitLab:
 * - https://gitlab.com/user/repo/-/tree/{ref}
 * - https://gitlab.com/user/repo/-/commit/{sha}
 *
 * Bitbucket:
 * - https://bitbucket.org/user/repo/src/{ref}
 * - https://bitbucket.org/user/repo/commits/{sha}
 *
 * Generic (npm/pip style):
 * - https://github.com/user/repo@{ref}
 * - https://github.com/user/repo.git@{ref}
 *
 * Plain URLs (no ref):
 * - https://github.com/user/repo
 * - https://github.com/user/repo.git
 */
export function parseGitUrl(repoUrl: string): {
  baseUrl: string;
  ref: string | null;
} {
  // npm/pip style: repo@ref or repo.git@ref
  const atRefMatch = repoUrl.match(/^(.+?)@([^@\/]+)$/);
  if (atRefMatch) {
    return { baseUrl: atRefMatch[1], ref: atRefMatch[2] };
  }

  // GitLab: /-/tree/{ref}, /-/commit/{sha}
  // Check GitLab BEFORE GitHub because GitLab URLs contain /tree/ and /commit/
  // which would otherwise match the less specific GitHub patterns
  const gitlabTreeMatch = repoUrl.match(/^(.+?)\/-\/tree\/([^\/]+)$/);
  if (gitlabTreeMatch) {
    return { baseUrl: gitlabTreeMatch[1], ref: gitlabTreeMatch[2] };
  }

  const gitlabCommitMatch = repoUrl.match(/^(.+?)\/-\/commit\/([^\/]+)$/);
  if (gitlabCommitMatch) {
    return { baseUrl: gitlabCommitMatch[1], ref: gitlabCommitMatch[2] };
  }

  // GitHub: /tree/{ref}, /commit/{sha}, /releases/tag/{tag}
  const githubTreeMatch = repoUrl.match(/^(.+?)\/tree\/([^\/]+)$/);
  if (githubTreeMatch) {
    return { baseUrl: githubTreeMatch[1], ref: githubTreeMatch[2] };
  }

  const githubCommitMatch = repoUrl.match(/^(.+?)\/commit\/([^\/]+)$/);
  if (githubCommitMatch) {
    return { baseUrl: githubCommitMatch[1], ref: githubCommitMatch[2] };
  }

  const githubReleaseMatch = repoUrl.match(/^(.+?)\/releases\/tag\/([^\/]+)$/);
  if (githubReleaseMatch) {
    return { baseUrl: githubReleaseMatch[1], ref: githubReleaseMatch[2] };
  }

  // Bitbucket: /src/{ref} (may have trailing path), /commits/{sha}
  const bitbucketSrcMatch = repoUrl.match(/^(.+?)\/src\/([^\/]+)(?:\/.*)?$/);
  if (bitbucketSrcMatch) {
    return { baseUrl: bitbucketSrcMatch[1], ref: bitbucketSrcMatch[2] };
  }

  const bitbucketCommitsMatch = repoUrl.match(/^(.+?)\/commits\/([^\/]+)$/);
  if (bitbucketCommitsMatch) {
    return { baseUrl: bitbucketCommitsMatch[1], ref: bitbucketCommitsMatch[2] };
  }

  // No ref found, return URL as-is
  return { baseUrl: repoUrl, ref: null };
}
