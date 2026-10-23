/**
 * Repo filter chips: configured projects pin an entry even at zero tasks so
 * the bar survives an empty board; repos seen only on tasks (unconfigured or
 * historic) stay listed too.
 */
export function buildRepoCounts(
  tasks: readonly { repo: string }[],
  projectRepos: readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const repo of projectRepos) {
    if (!counts.has(repo)) counts.set(repo, 0);
  }
  for (const t of tasks) {
    counts.set(t.repo, (counts.get(t.repo) ?? 0) + 1);
  }
  return counts;
}
