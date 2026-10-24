import type { TaskSummary } from './api';

export default function TaskAttention({ attention, compact = false }: { attention: TaskSummary['attention']; compact?: boolean }) {
  if (!attention) return null;
  return <div className="mt-3 rounded-md border border-warn/25 bg-warn/5 px-3 py-2 text-[11px] leading-relaxed">
    <p className="font-medium text-warn">{attention.summary}</p>
    <p className="mt-1 text-fg-muted">{attention.next_step}</p>
    {!compact && attention.detail && <details className="mt-2 text-fg-muted"><summary className="cursor-pointer">查看具体原因</summary><p className="mt-2 whitespace-pre-wrap break-words">{attention.detail}</p></details>}
  </div>;
}
