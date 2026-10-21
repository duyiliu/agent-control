import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronLeft, ExternalLink, FileText, RotateCw, Square } from 'lucide-react';
import {
  fetchArtifact,
  fetchTask,
  postAction,
  type Artifact,
  type RunDetail,
  type TaskDetail,
} from './api';
import { fmtDur, fmtTime, isActivePhase, phaseLabel, phaseTextClass } from './groups';
import StatusIcon from './StatusIcon';
import LiveLog from './LiveLog';
import type { Toast } from './App';

export default function DetailDrawer(props: {
  taskId: number;
  onClose: () => void;
  onChanged: () => void;
  onToast: (t: Toast) => void;
}) {
  const { taskId, onClose, onChanged, onToast } = props;
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<{ path: string; data: Artifact | null; error: string | null } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDetail(await fetchTask(taskId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [taskId]);

  useEffect(() => {
    setDetail(null);
    refresh();
    const id = setInterval(() => {
      if (!document.hidden) refresh();
    }, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (artifact) setArtifact(null);
      else onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [artifact, onClose]);

  const act = async (action: 'stop' | 'retry' | 'approve-merge') => {
    const verb =
      action === 'stop'
        ? '停止这个任务？调度器会在一个轮询周期内中止当前运行。'
        : action === 'retry'
          ? '重试这个任务？当前 issue 内容将成为新的已批准内容。'
          : '批准合并？调度器会校验 PR head 仍是被审版本，然后钉 sha 自动合并。';
    if (!confirm(verb)) return;
    try {
      onToast({ msg: await postAction(taskId, action) });
      await Promise.all([refresh(), onChanged()]);
    } catch (e) {
      onToast({ msg: (e as Error).message, err: true });
    }
  };

  const openArtifact = async (path: string) => {
    setArtifact({ path, data: null, error: null });
    try {
      setArtifact({ path, data: await fetchArtifact(path), error: null });
    } catch (e) {
      setArtifact({ path, data: null, error: (e as Error).message });
    }
  };

  const t = detail?.task;
  const showStop = detail?.has_active_run || (t ? isActivePhase(t.status) : false);

  return (
    <div className="fixed inset-0 z-20" style={{ animation: 'fade-in .15s ease-out' }}>
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside
        className="absolute right-0 top-0 flex h-full w-[560px] max-w-[94vw] flex-col border-l border-edge bg-panel shadow-2xl"
        style={{ animation: 'drawer-in .18s ease-out' }}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-edge px-4 py-3.5">
          <button
            onClick={onClose}
            className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-elevated hover:text-fg"
            title="关闭"
          >
            <ChevronLeft className="size-4" />
          </button>
          <div className="min-w-0 flex-1">
            {t ? (
              <>
                <div className="flex items-center gap-2">
                  <a
                    href={t.issue_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[11px] text-info hover:underline"
                  >
                    {t.repo}#{t.issue_number}
                  </a>
                  <span className={`flex items-center gap-1.5 text-[11px] ${phaseTextClass(t.status)}`}>
                    <StatusIcon phase={t.status} />
                    {phaseLabel(t.status)}
                  </span>
                </div>
                <h1 className="mt-1 text-[14px] font-semibold leading-snug text-fg">
                  {t.issue_title || '(无标题)'}
                </h1>
              </>
            ) : (
              <div className="h-10 animate-pulse rounded bg-elevated" />
            )}
          </div>
          {t && (
            <div className="flex shrink-0 items-center gap-2 pt-0.5">
              {t.status === 'AWAITING_HUMAN' && t.pr_url && (
                <button
                  onClick={() => act('approve-merge')}
                  className="flex items-center gap-1.5 rounded-md border border-ok/30 px-2.5 py-1.5 text-[11px] font-medium text-ok hover:bg-ok/10"
                >
                  <Check className="size-3" />
                  批准合并
                </button>
              )}
              {showStop && (
                <button
                  onClick={() => act('stop')}
                  className="flex items-center gap-1.5 rounded-md border border-danger/30 px-2.5 py-1.5 text-[11px] font-medium text-danger hover:bg-danger/10"
                >
                  <Square className="size-3" />
                  停止
                </button>
              )}
              {detail!.retryable && (
                <button
                  onClick={() => act('retry')}
                  className="flex items-center gap-1.5 rounded-md border border-info/30 px-2.5 py-1.5 text-[11px] font-medium text-info hover:bg-info/10"
                >
                  <RotateCw className="size-3" />
                  重试
                </button>
              )}
              <a
                href={t.issue_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-elevated hover:text-fg"
                title="在 GitHub 打开 issue"
              >
                <ExternalLink className="size-3.5" />
              </a>
            </div>
          )}
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-3.5">
          {error && (
            <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2.5 text-xs text-danger">
              {error}
            </div>
          )}
          {t && <MetaGrid detail={detail!} />}
          {detail && (
            <div className="mt-4 space-y-3">
              {detail.runs.length === 0 && (
                <p className="py-8 text-center text-xs text-fg-dim">暂无运行记录。</p>
              )}
              {[...detail.runs].reverse().map((r) => (
                <RunSection key={r.run_id} run={r} onOpenArtifact={openArtifact} />
              ))}
            </div>
          )}
        </div>
      </aside>

      {artifact && (
        <ArtifactModal
          path={artifact.path}
          data={artifact.data}
          error={artifact.error}
          onClose={() => setArtifact(null)}
        />
      )}
    </div>
  );
}

function MetaGrid({ detail }: { detail: TaskDetail }) {
  const t = detail.task;
  const items: [string, string][] = [
    ['批准哈希', t.approved_hash?.slice(0, 12) ?? '—'],
    ['修复轮次', String(t.fix_rounds)],
    ['创建时间', fmtTime(t.created_at)],
    ['更新时间', fmtTime(t.updated_at)],
  ];
  if (t.branch) items.push(['分支', t.branch]);
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 rounded-md border border-edge bg-card px-3.5 py-3 text-[11px]">
      {items.map(([k, v]) => (
        <div key={k} className="flex min-w-0 flex-col gap-0.5">
          <span className="text-fg-dim">{k}</span>
          <span className="truncate font-mono text-fg" title={v}>
            {v}
          </span>
        </div>
      ))}
      {t.pr_url && (
        <a
          href={t.pr_url}
          target="_blank"
          rel="noopener noreferrer"
          className="col-span-2 flex items-center gap-1.5 font-mono text-info hover:underline"
        >
          <ExternalLink className="size-3" />
          {t.pr_url}
        </a>
      )}
    </div>
  );
}

function RunSection(props: { run: RunDetail; onOpenArtifact: (path: string) => void }) {
  const { run, onOpenArtifact } = props;
  const active = isActivePhase(run.phase);
  return (
    <section className="overflow-hidden rounded-md border border-edge bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-edge px-3.5 py-2">
        <span className="font-mono text-[11px] text-fg">
          第 {run.attempt} 次
          <span className="ml-2 text-fg-dim">{run.run_id.slice(0, 8)}</span>
        </span>
        <span className={`flex items-center gap-1.5 text-[11px] ${phaseTextClass(run.phase)}`}>
          <StatusIcon phase={run.phase} size={12} />
          {phaseLabel(run.phase)}
        </span>
        <span className="ml-auto font-mono text-[10.5px] text-fg-muted">
          {fmtTime(run.started_at)} → {fmtTime(run.ended_at)}
          {active && (
            <span className="ml-2 text-ok">已运行 {fmtDur(run.started_at)}</span>
          )}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-3.5 py-2 font-mono text-[10.5px] text-fg-muted">
        <span>fix_count={run.fix_count}</span>
        <span>resume_count={run.resume_count}</span>
        {run.cancel_requested === 1 && <span className="text-warn">已请求取消</span>}
        {run.branch && <span>分支: {run.branch}</span>}
        {run.pr_url && (
          <a
            href={run.pr_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-info hover:underline"
          >
            PR
          </a>
        )}
        {run.reason && <span className="w-full text-danger">原因: {run.reason}</span>}
        <button
          onClick={() => onOpenArtifact(`run-${run.run_id}.jsonl`)}
          className="flex items-center gap-1 text-info hover:underline"
        >
          <FileText className="size-3" />
          运行日志
        </button>
      </div>

      <LiveLog runId={run.run_id} active={active} onOpenArtifact={onOpenArtifact} />
      <Timeline run={run} />
      {run.checks.length > 0 && <ChecksTable run={run} onOpenArtifact={onOpenArtifact} />}
    </section>
  );
}

function Timeline({ run }: { run: RunDetail }) {
  return (
    <div className="border-t border-edge px-3.5 py-3">
      <div className="mb-2 text-[11px] font-medium text-fg-dim">
        时间线
      </div>
      <ol className="relative ml-1 space-y-2 border-l border-edge pl-4">
        {run.events.map((e) => (
          <li key={e.id} className="relative">
            <span className="absolute -left-[21px] top-[7px] size-1.5 rounded-full bg-fg-dim" />
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="font-mono text-[10.5px] text-fg-dim">{fmtTime(e.at)}</span>
              <span className="font-mono text-[11px] text-fg">
                {e.from_phase ? `${e.from_phase} → ` : ''}
                {e.to_phase}
              </span>
            </div>
            {e.detail_json && (
              <div
                className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-all font-mono text-[10.5px] text-fg-dim"
                title={e.detail_json}
              >
                {e.detail_json}
              </div>
            )}
          </li>
        ))}
        {run.events.length === 0 && <li className="text-[11px] text-fg-dim">暂无事件</li>}
      </ol>
    </div>
  );
}

function ChecksTable(props: { run: RunDetail; onOpenArtifact: (path: string) => void }) {
  const { run, onOpenArtifact } = props;
  const verdictTone = (v: string) =>
    v === 'PASS' ? 'text-ok'
      : v === 'BLOCK' || v === 'FAIL' || v === 'ERROR' ? 'text-danger'
        : v === 'HUMAN_REVIEW_REQUIRED' ? 'text-warn'
          : 'text-fg';
  return (
    <div className="border-t border-edge px-3.5 py-3">
      <div className="mb-2 text-[11px] font-medium text-fg-dim">
        检查项
      </div>
      <table className="w-full table-fixed text-[11px]">
        <thead>
          <tr className="text-left text-fg-dim">
            <th className="w-10 pb-1.5 pr-2 font-normal">类型</th>
            <th className="pb-1.5 pr-2 font-normal">命令</th>
            <th className="w-12 pb-1.5 pr-2 font-normal">结论</th>
            <th className="w-14 whitespace-nowrap pb-1.5 pr-2 font-normal">退出码</th>
            <th className="w-28 pb-1.5 font-normal">产物</th>
          </tr>
        </thead>
        <tbody>
          {run.checks.map((c) => (
            <tr key={c.id} className="border-t border-edge/70">
              <td className="py-1.5 pr-2">{c.kind}</td>
              <td className="break-all py-1.5 pr-2 font-mono text-fg-muted">{c.command}</td>
              <td className={`py-1.5 pr-2 font-medium ${verdictTone(c.verdict)}`}>{c.verdict}</td>
              <td className="py-1.5 pr-2 font-mono text-fg-muted">{c.exit_code ?? 'n/a'}</td>
              <td className="py-1.5">
                {c.artifact_path ? (
                  <button
                    onClick={() => onOpenArtifact(c.artifact_path!)}
                    className="flex min-w-0 items-center gap-1 font-mono text-info hover:underline"
                    title={c.artifact_path}
                  >
                    <FileText className="size-3 shrink-0" />
                    <span className="truncate">{(c.artifact_path.split(/[\\/]/).pop() ?? c.artifact_path)}</span>
                  </button>
                ) : (
                  <span className="text-fg-dim">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ArtifactModal(props: {
  path: string;
  data: Artifact | null;
  error: string | null;
  onClose: () => void;
}) {
  const { path, data, error, onClose } = props;
  const name = path.split(/[\\/]/).pop() ?? path;
  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-8"
      style={{ animation: 'fade-in .15s ease-out' }}
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-edge-strong bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: 'drawer-in .15s ease-out' }}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-edge px-4 py-2.5">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{name}</span>
          {data?.truncated && <span className="text-[11px] text-warn">（已截断）</span>}
          <button
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-elevated hover:text-fg"
          >
            ✕
          </button>
        </header>
        <div className="overflow-auto px-4 py-3">
          {error && <div className="text-xs text-danger">{error}</div>}
          {!error && !data && <div className="py-8 text-center text-xs text-fg-dim">加载中…</div>}
          {data?.kind === 'text' && (
            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-fg">
              {data.content}
            </pre>
          )}
          {data?.kind === 'jsonl' && (
            <div className="space-y-1 font-mono text-[11px]">
              {data.lines?.map((l, i) => {
                const { at, type, ...rest } = l as { at?: string; type?: string };
                return (
                  <div key={i} className="flex gap-3">
                    <span className="shrink-0 text-fg-dim">{String(at ?? '')}</span>
                    <span className="shrink-0 font-semibold text-fg">{String(type ?? '')}</span>
                    <span className="min-w-0 break-all text-fg-muted">
                      {Object.keys(rest).length > 0 ? JSON.stringify(rest) : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
