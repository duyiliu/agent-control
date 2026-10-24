import { useRef, useState } from 'react';
import { actOnTriage, type IntakeState, type TaskSummary, type TriageAction } from './api';
import type { Toast } from './App';
import { isDeferredDue, localDateTime } from './deferred';

export default function IntakeActions({ task, active, onState, onChanged, onToast }: {
  task: TaskSummary; active?: boolean; onState: (state: IntakeState) => void; onChanged: () => void; onToast: (toast: Toast) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [showDefer, setShowDefer] = useState(false);
  const [remindAt, setRemindAt] = useState('');
  const inFlight = useRef(false);
  const state = task.intake;
  if (!state || active || task.active_run || ['COMPLETED', 'MERGING', 'AWAITING_REVIEW', 'AWAITING_HUMAN'].includes(task.status)) return null;
  const act = async (action: TriageAction, params: Record<string, unknown> = {}) => {
    if (inFlight.current) return false;
    inFlight.current = true; setBusy(true);
    try {
      const result = await actOnTriage(task.repo, task.issue_number, action, { ...params, expected_version: state.version });
      onState(result.state); onToast({ msg: result.message });
      return true;
    } catch (err) { const latest = (err as Error & { state?: IntakeState }).state; if (latest) onState(latest); onToast({ msg: (err as Error).message, err: true }); return false; }
    finally { inFlight.current = false; setBusy(false); onChanged(); }
  };
  const button = 'min-h-10 flex-1 touch-manipulation rounded border border-edge px-2.5 py-2 text-[11px] text-fg-muted hover:text-fg disabled:opacity-40 sm:flex-none';
  return <div onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} className="mt-2 space-y-2">
    <div role="status" className="break-words text-[11px] leading-relaxed text-fg-muted">
      {busy ? '正在保存…' : state.pending ? state.error ? `同步失败，将重试：${state.error}` : '操作已保存，正在同步…' : state.error || state.reason || (state.external_hold ? 'GitHub 人工锁定' : state.external_needs ? 'GitHub 标记需要人工' : '')}
      {(state.locked || state.external_hold) && <span className="ml-1 text-warn">人工锁定</span>}
      {state.defer_until && <span className={`ml-1 ${isDeferredDue(state) ? 'font-medium text-warn' : ''}`}>{isDeferredDue(state) ? '提醒已到期：' : '提醒：'}{new Date(state.defer_until).toLocaleString('zh-CN')}</span>}
    </div>
    <div className="flex flex-wrap gap-2">
      {!state.imported ? <button disabled={busy} className={button} onClick={() => act('recover')}>核验后恢复</button> : <>
        <button disabled={busy} className={button} onClick={() => act(state.pending ? 'sync' : 'approve')}>{state.pending ? '重试同步' : '继续处理'}</button>
        <button disabled={busy} className={button} onClick={() => { setRemindAt(state.defer_until ? localDateTime(state.defer_until) : ''); setShowDefer(v => !v); }}>{state.kind === 'deferred' ? '修改提醒' : '暂缓'}</button>
        <button disabled={busy} className={button} onClick={() => act(state.locked || state.external_hold ? 'unlock' : 'lock')}>{state.locked || state.external_hold ? '解除锁定' : '人工锁定'}</button>
      </>}
    </div>
    {showDefer && <div className="space-y-2 rounded-md border border-edge bg-panel p-2.5">
      <label className="block text-[11px] text-fg-muted">提醒时间（可选）<input type="datetime-local" aria-label="暂缓提醒时间" value={remindAt} disabled={busy} onChange={e => setRemindAt(e.target.value)} className="mt-1 block min-h-10 w-full min-w-0 rounded border border-edge bg-card px-2 text-xs text-fg" /></label>
      <p className="text-[11px] text-fg-dim">到期后显示提醒，点击“继续处理”后再派工。</p>
      <div className="flex flex-wrap gap-2"><button disabled={busy} className={button} onClick={async () => {
        const at = remindAt ? new Date(remindAt).getTime() : null;
        if (at !== null && (!Number.isFinite(at) || at <= Date.now())) { onToast({ msg: '请选择未来的提醒时间，或留空', err: true }); return; }
        if (await act('defer', at === null ? {} : { defer_until: new Date(at).toISOString() })) setShowDefer(false);
      }}>确认暂缓</button><button disabled={busy} className={button} onClick={() => setShowDefer(false)}>取消</button></div>
    </div>}
  </div>;
}
