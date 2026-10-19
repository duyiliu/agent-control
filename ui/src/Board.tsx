import { useState } from 'react';
import { Clock, GitPullRequest } from 'lucide-react';
import type { TaskSummary } from './api';
import { fmtDur, GROUPS, groupOf, phaseLabel, phaseTextClass, type GroupKey } from './groups';
import StatusIcon from './StatusIcon';

const EMPTY_HINT: Partial<Record<GroupKey, string>> = {
  queued: 'Label an issue agent-ready to queue it',
  active: 'Nothing running',
};

const FILTER_KEY = 'ac-repo-filter';

export default function Board(props: {
  tasks: TaskSummary[] | null;
  tick: number;
  selected: number | null;
  onSelect: (id: number) => void;
}) {
  const { tasks, tick, selected, onSelect } = props;
  const [repoFilter, setRepoFilter] = useState<string | null>(() => localStorage.getItem(FILTER_KEY));

  if (!tasks) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-zinc-600">loading…</div>
    );
  }

  const repos = new Map<string, number>();
  for (const t of tasks) repos.set(t.repo, (repos.get(t.repo) ?? 0) + 1);
  const repoNames = [...repos.keys()].sort();
  // A stored filter for a repo with no tasks left falls back to all.
  const activeFilter = repoFilter && repos.has(repoFilter) ? repoFilter : null;

  const setFilter = (repo: string | null) => {
    setRepoFilter(repo);
    if (repo) localStorage.setItem(FILTER_KEY, repo);
    else localStorage.removeItem(FILTER_KEY);
  };

  const visible = activeFilter ? tasks.filter((t) => t.repo === activeFilter) : tasks;
  const byGroup = new Map<GroupKey, TaskSummary[]>();
  for (const g of GROUPS) byGroup.set(g.key, []);
  for (const t of visible) byGroup.get(groupOf(t.status))!.push(t);
  for (const list of byGroup.values()) {
    list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {repoNames.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pt-4">
          <Chip active={activeFilter === null} onClick={() => setFilter(null)}>
            All
            <Count n={tasks.length} />
          </Chip>
          {repoNames.map((repo) => (
            <Chip key={repo} active={activeFilter === repo} onClick={() => setFilter(repo)}>
              {repo}
              <Count n={repos.get(repo)!} />
            </Chip>
          ))}
        </div>
      )}
      <div className="flex flex-1 gap-4 overflow-x-auto p-5">
        {GROUPS.map((g) => {
          const items = byGroup.get(g.key)!;
          return (
            <section
              key={g.key}
              className="flex max-h-full w-[300px] shrink-0 flex-col rounded-xl border border-edge bg-panel"
            >
              <header className="flex items-center gap-2 px-3.5 py-3 text-[13px] font-medium text-zinc-400">
                <span
                  className={`size-2 rounded-full ${g.dot} ${g.key === 'active' ? '[animation:pulse-dot_1.5s_infinite]' : ''}`}
                />
                {g.label}
                <span className="ml-auto rounded-md bg-zinc-800/80 px-1.5 py-0.5 text-[11px] tabular-nums text-zinc-400">
                  {items.length}
                </span>
              </header>
              <div className="flex-1 space-y-2 overflow-y-auto px-2.5 pb-3">
                {items.map((t) => (
                  <TaskCard key={t.id} task={t} tick={tick} selected={selected === t.id} onSelect={onSelect} />
                ))}
                {items.length === 0 && (
                  <div className="rounded-lg border border-dashed border-edge px-3 py-6 text-center text-xs text-zinc-600">
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
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
        props.active
          ? 'border-brand/50 bg-brand/15 text-[#9ba3ee]'
          : 'border-edge text-zinc-400 hover:border-edge-strong hover:text-zinc-200'
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
}) {
  const { task, tick, selected, onSelect } = props;
  const active = task.active_run;
  const phase = active?.phase ?? task.status;
  return (
    <div
      data-tick={tick}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(task.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect(task.id);
      }}
      className={`relative w-full cursor-pointer overflow-hidden rounded-lg border p-3 text-left transition-colors ${
        selected
          ? 'border-edge-strong bg-[#1a1f28]'
          : 'border-edge bg-card hover:border-edge-strong hover:bg-[#181d26]'
      }`}
    >
      {active && <span className="absolute inset-y-0 left-0 w-[3px] bg-emerald-400" />}
      <div className={`text-[13.5px] font-medium leading-snug text-zinc-100 ${active ? '' : ''}`} style={{ paddingLeft: active ? 6 : 0 }}>
        <span className="line-clamp-2">{task.issue_title || '(untitled)'}</span>
      </div>
      <div className="mt-2.5 flex items-center gap-2 text-[11px] text-zinc-500">
        <span className="min-w-0 flex-1 truncate font-mono" title={task.repo}>
          {shortRepo(task.repo)}#{task.issue_number}
        </span>
        <span className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap ${phaseTextClass(phase)}`}>
          <StatusIcon phase={phase} />
          {phaseLabel(phase)}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {active && (
            <span className="flex items-center gap-1 whitespace-nowrap tabular-nums text-emerald-300/80">
              <Clock className="size-3" />
              {fmtDur(active.started_at)}
            </span>
          )}
          {task.pr_url && (
            <a
              href={task.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              title={task.pr_url}
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1 text-sky-300/80 hover:text-sky-300"
            >
              <GitPullRequest className="size-3.5" />
            </a>
          )}
        </span>
      </div>
    </div>
  );
}
