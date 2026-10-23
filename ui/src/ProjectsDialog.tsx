import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, FolderGit2, GitBranch, Plus, TriangleAlert } from 'lucide-react';
import { addProject, fetchProjects, type NewProjectInput, type ProjectInfo, type ProjectsPayload } from './api';
import type { Toast } from './App';

/** Split one command line into argv; double/single quotes group a token. */
function splitArgv(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

const REPO_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export default function ProjectsDialog(props: {
  onClose: () => void;
  onChanged: () => void;
  onToast: (t: Toast) => void;
}) {
  const { onClose, onChanged, onToast } = props;
  const [data, setData] = useState<ProjectsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await fetchProjects());
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [refresh, onClose]);

  return (
    <div className="fixed inset-0 z-20" style={{ animation: 'fade-in .15s ease-out' }}>
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside
        className="absolute inset-x-0 bottom-0 top-[env(safe-area-inset-top)] flex h-[calc(100%-env(safe-area-inset-top))] w-full flex-col rounded-t-xl border-t border-edge bg-panel shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:h-full md:w-[560px] md:max-w-[94vw] md:rounded-none md:border-l md:border-t-0"
        style={{ animation: 'drawer-in .18s ease-out' }}
      >
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-edge px-3 py-2.5 sm:px-4 sm:py-3">
          <button
            onClick={onClose}
            className="flex size-10 shrink-0 touch-manipulation items-center justify-center rounded-md text-fg-muted hover:bg-elevated hover:text-fg"
            title="关闭"
          >
            <ChevronLeft className="size-4" />
          </button>
          <div className="flex items-center gap-2 text-[13px] font-semibold text-fg">
            <FolderGit2 className="size-4 text-fg-muted" />
            项目
          </div>
          {data?.config_path && (
            <span className="w-full truncate pl-12 font-mono text-[10px] text-fg-dim sm:ml-auto sm:w-auto sm:pl-0 sm:text-right sm:text-[10.5px]" title={data.config_path}>
              {data.config_path}
            </span>
          )}
        </header>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-4">
          {loadError && <div className="text-xs text-danger">加载失败：{loadError}</div>}
          {data && (
            <>
              <section className="space-y-2">
                {data.projects.map((p) => (
                  <ProjectCard key={p.repo} project={p} />
                ))}
                {data.projects.length === 0 && (
                  <div className="rounded-md border border-dashed border-edge px-3 py-6 text-center text-[11px] text-fg-dim">
                    还没有配置项目
                  </div>
                )}
              </section>
              <AddProjectForm
                editable={data.editable}
                onAdded={async (msg, warnings) => {
                  onToast({ msg });
                  if (warnings.length > 0) {
                    // Warnings matter (labels not created, origin unverifiable)
                    // — surface them for a beat instead of hiding in a toast.
                    onToast({ msg: `注意：${warnings.join('；')}`, err: true });
                  }
                  await refresh();
                  onChanged();
                }}
                onError={(msg) => onToast({ msg, err: true })}
              />
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function ProjectCard({ project: p }: { project: ProjectInfo }) {
  return (
    <div className="rounded-md border border-edge bg-card p-3">
      <div className="flex items-center gap-2">
        <a
          href={`https://github.com/${p.repo}`}
          target="_blank"
          rel="noopener noreferrer"
          title={`https://github.com/${p.repo}`}
          className="font-mono text-[12.5px] font-medium text-info hover:underline"
        >
          {p.repo}
        </a>
        <span className="ml-auto flex items-center gap-1.5">
          <Badge>{p.review_mode === 'auto' ? '自动评审' : '人工评审'}</Badge>
          <Badge>{p.pr_review === 'auto' ? '外部PR自动评审' : '外部PR需召唤'}</Badge>
          {p.issue_intake === 'all' && <Badge>自动接手 Issue</Badge>}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-fg-muted">
        <GitBranch className="size-3 shrink-0" />
        <span className="font-mono">{p.git_remote}/{p.base_branch}</span>
        <span className="text-fg-dim">·</span>
        <span className="truncate font-mono text-fg-dim" title={p.local_repo}>
          {p.local_repo}
        </span>
      </div>
      {p.checks.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {p.checks.map((c, i) => (
            <div key={i} className="truncate font-mono text-[10.5px] text-fg-dim" title={c.argv.join(' ')}>
              $ {c.argv.join(' ')}
              {c.timeout_seconds ? ` (${c.timeout_seconds}s)` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-edge px-1.5 py-px text-[10px] text-fg-dim">{children}</span>
  );
}

function AddProjectForm(props: {
  editable: boolean;
  onAdded: (message: string, warnings: string[]) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const { editable, onAdded, onError } = props;
  const [repo, setRepo] = useState('');
  const [localRepo, setLocalRepo] = useState('');
  const [baseBranch, setBaseBranch] = useState('main');
  const [gitRemote, setGitRemote] = useState('origin');
  const [readyLabel, setReadyLabel] = useState('agent-ready');
  const [branchPrefix, setBranchPrefix] = useState('agent/issue-');
  const [reviewMode, setReviewMode] = useState<'auto' | 'manual'>('auto');
  const [prReview, setPrReview] = useState<'auto' | 'manual'>('auto');
  const [issueTriage, setIssueTriage] = useState(false);
  const [checkLines, setCheckLines] = useState('');
  const [checkTimeout, setCheckTimeout] = useState('300');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async () => {
    const repoT = repo.trim();
    if (!REPO_NAME.test(repoT)) { setFormError('GitHub 仓库必须是 owner/name 形式'); return; }
    if (!localRepo.trim()) { setFormError('本地仓库路径必填'); return; }
    const checks = checkLines
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const timeout = Number(checkTimeout);
        return {
          argv: splitArgv(l),
          ...(Number.isFinite(timeout) && timeout > 0 ? { timeout_seconds: Math.floor(timeout) } : {}),
        };
      });
    for (const c of checks) {
      if (c.argv.length === 0) { setFormError('检查命令不能为空行'); return; }
    }
    const input: NewProjectInput = {
      repo: repoT,
      local_repo: localRepo.trim(),
      base_branch: baseBranch.trim() || 'main',
      git_remote: gitRemote.trim() || 'origin',
      ready_label: readyLabel.trim() || 'agent-ready',
      branch_prefix: branchPrefix.trim() || 'agent/issue-',
      review_mode: reviewMode,
      pr_review: prReview,
      issue_intake: issueTriage ? 'all' : 'labeled',
      ...(checks.length > 0 ? { checks } : {}),
    };
    setBusy(true);
    setFormError(null);
    try {
      const r = await addProject(input);
      await onAdded(r.message, r.warnings);
      setRepo('');
      setLocalRepo('');
      setCheckLines('');
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-md border border-edge bg-card p-3.5">
      <div className="flex items-center gap-2 text-[12px] font-medium text-fg">
        <Plus className="size-3.5 text-fg-muted" />
        添加 GitHub 项目
      </div>
      {!editable ? (
        <div className="mt-2 flex items-start gap-1.5 text-[11px] text-warn">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" />
          当前实例未记录配置文件路径，无法在此添加——请手动编辑 yaml 后重启服务。
        </div>
      ) : (
        <div className="mt-3 space-y-2.5">
          <Field label="GitHub 仓库 *" hint="owner/name，须能被 gh 访问">
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="your-org/your-repo"
              className={inputCls}
            />
          </Field>
          <Field label="本地仓库路径 *" hint="已 clone 到本机的仓库目录（含 .git）">
            <input
              value={localRepo}
              onChange={(e) => setLocalRepo(e.target.value)}
              placeholder="C:/path/to/clone"
              className={inputCls}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="base 分支">
              <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} className={inputCls} />
            </Field>
            <Field label="git 远程名" hint="调度器 push/fetch 的 remote；origin 指向公司镜像时可填 github">
              <input value={gitRemote} onChange={(e) => setGitRemote(e.target.value)} className={inputCls} />
            </Field>
            <Field label="就绪标签" hint="打上此标签的 issue 会被领取">
              <input value={readyLabel} onChange={(e) => setReadyLabel(e.target.value)} className={inputCls} />
            </Field>
            <Field label="分支前缀">
              <input value={branchPrefix} onChange={(e) => setBranchPrefix(e.target.value)} className={inputCls} />
            </Field>
            <Field label="检查超时（秒）">
              <input
                value={checkTimeout}
                onChange={(e) => setCheckTimeout(e.target.value)}
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
            <Field label="评审模式" hint="auto：每个 PR head 派独立评审，低危 PASS 自动合并">
              <select value={reviewMode} onChange={(e) => setReviewMode(e.target.value as 'auto' | 'manual')} className={inputCls}>
                <option value="auto">auto — 自动评审+低危自动合并</option>
                <option value="manual">manual — PR 停人工评审</option>
              </select>
            </Field>
            <Field label="外部 PR 评审" hint="无 issue 的 PR 是否自动评审">
              <select value={prReview} onChange={(e) => setPrReview(e.target.value as 'auto' | 'manual')} className={inputCls}>
                <option value="auto">auto — 自动评审</option>
                <option value="manual">manual — 仅 agent-review 召唤</option>
              </select>
            </Field>
            <Field label="自动接手 Issue" hint="新 Issue 默认排队，同一个 Agent 判断并处理；人工锁定和暂缓项不会启动">
              <div className="flex h-[31px] items-center gap-2 text-[11.5px] text-fg-muted">
                <input type="checkbox" checked={issueTriage} onChange={e => setIssueTriage(e.target.checked)} className="accent-brand" />
                开启全量扫描
              </div>
            </Field>

          </div>
          <Field label="检查命令" hint="可选，每行一条；空格分词，含空格参数用引号包住">
            <textarea
              value={checkLines}
              onChange={(e) => setCheckLines(e.target.value)}
              rows={2}
              placeholder={'npm run check\nnode --test'}
              className={`${inputCls} resize-y font-mono`}
            />
          </Field>
          {formError && <div className="text-[11px] text-danger">{formError}</div>}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={submit}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-md border border-brand/30 px-3 py-1.5 text-[11.5px] font-medium text-brand transition-colors hover:bg-brand/10 disabled:opacity-50"
            >
              <Plus className="size-3" />
              {busy ? '校验并写入中…' : '添加项目'}
            </button>
            <span className="text-[10.5px] text-fg-dim">写入配置文件后立即生效，无需重启</span>
          </div>
        </div>
      )}
    </section>
  );
}

const inputCls =
  'w-full rounded-md border border-edge bg-sunken px-2.5 py-1.5 text-[11.5px] text-fg outline-none transition-colors placeholder:text-fg-dim focus:border-edge-strong';

function Field(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-fg-muted">{props.label}</span>
      {props.children}
      {props.hint && <span className="mt-1 block text-[10px] leading-snug text-fg-dim">{props.hint}</span>}
    </label>
  );
}
