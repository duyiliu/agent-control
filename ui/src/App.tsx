import { useCallback, useEffect, useState } from 'react';
import { Activity, RefreshCw, TriangleAlert } from 'lucide-react';
import { fetchHealth, fetchTasks, postAction, type HealthInfo, type TaskSummary } from './api';
import { fmtDur } from './groups';
import Board from './Board';
import DetailDrawer from './DetailDrawer';

export interface Toast {
  msg: string;
  err?: boolean;
}

export default function App() {
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [t, h] = await Promise.all([fetchTasks(), fetchHealth()]);
      setTasks(t.tasks);
      setHealth(h);
    } catch { /* transient — next cycle retries */ }
  }, []);

  // Drag-to-Needs-Attention equivalent of the drawer's Stop button.
  const stopByDrag = useCallback(
    async (task: TaskSummary) => {
      const ok = window.confirm(
        `Stop "${task.issue_title || `#${task.issue_number}`}"? The scheduler aborts the active run within one poll cycle.`,
      );
      if (!ok) return;
      try {
        setToast({ msg: await postAction(task.id, 'stop') });
      } catch (e) {
        setToast({ msg: (e as Error).message, err: true });
      }
      refresh();
    },
    [refresh],
  );

  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      if (!document.hidden) refresh();
    }, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-edge px-5">
        <div className="flex items-center gap-2 text-[15px] font-semibold text-zinc-100">
          <Activity className="size-4 text-emerald-400" />
          agent-control
        </div>
        <HealthLine health={health} />
        <div className="ml-auto flex items-center gap-1.5 text-xs text-zinc-600">
          <RefreshCw className="size-3" />
          auto 5s
        </div>
      </header>
      <Board tasks={tasks} tick={tick} selected={selected} onSelect={setSelected} onStop={stopByDrag} />
      {selected !== null && (
        <DetailDrawer
          taskId={selected}
          onClose={() => setSelected(null)}
          onChanged={refresh}
          onToast={setToast}
        />
      )}
      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-lg px-4 py-2 text-sm shadow-lg ring-1 ${
            toast.err
              ? 'bg-rose-950/95 text-rose-200 ring-rose-500/30'
              : 'bg-sky-950/95 text-sky-200 ring-sky-500/30'
          }`}
          style={{ animation: 'fade-in .15s ease-out' }}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function HealthLine({ health }: { health: HealthInfo | null }) {
  if (!health) return null;
  const upFrom = new Date(Date.now() - health.uptime_s * 1000).toISOString();
  return (
    <div className="flex min-w-0 items-center gap-3 text-xs text-zinc-500">
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <span
          className="size-1.5 rounded-full bg-emerald-400"
          style={{ animation: 'pulse-dot 1.5s infinite' }}
        />
        pid {health.pid} · up {fmtDur(upFrom)} · {health.active_runs_in_process} in-flight
      </span>
      {health.last_error && (
        <span
          className="flex min-w-0 items-center gap-1 text-rose-300"
          title={health.last_error.error}
        >
          <TriangleAlert className="size-3 shrink-0" />
          <span className="truncate">{health.last_error.kind}</span>
        </span>
      )}
    </div>
  );
}
