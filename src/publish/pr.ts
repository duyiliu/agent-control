import type { GitHubTracker } from '../tracker/github.js';
import type { GitWorkspace } from '../workspace/git.js';
import type { IssueData, PrInfo, ProjectConfig } from '../types.js';

export class PublishError extends Error {
  constructor(
    message: string,
    readonly reason: 'uncommitted_changes' | 'no_commits' | 'push_failed' | 'create_failed' | 'approval_revoked',
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
  /**
   * Final approval re-check invoked immediately before `gh pr create`
   * (after push). Returns 'ok' or the terminal phase the run should end with.
   * Closes the TOCTOU window between the PUBLISHING_PR gate and the create.
   */
  beforeCreate?: () => Promise<string>;
}): Promise<PrInfo> {
  const { project, worktreePath, branch, issue, workspace, tracker } = input;

  if (await workspace.isDirty(worktreePath)) {
    // The agent is asked to commit, but it may leave uncommitted leftovers.
    // Commit them verbatim as the host — never fabricate content, just
    // record what exists.
    await workspace.commitAll(
      worktreePath,
      `agent-control: commit uncommitted agent work for issue #${issue.number}`,
    );
    if (await workspace.isDirty(worktreePath)) {
      throw new PublishError(
        `worktree still has uncommitted changes after fallback commit`,
        'uncommitted_changes',
      );
    }
  }
  if ((await workspace.aheadCount(worktreePath, project.base_branch)) === 0) {
    throw new PublishError(`branch ${branch} has no commits vs ${project.base_branch}`, 'no_commits');
  }

  const existing = await tracker.findPrForBranch(project.repo, branch);
  await workspace.push(worktreePath, branch);
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
