import { useState } from 'react';
import type { TaskSummary } from './api';
import { fmtTime } from './groups';

const PAGE_SIZE = 20;

export default function HistoryList({ tasks, selected, onSelect }: {
  tasks: TaskSummary[]; selected: number | null; onSelect: (id: number) => void;
}) {
  const [page, setPage] = useState(0);
  const sorted = [...tasks].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const rows = sorted.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const button = 'min-h-9 rounded-md border border-edge px-3 text-xs text-fg-muted hover:text-fg disabled:opacity-40';
  return <div className="flex min-h-0 flex-1 flex-col px-3 py-4 sm:px-4">
    <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-edge">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 z-10 bg-panel text-fg-muted"><tr>
          <th scope="col" className="px-4 py-3 font-medium">任务</th>
          <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">项目</th>
          <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium">结果</th>
          <th scope="col" className="hidden px-4 py-3 font-medium sm:table-cell">最后更新</th>
        </tr></thead>
        <tbody className="divide-y divide-edge">
          {rows.map(task => <tr key={task.id} className={selected === task.id ? 'bg-elevated' : 'bg-card hover:bg-elevated'}>
            <td className="max-w-sm px-4 py-3"><button type="button" onClick={() => onSelect(task.id)} className="min-h-9 w-full rounded text-left leading-relaxed text-fg focus-visible:outline-2 focus-visible:outline-brand">
              <span className="mr-2 text-fg-dim">{task.source === 'pr' ? 'PR #' : '#'}{task.issue_number}</span>{task.issue_title || '(无标题)'}
              <span className="mt-1 block break-all text-[11px] text-fg-muted md:hidden">{task.repo}</span>
            </button></td>
            <td className="hidden px-4 py-3 text-fg-muted md:table-cell">{task.repo}</td>
            <td className={`whitespace-nowrap px-4 py-3 ${task.status === 'COMPLETED' ? 'text-ok' : 'text-fg-muted'}`}>{task.status === 'COMPLETED' ? '已完成' : task.status === 'CANCELED' ? '已取消' : task.attention?.kind === 'advisory' ? '评审完成' : '无需处理'}</td>
            <td className="hidden whitespace-nowrap px-4 py-3 text-fg-muted sm:table-cell">{fmtTime(task.updated_at)}</td>
          </tr>)}
          {rows.length === 0 && <tr><td colSpan={4} className="px-4 py-12 text-center text-fg-muted">暂无匹配的历史记录，试试调整项目、结果或搜索条件。</td></tr>}
        </tbody>
      </table>
    </div>
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 pt-3 text-[11px] text-fg-muted">
      <span>共 {tasks.length} 条{tasks.length > 0 && `，显示 ${current * PAGE_SIZE + 1}–${Math.min((current + 1) * PAGE_SIZE, tasks.length)} 条`}</span>
      <div className="flex items-center gap-2"><button type="button" disabled={current === 0} onClick={() => setPage(current - 1)} className={button}>上一页</button><span aria-live="polite">{current + 1} / {pages}</span><button type="button" disabled={current >= pages - 1} onClick={() => setPage(current + 1)} className={button}>下一页</button></div>
    </div>
  </div>;
}
