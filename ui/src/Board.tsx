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

  // Only active cards are draggable, and only into Needs Attention (= stop).
  const draggedTask = draggingId !== null ? (visible.find((t) => t.id === draggingId) ?? null) : null;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-4 pt-3">
        <Chip active={activeFilter === null} onClick={() => setFilter(null)}>
          全部
          <Count n={tasks.length} />
        </Chip>
        {repoNames.map((repo) => (
          <Chip key={repo} active={activeFilter === repo} onClick={() => setFilter(repo)}>
            {repo}
            <Count n={repos.get(repo)!} />
          </Chip>
        ))}
        <Chip active={disposition === 'normal'} onClick={() => setDisposition('normal')}>任务</Chip>
        <Chip active={disposition === 'deferred'} onClick={() => setDisposition('deferred')}>暂缓 <Count n={deferredCount} /></Chip>
        <Chip active={disposition === 'history'} onClick={() => setDisposition('history')}>无需处理 <Count n={skippedCount} /></Chip>
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-fg-dim" />
          <input
            ref={searchRef}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setKeyword('');
                e.currentTarget.blur();
              }
            }}
            placeholder="搜索  /"
            className="w-52 rounded-md border border-edge bg-card py-1 pl-7.5 pr-2.5 text-[11px] text-fg outline-none transition-colors placeholder:text-fg-dim focus:border-edge-strong"
          />
        </div>
      </div>
      {visible.length === 0 && tasks.length > 0 && (
        <div className="px-4 pt-3 text-[11px] text-fg-dim">没有匹配当前筛选或搜索的任务。</div>
      )}
      <div className="flex flex-1 gap-3 overflow-x-auto p-4">
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
              className={`flex max-h-full w-[288px] shrink-0 flex-col rounded-lg border bg-panel transition-colors ${
                isDropTarget ? 'border-danger/40 bg-danger/[0.04]' : 'border-edge'
              }`}
            >
              <header className="flex items-center gap-2 px-3 py-2.5 text-[12px] font-medium text-fg-muted">
                <span
                  className={`size-1.5 rounded-full ${g.dot} ${g.key === 'active' ? '[animation:pulse-dot_1.5s_infinite]' : ''}`}
                />
                {g.label}
                <span className="ml-auto rounded border border-edge px-1.5 py-px text-[10.5px] tabular-nums text-fg-dim">
                  {items.length}
                </span>
              </header>
              <div className="flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
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
      className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors ${
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
      role="button"
      tabIndex={0}
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
      onClick={() => onSelect(task.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect(task.id);
      }}
      title={draggable ? '拖到「需要处理」即可停止' : undefined}
      className={`relative w-full cursor-pointer overflow-hidden rounded-md border p-3 text-left transition-colors ${
        selected ? 'border-edge-strong bg-elevated' : 'border-edge bg-card hover:border-edge-strong hover:bg-elevated'
      } ${dragging ? 'opacity-40' : ''}`}
    >
      {active && <span className="absolute inset-y-0 left-0 w-[2px] bg-ok" />}
      <div
        className="text-[13px] font-medium leading-snug text-fg"
        style={{ paddingLeft: active ? 6 : 0 }}
      >
        {/* No clamping and no hover dependency: a long PR name wraps instead
            of being hidden, which also works on touch screens. */}
        <span className="break-words">{task.issue_title || '(无标题)'}</span>
      </div>
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
