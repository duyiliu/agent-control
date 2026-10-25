import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ExternalLink, FileText, RotateCw, Square } from 'lucide-react';
import {
  fetchArtifact,
  fetchTask,
  postAction,
  postWorkflowState,
  resolveDecision,
  type Artifact,
  type RunDetail,
  type TaskDetail,
  type TaskSummary,
  type WorkflowTarget,
} from './api';
import { fmtDur, fmtTime, isActivePhase, phaseLabel, phaseTextClass, WORKFLOW_TEXT, workflowTextClass } from './groups';
import StatusIcon, { WorkflowIcon } from './StatusIcon';
import GithubLink from './GithubLink';
import LiveLog from './LiveLog';
import IntakeActions from './IntakeActions';
import TaskAttention from './TaskAttention';
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
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [decisionAnswers, setDecisionAnswers] = useState<Record<string, { option: string; authorization: string }>>({});
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const actionInFlight = useRef(false);
  const currentTaskId = useRef(taskId);
  currentTaskId.current = taskId;
  const [artifact, setArtifact] = useState<{ path: string; data: Artifact | null; error: string | null } | null>(null);

  useEffect(() => { setDecisionAnswers({}); }, [detail?.task.attention?.head_sha, detail?.task.attention?.decision_version]);

  const refreshSequence = useRef(0);
  const refresh = useCallback(async () => {
    if (currentTaskId.current !== taskId) return;
    const sequence = ++refreshSequence.current;
    try {
      const next = await fetchTask(taskId);
      if (sequence !== refreshSequence.current || currentTaskId.current !== taskId) return;
      setDetail(current => current?.task.id === next.task.id && (current.task.intake?.version ?? 0) > (next.task.intake?.version ?? 0) ? { ...next, task: { ...next.task, intake: current.task.intake } } : next);
      setError(null);
    } catch (e) {
      if (currentTaskId.current === taskId && sequence === refreshSequence.current) setError((e as Error).message);
    }
  }, [taskId]);

  useEffect(() => {
    setDetail(null);
    setDecisionAnswers({});
    setActionMessage(null);
    setArtifact(null);
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

  const act = async (action: 'stop' | 'retry' | 'rereview' | 'approve-merge') => {
    if (actionInFlight.current || !detail) return;
    const verb =
      action === 'stop'
        ? '停止这个任务？调度器会在一个轮询周期内中止当前运行。'
        : action === 'retry'
          ? '重试这个任务？当前 issue 内容将成为新的已批准内容。'
          : action === 'rereview'
            ? '重新评审当前 PR？现有代码与检查证据会保留，旧评审结论和合并批准将撤销。'
            : '批准合并？调度器会校验 PR head 仍是被审版本，然后钉 sha 自动合并。';
    if (!confirm(verb)) return;
    actionInFlight.current = true;
    setBusyAction(action);
    setActionMessage(null);
    try {
      const message = await postAction(taskId, action, detail.task.updated_at);
      onToast({ msg: message });
      if (currentTaskId.current === taskId) setActionMessage(message);
      await Promise.all([refresh(), onChanged()]);
    } catch (e) {
      onToast({ msg: (e as Error).message, err: true });
      await refresh();
    } finally {
      actionInFlight.current = false;
      setBusyAction(null);
    }
  };

  const workflowAct = async (target: WorkflowTarget) => {
    if (actionInFlight.current || !detail) return;
    const current = detail.task.workflow_state;
    const verb: Record<WorkflowTarget, string> = {
      Todo: '移到 Todo？调度器会在下个周期领取并开始执行。',
      Backlog: '移回 Backlog？调度器不会再派发，直到再次移到 Todo。',
      'Human Review': current === 'Merging'
        ? '撤回合并？会清除批准并把 Issue 移到 Human Review；如果合并已提交，请在 GitHub 检查 PR 最终状态。'
        : current === 'Rework'
          ? '取消返工？会中止当前返工运行并回到 Human Review；已关闭的旧 PR 不会自动恢复。'
          : '移到 Human Review？如果当前有运行，会立即请求中止；旧的合并/返工授权会失效。',
      Rework: '要求完整返工？会关闭当前 PR，从最新基线新建分支、PR 和会话。',
      Merging: '批准合并？看板会把你的授权绑定到当前 PR head/base 和需求哈希；调度器仍会重新核验检查、CI 与分支保护后合并。',
    };
    if (!confirm(verb[target])) return;
    actionInFlight.current = true;
    setBusyAction(`workflow:${target}`);
    setActionMessage(null);
    try {
      const message = await postWorkflowState(taskId, target, detail.task.updated_at);
      onToast({ msg: message });
      if (currentTaskId.current === taskId) setActionMessage(message);
      await Promise.all([refresh(), onChanged()]);
    } catch (e) {
      onToast({ msg: (e as Error).message, err: true });
      await refresh();
    } finally {
      actionInFlight.current = false;
      setBusyAction(null);
    }
  };

  const answerDecision = async (requestId: string) => {
    const task = detail?.task;
    const attention = task?.attention;
    const answer = decisionAnswers[requestId];
    if (!task || !attention?.decision_version || !attention.head_sha || !answer || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusyAction(`decision:${requestId}`);
    try {
      const message = await resolveDecision(task.id, requestId, { expected_updated_at: task.updated_at, decision_version: attention.decision_version, head_sha: attention.head_sha, selected_option: answer.option, authorization: answer.authorization });
      onToast({ msg: message });
      setDecisionAnswers({});
      await Promise.all([refresh(), onChanged()]);
    } catch (e) { onToast({ msg: (e as Error).message, err: true }); await refresh(); }
    finally { actionInFlight.current = false; setBusyAction(null); }
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
  const showStop = t?.actions?.stop ?? (detail?.has_active_run || (t ? isActivePhase(t.status) : false));

  return (
    <div className="fixed inset-0 z-20" style={{ animation: 'fade-in .15s ease-out' }}>
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside
        className="absolute inset-x-0 bottom-0 top-[env(safe-area-inset-top)] flex h-[calc(100%-env(safe-area-inset-top))] w-full flex-col rounded-t-xl border-t border-edge bg-panel shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:h-full md:w-[560px] md:max-w-[94vw] md:rounded-none md:border-l md:border-t-0"
        style={{ animation: 'drawer-in .18s ease-out' }}
      >
        <header className="flex shrink-0 flex-wrap items-start gap-x-2 gap-y-2 border-b border-edge px-3 py-3 sm:px-4 md:flex-nowrap md:gap-3 md:py-3.5">
          <button
            onClick={onClose}
            className="flex size-10 shrink-0 touch-manipulation items-center justify-center rounded-md text-fg-muted hover:bg-elevated hover:text-fg"
            title="关闭"
          >
            <ChevronLeft className="size-4" />
          </button>
          <div className="min-w-0 flex-1">
            {t ? (
              <>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <GithubLink
                    url={t.issue_url}
                    className="font-mono text-[11px] text-info hover:underline"
                  >
                    {t.repo}
                    {t.source === 'pr' ? ' PR#' : '#'}
                    {t.issue_number}
                  </GithubLink>
                  {t.workflow ? (
                    <>
                      <span className={`flex items-center gap-1.5 text-[11px] ${workflowTextClass(t.workflow_state)}`} title="GitHub Issue 状态">
                        <WorkflowIcon state={t.workflow_state} />
                        {t.workflow_state ? WORKFLOW_TEXT[t.workflow_state] : '状态缺失'}
                      </span>
                      <span className="rounded border border-edge px-1.5 py-px font-mono text-[10px] text-fg-dim">{t.workflow_state ?? '—'}</span>
                    </>
                  ) : (
                    <span className={`flex items-center gap-1.5 text-[11px] ${phaseTextClass(t.status)}`}>
                      <StatusIcon phase={t.status} />
                      {phaseLabel(t.status)}
                    </span>
                  )}
                  {t.active_run && (
                    <span className={`flex items-center gap-1.5 text-[11px] ${phaseTextClass(t.active_run.phase)}`} title="本地执行状态">
                      <StatusIcon phase={t.active_run.phase} size={12} />
                      {phaseLabel(t.active_run.phase)} · {fmtDur(t.active_run.started_at)}
                    </span>
                  )}
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
            <div className="order-2 flex w-full items-center justify-end gap-2 md:order-none md:ml-auto md:w-auto md:shrink-0 md:pt-0.5">
              {(t.actions?.approve_merge ?? (t.status === 'AWAITING_HUMAN' && t.pr_url && t.source !== 'pr')) && (
                <button
                  disabled={!!busyAction}
                  onClick={() => act('approve-merge')}
                  className="flex min-h-10 touch-manipulation items-center gap-1.5 rounded-md border border-ok/30 px-3 py-2 text-xs font-medium text-ok hover:bg-ok/10"
                >
                  <Check className="size-3" />
                  {busyAction === 'approve-merge' ? '正在提交…' : '批准合并'}
                </button>
              )}
              {t.actions?.rereview && <button disabled={!!busyAction} onClick={() => act('rereview')} className="flex min-h-10 touch-manipulation items-center gap-1.5 rounded-md border border-info/30 px-3 py-2 text-xs font-medium text-info hover:bg-info/10 disabled:opacity-40"><RotateCw className="size-3" />{busyAction === 'rereview' ? '正在排队…' : '重新评审'}</button>}
              {showStop && (
                <button
                  disabled={!!busyAction}
                  onClick={() => act('stop')}
                  className="flex min-h-10 touch-manipulation items-center gap-1.5 rounded-md border border-danger/30 px-3 py-2 text-xs font-medium text-danger hover:bg-danger/10"
                >
                  <Square className="size-3" />
                  {busyAction === 'stop' ? '正在请求…' : '停止'}
                </button>
              )}
              {(t.actions?.retry ?? (detail!.retryable && !t.intake)) && (
                <button
                  disabled={!!busyAction}
                  onClick={() => act('retry')}
                  className="flex min-h-10 touch-manipulation items-center gap-1.5 rounded-md border border-info/30 px-3 py-2 text-xs font-medium text-info hover:bg-info/10"
                >
                  <RotateCw className="size-3" />
                  {busyAction === 'retry' ? '正在排队…' : '重试'}
                </button>
              )}
              <GithubLink
                url={t.issue_url}
                className="flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-elevated hover:text-fg"
                title={t.source === 'pr' ? '在 GitHub 打开 PR' : '在 GitHub 打开 issue'}
              >
                <ExternalLink className="size-3.5" />
              </GithubLink>
            </div>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3.5 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-4 md:px-4">
          {error && (
            <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2.5 text-xs text-danger">
              {error}
            </div>
          )}
          {actionMessage && <p role="status" className="mb-3 rounded-md border border-info/25 bg-info/5 px-3 py-2 text-xs text-info">{actionMessage}</p>}
          {t?.source === 'pr' && t.status === 'AWAITING_HUMAN' && <GithubLink url={t.pr_url ?? t.issue_url} className="mb-3 inline-block text-xs text-info hover:underline">在 GitHub 查看评审并决定是否合并 ↗</GithubLink>}
          {t && <TaskAttention attention={t.attention} />}
          {t?.workflow && <WorkflowActions task={t} busy={busyAction} onAct={workflowAct} />}
          {t?.workflow && <WorkflowGuide task={t} />}
          {t?.attention?.decisions?.map(request => {
            if (!request.request_id) return null;
            const id = request.request_id;
            const answer = decisionAnswers[id] ?? { option: '', authorization: '' };
            return <section key={`${t.attention?.head_sha}:${id}`} className="mt-3 rounded-md border border-warn/30 p-3 text-xs">
              <p className="font-medium">{request.question}</p>
              <p className="mt-2 text-fg-muted">影响：{request.impact}</p>
              <p className="mt-1 text-fg-muted">需要你决定的原因：{request.reason}</p>
              {request.file && <p className="mt-1 break-all text-fg-dim">{request.file}{request.line ? `:${request.line}` : ''}</p>}
              <label className="mt-3 block">选择方案<select aria-label={request.question} className="mt-1 w-full rounded border border-edge bg-panel p-2" value={answer.option} onChange={e => setDecisionAnswers(prev => ({ ...prev, [id]: { ...answer, option: e.target.value } }))}><option value="">请选择</option>{request.options.map(option => <option key={option} value={option}>{option}</option>)}</select></label>
              <label className="mt-3 block">具体决定与授权范围<textarea maxLength={4000} value={answer.authorization} onChange={e => setDecisionAnswers(prev => ({ ...prev, [id]: { ...answer, authorization: e.target.value } }))} className="mt-1 min-h-20 w-full rounded border border-edge bg-panel p-2" placeholder="说明允许的方案、影响范围和限制，请勿填写密码或令牌" /></label>
              <p className="mt-1 text-fg-dim">回答仅适用于当前需求和提交；不会立即合并。</p>
              <button disabled={!!busyAction || !answer.option || !answer.authorization.trim()} onClick={() => answerDecision(id)} className="mt-3 rounded border border-info/30 px-3 py-2 text-info disabled:opacity-40">{busyAction === `decision:${id}` ? '正在记录…' : '提交此项决定'}</button>
            </section>;
          })}
          {t && <><MetaGrid detail={detail!} />{!t.workflow && <IntakeActions task={t} active={detail!.has_active_run} onState={state => { ++refreshSequence.current; setDetail(current => current && state.version >= (current.task.intake?.version ?? 0) ? { ...current, task: { ...current.task, intake: state } } : current); }} onChanged={() => { refresh(); onChanged(); }} onToast={onToast} />}</>}
          {detail && (
            <div className="mt-4 space-y-3">
              {t?.workflow && <p className="text-[11px] text-fg-dim">以下为本地执行记录（运行、检查、日志），不构成 Issue 业务状态。</p>}
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

function WorkflowActions({ task, busy, onAct }: {
  task: TaskSummary;
  busy: string | null;
  onAct: (target: WorkflowTarget) => void;
}) {
  const state = task.workflow_state;
  const actions: { target: WorkflowTarget; label: string; tone: 'ok' | 'info' | 'warn' | 'muted' }[] = [];
  if (state === 'Backlog') actions.push({ target: 'Todo', label: '移到 Todo', tone: 'ok' });
  else if (state === 'Todo') actions.push(
    { target: 'Backlog', label: '移回 Backlog', tone: 'muted' },
    { target: 'Human Review', label: '移到 Human Review', tone: 'warn' },
  );
  else if (state === 'In Progress') actions.push({ target: 'Human Review', label: '暂停到 Human Review', tone: 'warn' });
  else if (state === 'Human Review') actions.push(
    { target: 'Merging', label: '批准合并', tone: 'ok' },
    { target: 'Rework', label: '要求返工', tone: 'warn' },
    { target: 'Todo', label: '移回 Todo', tone: 'info' },
    { target: 'Backlog', label: '移回 Backlog', tone: 'muted' },
  );
  else if (state === 'Rework') actions.push({ target: 'Human Review', label: '取消返工', tone: 'warn' });
  else if (state === 'Merging') actions.push({ target: 'Human Review', label: '撤回合并', tone: 'warn' });
  if (actions.length === 0) return null;
  const toneClass = {
    ok: 'border-ok/30 text-ok hover:bg-ok/10',
    info: 'border-info/30 text-info hover:bg-info/10',
    warn: 'border-warn/30 text-warn hover:bg-warn/10',
    muted: 'border-edge text-fg-muted hover:text-fg',
  };
  return (
    <section className="mt-3 rounded-md border border-edge bg-card p-3">
      <p className="text-[11px] font-medium text-fg">在看板改 Issue 状态</p>
      <p className="mt-1 text-[10.5px] text-fg-dim">操作会同步写 GitHub 标签；合并/返工授权绑定当前 PR 与需求哈希，调度器仍会重新核验检查、CI 与分支保护。</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {actions.map(action => {
          const blocked = action.target === 'Merging' && !task.workflow_handoff;
          return (
            <button
              key={action.target}
              disabled={!!busy || blocked}
              title={blocked ? '缺少交付范围（PR/检查证据），不能批准合并' : undefined}
              onClick={() => onAct(action.target)}
              className={`min-h-9 touch-manipulation rounded-md border px-3 py-1.5 text-[11px] font-medium disabled:opacity-40 ${toneClass[action.tone]}`}
            >
              {busy === `workflow:${action.target}` ? '正在提交…' : action.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function WorkflowGuide({ task }: { task: TaskSummary }) {
  const state = task.workflow_state;
  if (state === 'Human Review') return (
    <section className="mt-3 rounded-md border border-info/25 bg-info/5 p-3 text-xs">
      <p className="font-medium text-info">人工审核关口</p>
      {task.workflow_handoff ? (
        <p className="mt-1 text-fg-muted">审核 PR 与检查结果后，在上方点「批准合并」或「要求返工」。批准会绑定当前 PR head/base 与需求哈希；调度器仍会重新核验 Issue 需求、PR head/base 与批准范围后才合并，CI 与分支保护由 GitHub 把关。</p>
      ) : (
        <p className="mt-1 text-fg-muted">当前还没有关联 PR，无法合并。先在上方点「移回 Todo」让调度器重新执行并发布 PR，再审核。</p>
      )}
      <GithubLink url={task.issue_url} className="mt-2 inline-block text-fg-dim hover:underline">在 GitHub 打开 Issue ↗</GithubLink>
    </section>
  );
  if (state === 'Backlog') return (
    <section className="mt-3 rounded-md border border-edge bg-card p-3 text-xs text-fg-muted">
      Backlog 不会自动派发；在上方点「移到 Todo」后调度器才会领取，也可以去 GitHub 改标签。
    </section>
  );
  if (state === 'Rework') return (
    <section className="mt-3 rounded-md border border-warn/25 bg-warn/5 p-3 text-xs text-fg-muted">
      Rework 会关闭旧 PR，并从最新远端基线创建新分支、新会话；当前为第 {task.workflow_generation ?? 1} 代。
    </section>
  );
  if (state === 'Merging') return (
    <section className="mt-3 rounded-md border border-ok/25 bg-ok/5 p-3 text-xs text-fg-muted">
      正在核验人工授权事件、PR head/base 与检查证据；成功后自动合并并关闭 Issue。
    </section>
  );
  if (state === 'Done') return (
    <section className="mt-3 rounded-md border border-edge bg-card p-3 text-xs text-fg-muted">
      已合并并关闭 Issue。
    </section>
  );
  return null;
}

function MetaGrid({ detail }: { detail: TaskDetail }) {
  const t = detail.task;
  const items: [string, string][] = [];
  if (t.workflow) {
    items.push(['Issue 状态', t.workflow_state ?? '缺失/冲突']);
    items.push(['本地执行状态', t.active_run ? phaseLabel(t.active_run.phase) : phaseLabel(t.status)]);
    items.push(['代际', String(t.workflow_generation ?? 1)]);
    items.push(['需求哈希', t.approved_hash?.slice(0, 12) ?? '—']);
  } else {
    items.push(['批准哈希', t.approved_hash?.slice(0, 12) ?? '—']);
  }
  items.push(['修复轮次', String(t.fix_rounds)]);
  items.push(['创建时间', fmtTime(t.created_at)]);
  items.push(['更新时间', fmtTime(t.updated_at)]);
  if (t.branch) items.push(['分支', t.branch]);
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-md border border-edge bg-card px-3 py-3 text-[11px] sm:gap-x-6 sm:gap-y-2.5 sm:px-3.5">
      {items.map(([k, v]) => (
        <div key={k} className="flex min-w-0 flex-col gap-0.5">
          <span className="text-fg-dim">{k}</span>
          <span className="truncate font-mono text-fg" title={v}>
            {v}
          </span>
        </div>
      ))}
      {t.workflow && t.workflow_reason && (
        <div className="col-span-2 flex min-w-0 flex-col gap-0.5">
          <span className="text-fg-dim">最近诊断</span>
          <span className="break-words text-fg">{t.workflow_reason}</span>
        </div>
      )}
      {t.pr_url && (
        <GithubLink
          url={t.pr_url}
          className="col-span-2 flex items-center gap-1.5 font-mono text-info hover:underline"
        >
          <ExternalLink className="size-3" />
          {t.pr_url}
        </GithubLink>
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
          <GithubLink
            url={run.pr_url}
            className="text-info hover:underline"
          >
            PR
          </GithubLink>
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
              <span
                className="font-mono text-[11px] text-fg"
                title={e.from_phase ? `${e.from_phase} → ${e.to_phase}` : e.to_phase}
              >
                {e.from_phase ? `${phaseLabel(e.from_phase)} → ` : ''}
                {phaseLabel(e.to_phase)}
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
          : v === 'SKIP' ? 'text-fg-dim'
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
      className="fixed inset-0 z-30 flex items-end justify-center bg-black/60 p-2 pb-[max(.5rem,env(safe-area-inset-bottom))] sm:items-center sm:p-8"
      style={{ animation: 'fade-in .15s ease-out' }}
      onClick={onClose}
    >
      <div
        className="flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-edge-strong bg-panel shadow-2xl"
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
        <div className="min-h-0 overflow-auto px-3 py-3 sm:px-4">
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
