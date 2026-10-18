import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runProc } from '../proc.js';

export class WorkspaceError extends Error {}

export class GitWorkspace {
  constructor(private exec: typeof runProc = runProc) {}

  private async git(args: string[], cwd: string, timeoutMs = 60_000) {
    const res = await this.exec({ argv: ['git', ...args], cwd, timeoutMs });
    if (res.exitCode !== 0) {
      throw new WorkspaceError(
        `git ${args.join(' ')} failed in ${cwd}: ${res.stderrTail.trim() || res.stdoutTail.trim()}`,
      );
    }
    return res;
  }

  /**
   * Ensure `worktreePath` is a worktree on `branch` based on `baseBranch`.
   * Reuses an existing worktree for the branch. Refuses to touch a path that
   * exists but is not the expected worktree when it contains files.
   */
  async ensureWorktree(input: {
    repoDir: string;
    branch: string;
    baseBranch: string;
    worktreePath: string;
  }): Promise<{ path: string; created: boolean }> {
    const { repoDir, branch, baseBranch } = input;
    const worktreePath = resolve(input.worktreePath);

    const list = await this.git(['worktree', 'list', '--porcelain'], repoDir);
    const entries = parseWorktreeList(list.stdoutTail);
    const byBranch = entries.find((e) => e.branch === `refs/heads/${branch}`);
    const byPath = entries.find((e) => resolve(e.path) === worktreePath);

    if (byBranch) return { path: byBranch.path, created: false };
    if (byPath) {
      // Path is a registered worktree for a different branch — never reuse.
      throw new WorkspaceError(
        `worktree path ${worktreePath} is registered to ${byPath.branch ?? 'unknown'}; refusing`,
      );
    }
    if (existsSync(worktreePath) && readdirSync(worktreePath).length > 0) {
      throw new WorkspaceError(
        `worktree path ${worktreePath} exists with content but is not a registered worktree; refusing to delete`,
      );
    }

    const branchExists = await this.exec({
      argv: ['git', 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      cwd: repoDir,
      timeoutMs: 15_000,
    });

    mkdirSync(dirname(worktreePath), { recursive: true });
    if (branchExists.exitCode === 0) {
      await this.git(['worktree', 'add', worktreePath, branch], repoDir);
    } else {
      await this.git(['worktree', 'add', '-b', branch, worktreePath, baseBranch], repoDir);
    }
    return { path: worktreePath, created: true };
  }

  async isDirty(worktreePath: string): Promise<boolean> {
    const res = await this.git(['status', '--porcelain'], worktreePath);
    return res.stdoutTail.trim().length > 0;
  }

  /** HEAD sha — a moved ref is tampering `status --porcelain` cannot see. */
  async head(worktreePath: string): Promise<string> {
    const res = await this.git(['rev-parse', 'HEAD'], worktreePath);
    return res.stdoutTail.trim();
  }

  /** Host-side fallback: commit leftover agent changes verbatim. */
  async commitAll(worktreePath: string, message: string): Promise<boolean> {
    if (!(await this.isDirty(worktreePath))) return false;
    await this.git(['add', '-A'], worktreePath);
    await this.git(['commit', '-m', message], worktreePath);
    return true;
  }

  async aheadCount(worktreePath: string, baseBranch: string): Promise<number> {
    const res = await this.git(['rev-list', '--count', `${baseBranch}..HEAD`], worktreePath);
    const n = Number(res.stdoutTail.trim());
    return Number.isFinite(n) ? n : 0;
  }

  async diffVsBase(worktreePath: string, baseBranch: string, maxChars = 200_000): Promise<string> {
    // Three-dot (merge-base) diff matches GitHub PR semantics; fall back to a
    // two-dot tip diff when base history was rewritten and no merge base exists.
    const mb = await this.exec({
      argv: ['git', 'merge-base', baseBranch, 'HEAD'],
      cwd: worktreePath,
      timeoutMs: 15_000,
    });
    const range = mb.exitCode === 0 ? `${baseBranch}...HEAD` : `${baseBranch}..HEAD`;
    const stat = await this.git(['diff', '--stat', range], worktreePath);
    const diff = await this.git(['diff', '--find-renames', range], worktreePath, 120_000);
    let out = `## STAT\n${stat.stdoutTail}\n## DIFF\n${diff.stdoutTail}`;
    if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n...[truncated ${out.length - maxChars} chars]`;
    return out;
  }

  async push(worktreePath: string, branch: string): Promise<void> {
    await this.git(['push', '-u', 'origin', branch], worktreePath, 180_000);
  }

  /** Remove a worktree after its PR merged. Forced: merged work is upstream. */
  async removeWorktree(repoDir: string, worktreePath: string): Promise<void> {
    await this.git(['worktree', 'remove', '--force', worktreePath], repoDir);
  }

  /** Delete the agent branch ref left in the main repo after worktree removal. */
  async deleteLocalBranch(repoDir: string, branch: string): Promise<void> {
    await this.git(['branch', '-D', branch], repoDir);
  }

  /** Delete the merged remote agent branch. */
  async deleteRemoteBranch(repoDir: string, branch: string): Promise<void> {
    await this.git(['push', 'origin', '--delete', branch], repoDir, 120_000);
  }

  /** Parse `git worktree list --porcelain` output. */
  // exported for tests
  static parseWorktreeList = parseWorktreeList;
}

export function parseWorktreeList(text: string): { path: string; head: string; branch?: string }[] {
  const out: { path: string; head: string; branch?: string }[] = [];
  let cur: { path: string; head: string; branch?: string } | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice('worktree '.length).trim(), head: '' };
    } else if (cur && line.startsWith('HEAD ')) {
      cur.head = line.slice(5).trim();
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice(7).trim();
    }
  }
  if (cur) out.push(cur);
  return out;
}
