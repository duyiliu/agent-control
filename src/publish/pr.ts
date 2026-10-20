import type { GitHubTracker } from '../tracker/github.js';
import type { GitWorkspace } from '../workspace/git.js';
import type { IssueData, PrInfo, ProjectConfig } from '../types.js';

export class PublishError extends Error {
  constructor(
    message: string,
    readonly reason: 'uncommitted_changes' | 'head_changed' | 'no_commits' | 'push_failed' | 'create_failed' | 'approval_revoked',
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
  expectedHead: string;
  /**
   * Final approval re-check invoked immediately before `gh pr create`
   * (after push). Returns 'ok' or the terminal phase the run should end with.
   * Closes the TOCTOU window between the PUBLISHING_PR gate and the create.
   */
  beforeCreate?: () => Promise<string>;
}): Promise<PrInfo> {
  const { project, worktreePath, branch, issue, workspace, tracker } = input;

  const assertReviewed = async () => {
    if (await workspace.isDirty(worktreePath)) {
      throw new PublishError('worktree changed after verification; refusing to commit during publish', 'uncommitted_changes');
    }
    if (!input.expectedHead || await workspace.head(worktreePath) !== input.expectedHead) {
      throw new PublishError('branch HEAD changed after review', 'head_changed');
    }
  };
  await assertReviewed();
  if ((await workspace.aheadCount(worktreePath, project.base_branch)) === 0) {
    throw new PublishError(`branch ${branch} has no commits vs ${project.base_branch}`, 'no_commits');
  }

  const existing = await tracker.findPrForBranch(project.repo, branch);
  await assertReviewed();
  await workspace.push(worktreePath, branch, input.expectedHead);
  await assertReviewed();
  if (existing) return existing;

  const gate = await input.beforeCreate?.();
  if (gate && gate !== 'ok') {
    throw new PublishError(`approval revoked before PR create: ${gate}`, 'approval_revoked');
  }

  return tracker.createDraftPr(project.repo, {
    head: branch,
    base: project.base_branch,
    title: `[agent] ${issue.title}`.slice(0, 120),
    body: input.prBody,
  });
}
