import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ExternalLink, FileText, RotateCw, Square } from 'lucide-react';
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

  const act = async (action: 'stop' | 'retry') => {
    const verb =
      action === 'stop'
        ? 'Stop this task? The scheduler aborts the active run within one poll cycle.'
        : 'Retry this task? The CURRENT issue text becomes the approved content.';
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
        <header className="flex shrink-0 items-start gap-3 border-b border-edge px-5 py-4">
          <button
            onClick={onClose}
            className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            title="Close"
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
                    className="font-mono text-xs text-sky-300/90 hover:text-sky-300 hover:underline"
                  >
                    {t.repo}#{t.issue_number}
                  </a>
                  <span className={`flex items-center gap-1.5 text-xs ${phaseTextClass(t.status)}`}>
                    <StatusIcon phase={t.status} />
                    {phaseLabel(t.status)}
                  </span>
                </div>
                <h1 className="mt-1 text-[15px] font-semibold leading-snug text-zinc-100">
                  {t.issue_title || '(untitled)'}
                </h1>
              </>
            ) : (
              <div className="h-10 animate-pulse rounded bg-zinc-800/50" />
            )}
          </div>
          {t && (
            <div className="flex shrink-0 items-center gap-2 pt-0.5">
              {showStop && (
                <button
                  onClick={() => act('stop')}
                  className="flex items-center gap-1.5 rounded-md border border-rose-500/30 px-3 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/10"
                >
                  <Square className="size-3" />
                  Stop
                </button>
              )}
              {detail!.retryable && (
                <button
                  onClick={() => act('retry')}
                  className="flex items-center gap-1.5 rounded-md border border-sky-500/30 px-3 py-1.5 text-xs font-medium text-sky-300 hover:bg-sky-500/10"
                >
                  <RotateCw className="size-3" />
                  Retry
                </button>
              )}
              <a
                href={t.issue_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex size-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                title="Open issue on GitHub"
              >
                <ExternalLink className="size-3.5" />
              </a>
            </div>
          )}
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
              {error}
            </div>
          )}
          {t && <MetaGrid detail={detail!} />}
          {detail && (
            <div className="mt-5 space-y-4">
              {detail.runs.length === 0 && (
                <p className="py-8 text-center text-sm text-zinc-600">No runs recorded.</p>
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
    ['approved hash', t.approved_hash?.slice(0, 12) ?? '—'],
    ['fix rounds', String(t.fix_rounds)],
    ['created', fmtTime(t.created_at)],
    ['updated', fmtTime(t.updated_at)],
  ];
  if (t.branch) items.push(['branch', t.branch]);
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 rounded-lg border border-edge bg-card px-4 py-3.5 text-xs">
      {items.map(([k, v]) => (
        <div key={k} className="flex min-w-0 flex-col gap-0.5">
          <span className="text-zinc-600">{k}</span>
          <span className="truncate font-mono text-zinc-300" title={v}>
            {v}
          </span>
        </div>
      ))}
      {t.pr_url && (
        <a
          href={t.pr_url}
          target="_blank"
          rel="noopener noreferrer"
          className="col-span-2 flex items-center gap-1.5 font-mono text-sky-300/90 hover:text-sky-300 hover:underline"
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
    <section className="overflow-hidden rounded-lg border border-edge bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-edge px-4 py-2.5">
        <span className="font-mono text-xs text-zinc-300">
          attempt #{run.attempt}
          <span className="ml-2 text-zinc-600">{run.run_id.slice(0, 8)}</span>
        </span>
        <span className={`flex items-center gap-1.5 text-[11px] ${phaseTextClass(run.phase)}`}>
          <StatusIcon phase={run.phase} size={12} />
          {phaseLabel(run.phase)}
        </span>
        <span className="ml-auto font-mono text-[11px] text-zinc-500">
          {fmtTime(run.started_at)} → {fmtTime(run.ended_at)}
          {active && (
            <span className="ml-2 text-emerald-300/80">up {fmtDur(run.started_at)}</span>
          )}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2 font-mono text-[11px] text-zinc-500">
        <span>fix_count={run.fix_count}</span>
        <span>resume_count={run.resume_count}</span>
        {run.cancel_requested === 1 && <span className="text-amber-300">CANCEL REQUESTED</span>}
        {run.branch && <span>branch: {run.branch}</span>}
        {run.pr_url && (
          <a
            href={run.pr_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sky-300/90 hover:text-sky-300 hover:underline"
          >
            PR
          </a>
        )}
        {run.reason && <span className="w-full text-rose-300/80">reason: {run.reason}</span>}
        <button
          onClick={() => onOpenArtifact(`run-${run.run_id}.jsonl`)}
          className="flex items-center gap-1 text-sky-300/90 hover:text-sky-300 hover:underline"
        >
          <FileText className="size-3" />
          run log
        </button>
      </div>

      <Timeline run={run} />
      {run.checks.length > 0 && <ChecksTable run={run} onOpenArtifact={onOpenArtifact} />}
    </section>
  );
}

function Timeline({ run }: { run: RunDetail }) {
  return (
    <div className="border-t border-edge px-4 py-3">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-600">
        timeline
      </div>
      <ol className="relative ml-1 space-y-2 border-l border-edge-strong pl-4">
        {run.events.map((e) => (
          <li key={e.id} className="relative">
            <span className="absolute -left-[21px] top-[7px] size-1.5 rounded-full bg-zinc-600" />
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="font-mono text-[11px] text-zinc-500">{fmtTime(e.at)}</span>
              <span className="font-mono text-[11.5px] text-zinc-300">
                {e.from_phase ? `${e.from_phase} → ` : ''}
                {e.to_phase}
              </span>
            </div>
            {e.detail_json && (
              <div className="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px] text-zinc-600">
                {e.detail_json}
              </div>
            )}
          </li>
        ))}
        {run.events.length === 0 && <li className="text-xs text-zinc-600">no events</li>}
      </ol>
    </div>
  );
}

function ChecksTable(props: { run: RunDetail; onOpenArtifact: (path: string) => void }) {
  const { run, onOpenArtifact } = props;
  const verdictTone = (v: string) =>
    v === 'PASS' ? 'text-emerald-300' : v === 'BLOCK' || v === 'FAIL' ? 'text-rose-300' : 'text-zinc-300';
  return (
    <div className="border-t border-edge px-4 py-3">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-600">
        checks
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-zinc-600">
            <th className="pb-1.5 pr-3 font-normal">kind</th>
            <th className="pb-1.5 pr-3 font-normal">command</th>
            <th className="pb-1.5 pr-3 font-normal">verdict</th>
            <th className="pb-1.5 pr-3 font-normal">exit</th>
            <th className="pb-1.5 font-normal">artifact</th>
          </tr>
        </thead>
        <tbody>
          {run.checks.map((c) => (
            <tr key={c.id} className="border-t border-edge/60">
              <td className="py-1.5 pr-3">{c.kind}</td>
              <td className="py-1.5 pr-3 font-mono text-zinc-400">{c.command}</td>
              <td className={`py-1.5 pr-3 font-medium ${verdictTone(c.verdict)}`}>{c.verdict}</td>
              <td className="py-1.5 pr-3 font-mono text-zinc-500">{c.exit_code ?? 'n/a'}</td>
              <td className="py-1.5">
                {c.artifact_path ? (
                  <button
                    onClick={() => onOpenArtifact(c.artifact_path!)}
                    className="flex items-center gap-1 font-mono text-sky-300/90 hover:text-sky-300 hover:underline"
                  >
                    <FileText className="size-3" />
                    {(c.artifact_path.split(/[\\/]/).pop() ?? c.artifact_path)}
                  </button>
                ) : (
                  <span className="text-zinc-600">—</span>
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
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-edge-strong bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: 'drawer-in .15s ease-out' }}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-edge px-5 py-3">
          <span className="min-w-0 flex-1 truncate font-mono text-sm text-zinc-200">{name}</span>
          {data?.truncated && <span className="text-xs text-amber-300">(truncated)</span>}
          <button
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            ✕
          </button>
        </header>
        <div className="overflow-auto px-5 py-4">
          {error && <div className="text-sm text-rose-300">{error}</div>}
          {!error && !data && <div className="py-8 text-center text-sm text-zinc-600">loading…</div>}
          {data?.kind === 'text' && (
            <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-zinc-300">
              {data.content}
            </pre>
          )}
          {data?.kind === 'jsonl' && (
            <div className="space-y-1 font-mono text-xs">
              {data.lines?.map((l, i) => {
                const { at, type, ...rest } = l as { at?: string; type?: string };
                return (
                  <div key={i} className="flex gap-3">
                    <span className="shrink-0 text-zinc-600">{String(at ?? '')}</span>
                    <span className="shrink-0 font-semibold text-zinc-300">{String(type ?? '')}</span>
                    <span className="min-w-0 break-all text-zinc-500">
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
