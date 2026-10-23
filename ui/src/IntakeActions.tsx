import { useRef, useState } from 'react';
import { actOnTriage, type IntakeState, type TaskSummary, type TriageAction } from './api';
import type { Toast } from './App';

export default function IntakeActions({ task, active, onState, onChanged, onToast }: {
  task: TaskSummary; active?: boolean; onState: (state: IntakeState) => void; onChanged: () => void; onToast: (toast: Toast) => void;
}) {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const state = task.intake;
  if (!state || active || task.active_run || ['COMPLETED', 'MERGING', 'AWAITING_REVIEW', 'AWAITING_HUMAN'].includes(task.status)) return null;
  const act = async (action: TriageAction) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try {
      const result = await actOnTriage(task.repo, task.issue_number, action, { expected_version: state.version });
      onState(result.state); onToast({ msg: result.message });
    } catch (err) { const latest = (err as Error & { state?: IntakeState }).state; if (latest) onState(latest); onToast({ msg: (err as Error).message, err: true }); }
    finally { inFlight.current = false; setBusy(false); onChanged(); }
  };
  const button = 'rounded border border-edge px-2 py-1 text-[11px] text-fg-muted hover:text-fg disabled:opacity-40';
  return <div onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} className="mt-2 space-y-2">
    <div role="status" className="text-[11px] text-fg-muted">
      {busy ? '正在保存…' : state.pending ? state.error ? `同步失败，将重试：${state.error}` : '操作已保存，正在同步…' : state.error || state.reason || (state.external_hold ? 'GitHub 人工锁定' : state.external_needs ? 'GitHub 标记需要人工' : '')}
      {(state.locked || state.external_hold) && <span className="ml-1 text-warn">人工锁定</span>}
      {state.defer_until && <span className="ml-1">提醒：{new Date(state.defer_until).toLocaleString('zh-CN')}</span>}
    </div>
    <div className="flex flex-wrap gap-1.5">
      {!state.imported ? <button disabled={busy} className={button} onClick={() => act('recover')}>核验后恢复</button> : <>
        <button disabled={busy} className={button} onClick={() => act(state.pending ? 'sync' : 'approve')}>{state.pending ? '重试同步' : '继续处理'}</button>
        <button disabled={busy} className={button} onClick={() => act('defer')}>暂缓</button>
        <button disabled={busy} className={button} onClick={() => act(state.locked || state.external_hold ? 'unlock' : 'lock')}>{state.locked || state.external_hold ? '解除锁定' : '人工锁定'}</button>
      </>}
    </div>
  </div>;
}
