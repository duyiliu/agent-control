import { useEffect, useRef, useState } from 'react';
import { Clock, GitPullRequest, Search } from 'lucide-react';
import type { IntakeState, TaskSummary } from './api';
import { fmtDur, fmtTime, GROUPS, groupOf, isActivePhase, phaseLabel, phaseTextClass, type GroupKey } from './groups';
import { buildRepoCounts } from './repo-filters';
import StatusIcon from './StatusIcon';
import IntakeActions from './IntakeActions';
import type { Toast } from './App';

const EMPTY_HINT: Partial<Record<GroupKey, string>> = {
  queued: '自动接手项目的新 Issue 会在这里排队',
  active: '暂无运行中的任务',
  reviewing: '暂无等待或正在审查的 PR',
  merging: '暂无自动合并中的 PR',
  human: '暂无需要人工处理的任务',
};

const FILTER_KEY = 'ac-repo-filter';

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
  const { tasks, projectRepos, tick, selected, onSelect, onStop, onIntakeChanged, onChanged, onToast } = props;
  const [disposition, setDisposition] = useState<'normal' | 'deferred' | 'history'>('normal');
  const [mobileGroup, setMobileGroup] = useState<GroupKey | null>(null);
  const [repoFilter, setRepoFilter] = useState<string | null>(() => localStorage.getItem(FILTER_KEY));
  const [keyword, setKeyword] = useState('');
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

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

  if (!tasks) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-fg-dim">加载中…</div>
    );
  }

  const repos = buildRepoCounts(tasks, projectRepos);
  const repoNames = [...repos.keys()].sort();
  // A stored filter for a repo that's neither configured nor has tasks falls back to all.
  const activeFilter = repoFilter && repos.has(repoFilter) ? repoFilter : null;

  const setFilter = (repo: string | null) => {
    setRepoFilter(repo);
    if (repo) localStorage.setItem(FILTER_KEY, repo);
    else localStorage.removeItem(FILTER_KEY);
  };

  // `#25` is how people refer to issues; strip it so the number still matches.
  const kw = keyword.trim().toLowerCase().replace(/^#/, '');
  let visible = activeFilter ? tasks.filter((t) => t.repo === activeFilter) : tasks;
  if (kw) {
    visible = visible.filter(
      (t) =>
        t.issue_title.toLowerCase().includes(kw) ||
        String(t.issue_number).includes(kw) ||
        t.repo.toLowerCase().includes(kw),
    );
  }

  const hasDisposition = (t: TaskSummary) => !t.active_run && !['COMPLETED', 'MERGING', 'AWAITING_REVIEW', 'AWAITING_HUMAN'].includes(t.status);
  const deferredCount = visible.filter(t => hasDisposition(t) && t.intake?.kind === 'deferred').length;
  const skippedCount = visible.filter(t => hasDisposition(t) && t.intake?.kind === 'skipped').length;
  visible = visible.filter(t => disposition === 'deferred' ? hasDisposition(t) && t.intake?.kind === 'deferred' : disposition === 'history' ? hasDisposition(t) && t.intake?.kind === 'skipped' : !hasDisposition(t) || !['deferred', 'skipped'].includes(t.intake?.kind ?? ''));
  const displayGroups = disposition === 'normal' ? GROUPS : [{ key: 'blocked' as const, label: disposition === 'deferred' ? '暂缓' : '无需处理 · 历史', dot: 'bg-fg-dim' }];
  const byGroup = new Map<GroupKey, TaskSummary[]>();
  for (const g of GROUPS) byGroup.set(g.key, []);
  // MERGING owns the card even while a repair run works: landing is in progress.
  const phaseOf = (t: TaskSummary) => (t.status === 'MERGING' ? 'MERGING' : (t.active_run?.phase ?? t.status));
  for (const t of visible) {
    const key = disposition !== 'normal' ? 'blocked' : hasDisposition(t) && t.intake && (t.intake.kind === 'human' || t.intake.locked || t.intake.external_hold || t.intake.external_needs || t.intake.error || t.intake.pending) ? 'human' : groupOf(phaseOf(t));
    byGroup.get(key)!.push(t);
  }
  for (const list of byGroup.values()) {
    list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  const defaultMobileGroup = displayGroups.find(g => byGroup.get(g.key)!.length)?.key ?? displayGroups[0]!.key;
  const selectedMobileGroup = mobileGroup && displayGroups.some(g => g.key === mobileGroup) ? mobileGroup : defaultMobileGroup;

  // Only active cards are draggable, and only into Needs Attention (= stop).
  const draggedTask = draggingId !== null ? (visible.find((t) => t.id === draggingId) ?? null) : null;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="z-10 shrink-0 border-b border-edge bg-canvas/95 px-3 py-2 backdrop-blur-sm sm:px-4 sm:pt-3">
        <div className="flex min-w-0 gap-1.5 overflow-x-auto pb-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:flex-wrap lg:overflow-visible">
          <Chip active={activeFilter === null} onClick={() => setFilter(null)}>全部<Count n={tasks.length} /></Chip>
          {repoNames.map((repo) => (
            <Chip key={repo} active={activeFilter === repo} onClick={() => setFilter(repo)}>
              <span className="max-w-[68vw] truncate sm:max-w-none">{repo}</span><Count n={repos.get(repo)!} />
            </Chip>
          ))}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 pt-1 lg:flex-wrap">
          <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:contents">
            <Chip active={disposition === 'normal'} onClick={() => { setDisposition('normal'); setMobileGroup(null); }}>任务</Chip>
            <Chip active={disposition === 'deferred'} onClick={() => { setDisposition('deferred'); setMobileGroup(null); }}>暂缓 <Count n={deferredCount} /></Chip>
            <Chip active={disposition === 'history'} onClick={() => { setDisposition('history'); setMobileGroup(null); }}>无需处理 <Count n={skippedCount} /></Chip>
          </div>
          <div className="group relative w-10 shrink-0 transition-[width] focus-within:w-40 [&:has(input:not(:placeholder-shown))]:w-40 sm:w-52">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-fg-dim" />
            <input
              ref={searchRef}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}

              onKeyDown={(e) => { if (e.key === 'Escape') { setKeyword(''); e.currentTarget.blur(); } }}
              aria-label="搜索任务"
              placeholder="搜索"
              className="w-full rounded-md border border-edge bg-card py-1.5 pl-7.5 pr-2 text-[11px] text-fg outline-none placeholder:text-fg-dim focus:border-edge-strong"
            />
          </div>
        </div>
      </div>
      <div role="tablist" aria-label="任务状态" className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-edge bg-panel/50 px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:hidden">
        {displayGroups.map(g => {
          const count = byGroup.get(g.key)!.length;
          const active = selectedMobileGroup === g.key;
          return <button key={g.key} type="button" role="tab" aria-selected={active} onClick={() => setMobileGroup(g.key)} className={`flex min-h-10 shrink-0 items-center gap-2 rounded-md border px-3 text-xs font-medium ${active ? 'border-brand/40 bg-brand/10 text-brand' : 'border-edge bg-card text-fg-muted'}`}>
            <span className={`size-1.5 rounded-full ${g.dot}`} />{g.label}<span className="tabular-nums opacity-70">{count}</span>
          </button>;
        })}
      </div>
      {visible.length === 0 && tasks.length > 0 && (
        <div className="px-3 pt-3 text-[11px] text-fg-dim sm:px-4">没有匹配当前筛选或搜索的任务。</div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 lg:flex-row lg:gap-3 lg:overflow-x-auto lg:overflow-y-hidden lg:p-4">
        {displayGroups.map((g) => {
          const items = byGroup.get(g.key)!;
          const isDropTarget = g.key === 'blocked' && draggedTask !== null;
          return (
            <section
              key={g.key}
              onDragOver={
                isDropTarget
                  ? (e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                    }
                  : undefined
              }
              onDrop={
                isDropTarget
                  ? (e) => {
                      e.preventDefault();
                      onStop(draggedTask);
                      setDraggingId(null);
                    }
                  : undefined
              }
              className={`flex min-h-0 w-full shrink-0 flex-col rounded-lg border bg-panel lg:max-h-full lg:w-[288px] ${g.key === selectedMobileGroup ? 'flex' : 'hidden'} lg:flex ${
                isDropTarget ? 'border-danger/40 bg-danger/[0.04]' : 'border-edge'
              }`}
            >
              <header className="flex shrink-0 items-center gap-2 px-3 py-2.5 text-[12px] font-medium text-fg-muted">
                <span
                  className={`size-1.5 rounded-full ${g.dot} ${g.key === 'active' ? '[animation:pulse-dot_1.5s_infinite]' : ''}`}
                />
                {g.label}
                <span className="ml-auto rounded border border-edge px-1.5 py-px text-[10.5px] tabular-nums text-fg-dim">
                  {items.length}
                </span>
              </header>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-2 pb-[max(.5rem,env(safe-area-inset-bottom))]">
                {items.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    tick={tick}
                    selected={selected === t.id}
                    onSelect={onSelect}
                    draggable={isActivePhase(phaseOf(t))}
                    dragging={draggingId === t.id}
                    onDragStart={() => setDraggingId(t.id)}
                    onDragEnd={() => setDraggingId(null)}
                    onIntakeChanged={onIntakeChanged}
                    onChanged={onChanged}
                    onToast={onToast}
                  />
                ))}
                {items.length === 0 && (
                  <div className="rounded-md border border-dashed border-edge px-3 py-6 text-center text-[11px] text-fg-dim">
                    {EMPTY_HINT[g.key] ?? '—'}
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
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
  onSelect: (id: number) => void;
  draggable: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onIntakeChanged: (id: number, state: IntakeState) => void;
  onChanged: () => void;
  onToast: (toast: Toast) => void;
}) {
  const { task, tick, selected, onSelect, draggable, dragging, onDragStart, onDragEnd, onIntakeChanged, onChanged, onToast } = props;
  const active = task.active_run;
  const phase = active?.phase ?? task.status;
  const disposition = !active && !['COMPLETED', 'MERGING', 'AWAITING_REVIEW', 'AWAITING_HUMAN'].includes(task.status) ? task.intake : null;
  return (
    <div
      data-tick={tick}
      draggable={draggable}
      onDragStart={
        draggable
          ? (e) => {
              e.dataTransfer.setData('text/plain', String(task.id));
              e.dataTransfer.effectAllowed = 'move';
              onDragStart();
            }
          : undefined
      }
      onDragEnd={draggable ? onDragEnd : undefined}
      title={draggable ? '拖到「需要处理」即可停止' : undefined}
      className={`relative w-full overflow-hidden rounded-md border p-3 text-left transition-colors ${
        selected ? 'border-edge-strong bg-elevated' : 'border-edge bg-card hover:border-edge-strong hover:bg-elevated'
      } ${dragging ? 'opacity-40' : ''}`}
    >
      {active && <span className="absolute inset-y-0 left-0 w-[2px] bg-ok" />}
      <button type="button" onClick={() => onSelect(task.id)} className="w-full touch-manipulation rounded text-left text-[13px] font-semibold leading-snug text-fg focus-visible:outline-2 focus-visible:outline-brand" style={{ paddingLeft: active ? 6 : 0 }}>
        <span className="break-words">{task.issue_title || '(无标题)'}</span>
      </button>
      <div className="mt-2 space-y-1 text-[11px] text-fg-muted">
        <div
          className="truncate font-mono"
          title={`${task.repo}${task.source === 'pr' ? ' PR#' : '#'}${task.issue_number}`}
        >
          <a
            href={`https://github.com/${task.repo}`}
            target="_blank"
            rel="noopener noreferrer"
            title={`https://github.com/${task.repo}`}
            onClick={(e) => e.stopPropagation()}
            className="text-info/80 hover:text-info hover:underline"
          >
            {shortRepo(task.repo)}
          </a>
          {task.source === 'pr' ? ' PR#' : '#'}
          {task.issue_number}
        </div>
        <div className="flex items-center gap-2">
          <span className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap ${phaseTextClass(phase)}`}>
            <StatusIcon phase={phase} />
            {disposition?.kind === 'deferred' ? '暂缓' : disposition?.kind === 'skipped' ? '无需处理' : disposition?.kind === 'human' || disposition?.locked || disposition?.external_hold || disposition?.external_needs ? '待人工' : phaseLabel(phase)}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-3">
            {active ? (
              <span className="flex items-center gap-1 whitespace-nowrap tabular-nums text-ok">
                <Clock className="size-3" />
                {fmtDur(active.started_at)}
              </span>
            ) : (
              <span
                className="flex items-center gap-1 whitespace-nowrap tabular-nums text-fg-dim"
                title={`最后处理：${fmtTime(task.updated_at)}`}
              >
                <Clock className="size-3" />
                {fmtDur(task.updated_at)}前
              </span>
            )}
            {task.pr_url && (
              <a
                href={task.pr_url}
                target="_blank"
                rel="noopener noreferrer"
                title={task.pr_url}
                onClick={(e) => e.stopPropagation()}
                className="flex items-center gap-1 text-info/80 hover:text-info"
              >
                <GitPullRequest className="size-3.5" />
              </a>
            )}
          </span>
        </div>
      </div>
      <IntakeActions task={task} onState={state => onIntakeChanged(task.id, state)} onChanged={onChanged} onToast={onToast} />
    </div>
  );
}
