import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, Clock, GitPullRequest, Search, X } from 'lucide-react';
import type { IntakeState, TaskSummary, WorkflowState, WorkflowTarget } from './api';
import { postWorkflowState } from './api';
import GithubLink from './GithubLink';
import {
  bucketOf,
  COLUMNS,
  fmtDur,
  fmtTime,
  phaseLabel,
  phaseTextClass,
  WORKFLOW_TEXT,
  workflowTextClass,
  type GroupKey,
} from './groups';
import { buildRepoCounts } from './repo-filters';
import StatusIcon, { WorkflowIcon } from './StatusIcon';
import IntakeActions from './IntakeActions';
import TaskAttention from './TaskAttention';
import type { Toast } from './App';

const EMPTY_HINT: Record<GroupKey, string> = {
  backlog: 'Backlog 为空；新 Issue 会先进入这里',
  todo: '没有等待派发的 Issue',
  active: '没有正在执行的 Issue',
  human: '没有等待人工审核的 Issue',
  rework: '没有返工中的 Issue',
  merging: '没有合并中的 Issue',
  done: '没有已完成的 Issue',
  blocked: '没有异常状态',
};

const FILTER_KEY = 'ac-repo-filter';
const COLLAPSE_KEY = 'ac-board-collapsed';
const SHOW_EMPTY_KEY = 'ac-board-show-empty';
const VIEWS_KEY = 'ac-board-views';

/** One flat board: the seven GitHub states, plus an exception column when needed. */
const BOARD_ORDER: GroupKey[] = ['backlog', 'todo', 'active', 'human', 'rework', 'merging', 'done', 'blocked'];

/** Only these columns represent a human-movable state. In Progress/Done are host-owned. */
const DRAG_TARGET: Partial<Record<GroupKey, WorkflowTarget>> = {
  backlog: 'Backlog',
  todo: 'Todo',
  human: 'Human Review',
  rework: 'Rework',
  merging: 'Merging',
};

const MOVES: Record<WorkflowState, WorkflowTarget[]> = {
  Backlog: ['Todo'],
  Todo: ['Backlog', 'Human Review'],
  'In Progress': ['Human Review'],
  'Human Review': ['Todo', 'Backlog', 'Merging', 'Rework'],
  Rework: ['Human Review'],
  Merging: ['Human Review'],
  Done: [],
};

interface BoardView {
  id: string;
  name: string;
  repo: string | null;
  keyword: string;
  showEmpty: boolean;
  collapsed: GroupKey[];
}

function readCollapsed(): Set<GroupKey> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is GroupKey => typeof key === 'string' && BOARD_ORDER.includes(key as GroupKey)) : []);
  } catch { return new Set(); }
}

function readViews(): BoardView[] {
  try {
    const raw = localStorage.getItem(VIEWS_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(parsed)
      ? parsed.filter((view): view is BoardView => !!view && typeof view === 'object' && typeof (view as BoardView).name === 'string' && Array.isArray((view as BoardView).collapsed))
      : [];
  } catch { return []; }
}

function countBy(list: TaskSummary[]): Map<GroupKey, number> {
  const counts = new Map<GroupKey, number>();
  for (const key of BOARD_ORDER) counts.set(key, 0);
  for (const task of list) counts.set(bucketOf(task), (counts.get(bucketOf(task)) ?? 0) + 1);
  return counts;
}

export default function Board(props: {
  tasks: TaskSummary[] | null;
  projectRepos: string[];
  tick: number;
  selected: number | null;
  onSelect: (id: number) => void;
  onStop: (task: TaskSummary) => void;
  onIntakeChanged: (id: number, state: IntakeState) => void;
  onChanged: () => void;
  onToast: (toast: Toast) => void;
}) {
  const { tasks, projectRepos, tick, selected, onSelect, onIntakeChanged, onChanged, onToast } = props;
  const [mobileGroup, setMobileGroup] = useState<GroupKey | null>(null);
  const [repoFilter, setRepoFilter] = useState<string | null>(() => localStorage.getItem(FILTER_KEY));
  const [keyword, setKeyword] = useState('');
  const [collapsed, setCollapsed] = useState<Set<GroupKey>>(readCollapsed);
  const [showEmpty, setShowEmpty] = useState(() => localStorage.getItem(SHOW_EMPTY_KEY) !== '0');
  const [views, setViews] = useState<BoardView[]>(readViews);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [dragged, setDragged] = useState<TaskSummary | null>(null);
  const [dragOver, setDragOver] = useState<GroupKey | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  useEffect(() => {
    if (!viewMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!viewRef.current?.contains(e.target as Node)) setViewMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setViewMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [viewMenuOpen]);

  if (!tasks) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-fg-dim">加载中…</div>
    );
  }

  const knownRepos = new Set([...projectRepos, ...tasks.map(t => t.repo)]);
  const activeFilter = repoFilter && knownRepos.has(repoFilter) ? repoFilter : null;
  const setFilter = (repo: string | null) => {
    setRepoFilter(repo);
    if (repo) localStorage.setItem(FILTER_KEY, repo);
    else localStorage.removeItem(FILTER_KEY);
  };
  const persistCollapsed = (next: Set<GroupKey>) => {
    setCollapsed(next);
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
  };
  const toggleCollapse = (key: GroupKey) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key); else next.add(key);
    persistCollapsed(next);
  };
  const persistShowEmpty = (value: boolean) => {
    setShowEmpty(value);
    localStorage.setItem(SHOW_EMPTY_KEY, value ? '1' : '0');
  };
  const persistViews = (next: BoardView[]) => {
    setViews(next);
    localStorage.setItem(VIEWS_KEY, JSON.stringify(next));
  };
  const applyView = (view: BoardView) => {
    setFilter(typeof view.repo === 'string' && view.repo ? view.repo : null);
    setKeyword(typeof view.keyword === 'string' ? view.keyword : '');
    persistShowEmpty(view.showEmpty !== false);
    persistCollapsed(new Set(Array.isArray(view.collapsed) ? view.collapsed : []));
    setViewMenuOpen(false);
  };
  const clearView = () => {
    setFilter(null);
    setKeyword('');
    persistShowEmpty(true);
    persistCollapsed(new Set());
    setViewMenuOpen(false);
  };
  const saveView = () => {
    const name = window.prompt('视图名称（保存在本机）');
    if (!name?.trim()) return;
    const id = globalThis.crypto?.randomUUID?.() ?? String(Date.now());
    persistViews([...views, { id, name: name.trim(), repo: activeFilter, keyword, showEmpty, collapsed: [...collapsed] }]);
    setViewMenuOpen(false);
  };
  const deleteView = (id: string) => persistViews(views.filter(view => view.id !== id));
  const collapseAll = () => persistCollapsed(new Set(BOARD_ORDER));
  const expandAll = () => persistCollapsed(new Set());

  const kw = keyword.trim().toLowerCase().replace(/^#/, '');
  const matching = tasks.filter(t => !kw || t.issue_title.toLowerCase().includes(kw) || String(t.issue_number).includes(kw) || t.repo.toLowerCase().includes(kw));
  const scoped = matching.filter(t => !activeFilter || t.repo === activeFilter);
  const scopedCounts = countBy(scoped);
  const globalCounts = countBy(matching);
  const byGroup = new Map<GroupKey, TaskSummary[]>();
  for (const key of BOARD_ORDER) byGroup.set(key, []);
  for (const task of scoped) byGroup.get(bucketOf(task))!.push(task);
  for (const list of byGroup.values()) list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  const columns = BOARD_ORDER
    .map(key => COLUMNS[key])
    .filter(col => col.key !== 'blocked' || (scopedCounts.get('blocked') ?? 0) > 0 || (globalCounts.get('blocked') ?? 0) > 0)
    .filter(col => showEmpty || (scopedCounts.get(col.key) ?? 0) > 0);
  const defaultMobileGroup = columns.find(col => (scopedCounts.get(col.key) ?? 0) > 0)?.key ?? columns[0]?.key;
  const selectedMobileGroup = mobileGroup && columns.some(col => col.key === mobileGroup) ? mobileGroup : defaultMobileGroup;
  const summary = BOARD_ORDER
    .filter(key => (scopedCounts.get(key) ?? 0) > 0)
    .map(key => `${scopedCounts.get(key)} ${COLUMNS[key].label}`)
    .join(' · ') || '当前没有任务';
  const repos = buildRepoCounts(scoped, []);
  const repoNames = [...repos.keys()];

  const canDrop = (task: TaskSummary | null, target: GroupKey): boolean => {
    if (!task || !task.workflow || !task.workflow_state) return false;
    const targetState = DRAG_TARGET[target];
    return !!targetState && MOVES[task.workflow_state].includes(targetState);
  };

  const moveTask = async (task: TaskSummary, target: GroupKey) => {
    const targetState = DRAG_TARGET[target];
    if (!task.workflow || !task.workflow_state || !targetState) {
      onToast({ msg: target === 'active' ? 'In Progress 由调度器维护，不能直接拖入' : `不能移到 ${COLUMNS[target].label}`, err: true });
      return;
    }
    if (!MOVES[task.workflow_state].includes(targetState)) {
      onToast({ msg: `不能从 ${task.workflow_state} 直接移到 ${targetState}`, err: true });
      return;
    }
    if (targetState === 'Merging' && !task.workflow_handoff) {
      onToast({ msg: '还没有关联 PR，不能批准合并', err: true });
      return;
    }
    const verb: Record<string, string> = {
      Todo: `把「${task.issue_title}」移到 Todo？调度器会开始执行。`,
      Backlog: `把「${task.issue_title}」移回 Backlog？不会自动派发。`,
      'Human Review': `把「${task.issue_title}」移到 Human Review？在途运行会被中止。`,
      Rework: `要求「${task.issue_title}」完整返工？会关闭当前 PR 并新建分支、PR 和会话。`,
      Merging: `批准合并「${task.issue_title}」？授权会绑定当前 PR head/base 与需求哈希，调度器仍会重新核验。`,
    };
    if (!confirm(verb[targetState] ?? `改为 ${targetState}？`)) return;
    try {
      const message = await postWorkflowState(task.id, targetState, task.updated_at);
      onToast({ msg: message });
      onChanged();
    } catch (e) {
      onToast({ msg: (e as Error).message, err: true });
    } finally {
      setDragged(null);
      setDragOver(null);
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-edge px-3 pt-4 sm:px-4">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-base font-semibold text-fg">Issue 工作台</h1>
          <p className="text-xs text-fg-muted">{summary}{activeFilter ? ` · 已筛选 ${activeFilter}` : ''}</p>
          <p className="w-full text-[10.5px] text-fg-dim">业务状态来自 GitHub Issue 的七状态标签（最近一次对账）；拖动卡片或打开任务详情可直接改状态，Running/Retrying 等运行状态只记录在本机。</p>
        </div>
      </div>
      <div className="z-10 shrink-0 border-b border-edge bg-canvas/95 px-3 py-2 backdrop-blur-sm sm:px-4 sm:pt-3">
        <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto pb-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:flex-wrap lg:overflow-visible">
          {repoNames.length > 5 ? <label className="flex min-w-0 items-center gap-2 text-xs text-fg-muted">
            项目<select aria-label="筛选项目" value={activeFilter ?? ''} onChange={e => setFilter(e.target.value || null)} className="min-h-9 max-w-[75vw] rounded-md border border-edge bg-card px-2 text-xs text-fg">
              <option value="">全部项目（{scoped.length}）</option>
              {repoNames.map(repo => <option key={repo} value={repo}>{repo}（{repos.get(repo) ?? 0}）</option>)}
            </select>
          </label> : <>
            <Chip active={activeFilter === null} onClick={() => setFilter(null)}>全部<Count n={scoped.length} /></Chip>
            {repoNames.map(repo => <Chip key={repo} active={activeFilter === repo} onClick={() => setFilter(repo)}>
              <span className="max-w-[68vw] truncate sm:max-w-none">{repo}</span><Count n={repos.get(repo) ?? 0} />
            </Chip>)}
          </>}
          {activeFilter && <button type="button" onClick={() => setFilter(null)} className="min-h-9 shrink-0 px-2 text-[11px] text-info hover:underline">清除项目筛选</button>}
        </div>
        <div className="flex min-w-0 items-center gap-2 pt-1">
          <div className="relative shrink-0" ref={viewRef}>
            <button
              type="button"
              onClick={() => setViewMenuOpen(open => !open)}
              className="flex min-h-9 items-center gap-1.5 rounded-md border border-edge px-2.5 py-1.5 text-[11px] text-fg-muted hover:text-fg"
            >
              视图<ChevronDown className="size-3" />
            </button>
            {viewMenuOpen && (
              <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded-md border border-edge bg-panel p-1 shadow-xl">
                <button type="button" onClick={clearView} className="flex w-full items-center rounded px-2 py-1.5 text-left text-[11px] text-fg-muted hover:bg-elevated hover:text-fg">全部任务</button>
                {views.map(view => (
                  <div key={view.id} className="flex items-center">
                    <button type="button" onClick={() => applyView(view)} className="min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-[11px] text-fg-muted hover:bg-elevated hover:text-fg" title={view.name}>{view.name}</button>
                    <button type="button" onClick={() => deleteView(view.id)} className="flex size-7 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-elevated hover:text-danger" title="删除视图"><X className="size-3" /></button>
                  </div>
                ))}
                <div className="my-1 border-t border-edge" />
                <button type="button" onClick={saveView} className="flex w-full items-center rounded px-2 py-1.5 text-left text-[11px] text-info hover:bg-elevated">保存当前视图…</button>
                <button type="button" onClick={collapseAll} className="flex w-full items-center rounded px-2 py-1.5 text-left text-[11px] text-fg-muted hover:bg-elevated hover:text-fg">全部折叠</button>
                <button type="button" onClick={expandAll} className="flex w-full items-center rounded px-2 py-1.5 text-left text-[11px] text-fg-muted hover:bg-elevated hover:text-fg">全部展开</button>
              </div>
            )}
          </div>
          <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-fg-muted">
            <input type="checkbox" checked={showEmpty} onChange={e => persistShowEmpty(e.target.checked)} className="accent-brand" />
            显示空列
          </label>
          <div className="group relative ml-auto w-10 shrink-0 transition-[width] focus-within:w-40 [&:has(input:not(:placeholder-shown))]:w-40 sm:w-52">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-fg-dim" />
            <input
              ref={searchRef}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { setKeyword(''); e.currentTarget.blur(); } }}
              aria-label="搜索任务"
              placeholder="搜索标题、仓库或 #编号"
              className="w-full rounded-md border border-edge bg-card py-1.5 pl-7.5 pr-2 text-[11px] text-fg outline-none placeholder:text-fg-dim focus:border-edge-strong"
            />
          </div>
        </div>
      </div>
      <div role="tablist" aria-label="状态列" className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-edge bg-panel/50 px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:hidden">
        {columns.map(col => {
          const count = scopedCounts.get(col.key) ?? 0;
          const active = selectedMobileGroup === col.key;
          return <button key={col.key} type="button" role="tab" aria-selected={active} onClick={() => setMobileGroup(col.key)} className={`flex min-h-10 shrink-0 items-center gap-2 rounded-md border px-3 text-xs font-medium ${active ? 'border-brand/40 bg-brand/10 text-brand' : 'border-edge bg-card text-fg-muted'}`}>
            <span className={`size-1.5 rounded-full ${col.dot}`} />{col.label}<span className="tabular-nums opacity-70">{count}</span>
          </button>;
        })}
      </div>
      {columns.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-xs text-fg-dim">没有匹配的任务</div>
      ) : (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 lg:flex-row lg:gap-3 lg:overflow-x-auto lg:overflow-y-hidden lg:p-4">
        {columns.map((col) => {
          const items = byGroup.get(col.key)!;
          const scopedCount = scopedCounts.get(col.key) ?? 0;
          const globalCount = globalCounts.get(col.key) ?? 0;
          const isCollapsed = collapsed.has(col.key);
          const isOver = dragOver === col.key;
          const allowed = canDrop(dragged, col.key);
          return (
            <section
              key={col.key}
              onDragOver={(e) => {
                if (!dragged) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = allowed ? 'move' : 'none';
                setDragOver(col.key);
              }}
              onDragLeave={() => setDragOver(current => current === col.key ? null : current)}
              onDrop={(e) => {
                e.preventDefault();
                if (dragged) void moveTask(dragged, col.key);
              }}
              className={`flex min-h-0 w-full shrink-0 flex-col rounded-lg border border-edge bg-panel transition-shadow lg:max-h-full ${
                isCollapsed ? 'lg:w-10 lg:min-w-10 lg:flex-none' : 'lg:w-0 lg:min-w-[220px] lg:flex-1'
              } ${isOver ? (allowed ? 'ring-2 ring-brand/40' : 'ring-2 ring-danger/30') : ''} ${col.key === selectedMobileGroup ? 'flex' : 'hidden'} lg:flex`}
            >
              {isCollapsed && (
                <button
                  type="button"
                  onClick={() => toggleCollapse(col.key)}
                  title={`展开 ${col.label}`}
                  className="hidden min-h-0 flex-1 flex-col items-center gap-2 py-3 text-fg-muted hover:text-fg lg:flex"
                >
                  <span className={`size-1.5 rounded-full ${col.dot}`} />
                  <span className="text-[10.5px] tabular-nums">{scopedCount}</span>
                  <span className="text-[11px] font-medium" style={{ writingMode: 'vertical-rl' }}>{col.label}</span>
                </button>
              )}
              <div className={`${isCollapsed ? 'lg:hidden' : 'flex'} min-h-0 flex-1 flex-col`}>
                <header className="flex shrink-0 items-start gap-2 px-3 py-2.5 text-[12px] font-medium text-fg-muted">
                  <span className={`mt-1 size-1.5 shrink-0 rounded-full ${col.dot} ${col.key === 'active' ? '[animation:pulse-dot_1.5s_infinite]' : ''}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-fg">{col.label}</span>
                      <span className="rounded border border-edge px-1.5 py-px text-[10.5px] tabular-nums text-fg-dim">{activeFilter ? `${scopedCount}/${globalCount}` : scopedCount}</span>
                    </div>
                    <div className="truncate text-[10px] font-normal text-fg-dim" title={col.sub}>{col.sub}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleCollapse(col.key)}
                    title="折叠列"
                    className="hidden size-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-elevated hover:text-fg lg:flex"
                  >
                    <ChevronLeft className="size-3.5" />
                  </button>
                </header>
                {/* lg+ only: on mobile this box has zero scroll extent, and a
                    nested overflow container would swallow the touch scroll. */}
                <div className="min-h-0 flex-1 space-y-2 px-2 pb-[max(.5rem,env(safe-area-inset-bottom))] lg:overflow-y-auto lg:overscroll-contain">
                  {items.map((t) => (
                    <TaskCard
                      key={t.id}
                      task={t}
                      tick={tick}
                      selected={selected === t.id}
                      dragging={dragged?.id === t.id}
                      onSelect={onSelect}
                      onDragStart={() => setDragged(t)}
                      onDragEnd={() => { setDragged(null); setDragOver(null); }}
                      onIntakeChanged={onIntakeChanged}
                      onChanged={onChanged}
                      onToast={onToast}
                    />
                  ))}
                  {items.length === 0 && (
                    <div className="rounded-md border border-dashed border-edge px-3 py-6 text-center text-[11px] text-fg-dim">
                      {EMPTY_HINT[col.key]}
                    </div>
                  )}
                </div>
              </div>
            </section>
          );
        })}
      </div>
      )}
    </div>
  );
}

function Chip(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={props.onClick}
      className={`flex items-center gap-1.5 min-h-9 shrink-0 touch-manipulation rounded-md border px-2.5 py-1.5 text-[11px] transition-colors ${
        props.active
          ? 'border-brand/40 bg-brand/10 text-brand'
          : 'border-edge text-fg-muted hover:border-edge-strong hover:text-fg'
      }`}
    >
      {props.children}
    </button>
  );
}

function Count({ n }: { n: number }) {
  return <span className="tabular-nums opacity-60">{n}</span>;
}

function shortRepo(repo: string): string {
  return repo.split('/')[1] ?? repo;
}

function TaskCard(props: {
  task: TaskSummary;
  tick: number;
  selected: boolean;
  dragging: boolean;
  onSelect: (id: number) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onIntakeChanged: (id: number, state: IntakeState) => void;
  onChanged: () => void;
  onToast: (toast: Toast) => void;
}) {
  const { task, tick, selected, dragging, onSelect, onDragStart, onDragEnd, onIntakeChanged, onChanged, onToast } = props;
  const active = task.active_run;
  const phase = active?.phase ?? task.status;
  const prNumber = task.pr_url?.match(/\/pull\/(\d+)/)?.[1];
  const workflowState = task.workflow ? task.workflow_state : null;
  const stateText = task.workflow
    ? workflowState ? WORKFLOW_TEXT[workflowState] : '状态缺失'
    : task.intake?.kind === 'deferred' ? '已暂缓'
      : task.intake?.kind === 'skipped' ? '无需处理'
        : task.intake?.locked || task.intake?.external_hold ? '已暂停'
          : task.intake?.kind === 'human' || task.intake?.external_needs ? '待人工'
            : phaseLabel(phase);
  const tone = task.workflow ? workflowTextClass(workflowState) : phaseTextClass(phase);
  const generation = task.workflow && (task.workflow_generation ?? 1) > 1 ? `第 ${task.workflow_generation} 代` : null;
  const select = () => { if (!dragging) onSelect(task.id); };
  return (
    <div
      data-tick={tick}
      onClick={select}
      draggable={task.workflow}
      onDragStart={(e) => {
        if (!task.workflow) { e.preventDefault(); return; }
        e.dataTransfer.setData('text/plain', String(task.id));
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={`relative w-full cursor-pointer overflow-hidden rounded-md border p-3 text-left transition-colors ${
        selected ? 'border-edge-strong bg-elevated' : 'border-edge bg-card hover:border-edge-strong hover:bg-elevated'
      } ${dragging ? 'opacity-40' : ''}`}
    >
      {active && <span className="absolute inset-y-0 left-0 w-[2px] bg-ok" />}
      <button type="button" onClick={select} className="w-full touch-manipulation rounded text-left text-[13px] font-semibold leading-snug text-fg focus-visible:outline-2 focus-visible:outline-brand" style={{ paddingLeft: active ? 6 : 0 }}>
        <span className="break-words">{task.issue_title || '(无标题)'}</span>
      </button>
      <div className="mt-2 space-y-1 text-[11px] text-fg-muted">
        <div className="flex min-w-0 items-center gap-2 font-mono">
          <GithubLink
            url={task.issue_url}
            title={task.issue_url}
            onClick={(e) => e.stopPropagation()}
            className="truncate text-info/80 hover:text-info hover:underline"
          >
            {shortRepo(task.repo)}
            {task.source === 'pr' ? ' PR#' : '#'}
            {task.issue_number}
          </GithubLink>
          {generation && <span className="shrink-0 rounded border border-edge px-1 py-px text-[10px] text-fg-dim">{generation}</span>}
        </div>
        <div className="flex items-center gap-2">
          <span className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap ${tone}`}>
            {task.workflow ? <WorkflowIcon state={workflowState} /> : <StatusIcon phase={phase} />}
            {stateText}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-3">
            {task.workflow && active ? (
              <span className={`flex items-center gap-1 whitespace-nowrap tabular-nums ${phaseTextClass(active.phase)}`}>
                <StatusIcon phase={active.phase} size={12} />
                {phaseLabel(active.phase)} {fmtDur(active.started_at)}
              </span>
            ) : task.workflow && workflowState === 'In Progress' ? (
              <span className="whitespace-nowrap text-[10.5px] text-fg-dim">等待派发</span>
            ) : active ? (
              <span className="flex items-center gap-1 whitespace-nowrap tabular-nums text-ok">
                <Clock className="size-3" />
                {fmtDur(active.started_at)}
              </span>
            ) : (
              <span
                className="flex items-center gap-1 whitespace-nowrap tabular-nums text-fg-dim"
                title={`最后更新：${fmtTime(task.updated_at)}`}
              >
                <Clock className="size-3" />
                {fmtDur(task.updated_at)}前
              </span>
            )}
            {task.pr_url && (
              <GithubLink
                url={task.pr_url}
                title={task.pr_url}
                onClick={(e) => e.stopPropagation()}
                className="flex items-center gap-1 text-info/80 hover:text-info"
              >
                <GitPullRequest className="size-3.5" />
                {task.source === 'issue' && prNumber && <span className="tabular-nums">#{prNumber}</span>}
              </GithubLink>
            )}
          </span>
        </div>
      </div>
      <TaskAttention attention={task.attention} compact />
      {!task.workflow && <IntakeActions task={task} onState={state => onIntakeChanged(task.id, state)} onChanged={onChanged} onToast={onToast} />}
    </div>
  );
}
