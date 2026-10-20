import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Check, Palette, RefreshCw, TriangleAlert } from 'lucide-react';
import { fetchHealth, fetchTasks, postAction, type HealthInfo, type TaskSummary } from './api';
import { fmtDur } from './groups';
import Board from './Board';
import DetailDrawer from './DetailDrawer';

export interface Toast {
  msg: string;
  err?: boolean;
}

type ThemeId = 'ink' | 'void' | 'slate' | 'zlight' | 'paper';

const THEMES: { id: ThemeId; label: string; hint: string }[] = [
  { id: 'ink', label: 'Ink', hint: '中性暗 · ZCode' },
  { id: 'void', label: 'Void', hint: '高对比黑' },
  { id: 'slate', label: 'Slate', hint: '冷灰蓝' },
  { id: 'zlight', label: 'ZLight', hint: '纯白' },
  { id: 'paper', label: 'Paper', hint: '暖白' },
];

const THEME_KEY = 'ac-theme';

function useTheme(): [ThemeId, (t: ThemeId) => void] {
  const [theme, setTheme] = useState<ThemeId>(() => {
    const saved = localStorage.getItem(THEME_KEY) as ThemeId | null;
    return THEMES.some((t) => t.id === saved) ? saved! : 'ink';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);
  return [theme, setTheme];
}

export default function App() {
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const [theme, setTheme] = useTheme();

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
        `停止「${task.issue_title || `#${task.issue_number}`}」？调度器会在一个轮询周期内中止当前运行。`,
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
      <header className="flex h-11 shrink-0 items-center gap-4 border-b border-edge px-4">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-fg">
          <Activity className="size-3.5 text-fg-muted" />
          agent-control
        </div>
        <HealthLine health={health} />
        <div className="ml-auto flex items-center gap-2">
          <ThemeSwitcher theme={theme} onChange={setTheme} />
          <span className="flex items-center gap-1.5 text-[11px] text-fg-dim">
            <RefreshCw className="size-3" />
            自动刷新 5 秒
          </span>
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
          className={`fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-md bg-panel px-3.5 py-2 text-xs shadow-lg ring-1 ${
            toast.err ? 'text-danger ring-danger/40' : 'text-fg ring-edge-strong'
          }`}
          style={{ animation: 'fade-in .15s ease-out' }}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function ThemeSwitcher(props: { theme: ThemeId; onChange: (t: ThemeId) => void }) {
  const { theme, onChange } = props;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = THEMES.find((t) => t.id === theme)!;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md border border-edge px-2 py-1 text-[11px] text-fg-muted transition-colors hover:border-edge-strong hover:text-fg"
        title="切换主题"
      >
        <Palette className="size-3" />
        {current.label}
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-40 mt-1.5 w-48 rounded-md border border-edge bg-panel p-1 shadow-xl"
          style={{ animation: 'fade-in .1s ease-out' }}
        >
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                onChange(t.id);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-fg-muted transition-colors hover:bg-elevated hover:text-fg"
            >
              <span
                data-theme={t.id}
                className="flex size-4 shrink-0 items-center justify-center rounded border border-edge bg-canvas"
              >
                <span className="size-1.5 rounded-full bg-ok" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-fg">{t.label}</span>
                <span className="block text-[10.5px] text-fg-dim">{t.hint}</span>
              </span>
              {theme === t.id && <Check className="size-3 shrink-0 text-fg-muted" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function HealthLine({ health }: { health: HealthInfo | null }) {
  if (!health) return null;
  const upFrom = new Date(Date.now() - health.uptime_s * 1000).toISOString();
  return (
    <div className="flex min-w-0 items-center gap-3 text-[11px] text-fg-muted">
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <span
          className="size-1.5 rounded-full bg-ok"
          style={{ animation: 'pulse-dot 2.4s ease-in-out infinite' }}
        />
        pid {health.pid} · 已运行 {fmtDur(upFrom)} · 运行中 {health.active_runs_in_process} 个
      </span>
      {health.last_error && (
        <span
          className="flex min-w-0 items-center gap-1 text-danger"
          title={health.last_error.error}
        >
          <TriangleAlert className="size-3 shrink-0" />
          <span className="truncate">{health.last_error.kind}</span>
        </span>
      )}
    </div>
  );
}
