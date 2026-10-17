import type { GitHubTracker } from '../tracker/github.js';
import type { GitWorkspace } from '../workspace/git.js';
import type { IssueData, PrInfo, ProjectConfig } from '../types.js';

export class PublishError extends Error {
  constructor(
    message: string,
    readonly reason: 'uncommitted_changes' | 'no_commits' | 'push_failed' | 'create_failed',
  ) {
    super(message);
  }
}

/**
 * Idempotent publish: check-then-act. If a PR already exists for the branch
 * (e.g. crash after create but before DB write), reuse it — never create a
 * second PR. The coding subprocess never pushes; the host does.
 */
export async function publishDraftPr(input: {
  project: ProjectConfig;
  worktreePath: string;
  branch: string;
  issue: IssueData;
  prBody: string;
  workspace: GitWorkspace;
  tracker: GitHubTracker;
}): Promise<PrInfo> {
  const { project, worktreePath, branch, issue, workspace, tracker } = input;

  if (await workspace.isDirty(worktreePath)) {
    throw new PublishError(
      `worktree has uncommitted changes at publish time`,
      'uncommitted_changes',
    );
  }
  if ((await workspace.aheadCount(worktreePath, project.base_branch)) === 0) {
    throw new PublishError(`branch ${branch} has no commits vs ${project.base_branch}`, 'no_commits');
  }

  const existing = await tracker.findPrForBranch(project.repo, branch);
  await workspace.push(worktreePath, branch);
  if (existing) return existing;

  return tracker.createDraftPr(project.repo, {
    head: branch,
    base: project.base_branch,
    title: `[agent] ${issue.title}`.slice(0, 120),
    body: input.prBody,
  });
}
