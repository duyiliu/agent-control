import { useEffect, useRef, useState } from 'react';
import { FileText, Pause, Play } from 'lucide-react';
import { fetchTail } from './api';

type EntryKind = 'say' | 'tool' | 'ok' | 'err' | 'mark';
interface Entry {
  kind: EntryKind;
  text: string;
}

function preview(value: unknown, max = 140): string {
  if (value == null) return '';
  let s: string;
  try { s = typeof value === 'string' ? value : JSON.stringify(value); } catch { s = String(value); }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Turn pi's JSONL event stream into readable transcript lines. */
function toEntries(lines: string[]): Entry[] {
  const out: Entry[] = [];
  const push = (kind: EntryKind, text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (kind === 'say' && last?.kind === 'say' && last.text.length < 4000) {
      last.text += text;
      return;
    }
    out.push({ kind, text });
  };

  let sawDelta = false;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(raw); } catch { continue; }

    if (ev.type === 'message_start' && ev.message?.role === 'assistant') { sawDelta = false; continue; }
    if (ev.type === 'message_update') {
      const d = ev.assistantMessageEvent;
      if (d?.type === 'text_delta' && typeof d.delta === 'string') {
        sawDelta = true;
        push('say', d.delta);
      }
      continue;
    }
    if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
      const text = (Array.isArray(ev.message.content) ? ev.message.content : [])
        .filter((c: any) => c?.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
      if (!sawDelta && text) push('say', text);
      push('say', '\n');
      continue;
    }
    if (ev.type === 'tool_execution_start') {
      push('tool', `▶ ${ev.toolName ?? 'tool'} ${preview(ev.args)}`);
      continue;
    }
    if (ev.type === 'tool_execution_end') {
      push(ev.isError ? 'err' : 'ok', `${ev.isError ? '✗' : '✓'} ${ev.toolName ?? 'tool'} ${ev.durationMs ?? '?'}ms`);
      continue;
    }
    if (ev.type === 'agent_settled') { push('mark', `— 本轮结束${ev.aborted ? '（已中止）' : ''}`); continue; }
    if (ev.type === 'agent_start') { push('mark', '— agent 启动'); continue; }
    if (ev.type === 'auto_retry_start') { push('mark', `— 重试 ${ev.attempt}/${ev.maxAttempts}: ${preview(ev.errorMessage)}`); continue; }
    if (ev.type === 'compaction_start') { push('mark', `— 上下文压缩（${ev.reason}）`); continue; }
  }
  return out;
}

const KIND_CLASS: Record<EntryKind, string> = {
  say: 'text-fg whitespace-pre-wrap',
  tool: 'text-tool',
  ok: 'text-ok/80',
  err: 'text-danger',
  mark: 'text-fg-dim',
};

const MAX_ENTRIES = 400;

export default function LiveLog(props: {
  runId: string;
  active: boolean;
  onOpenArtifact: (path: string) => void;
}) {
  const { runId, active, onOpenArtifact } = props;
  const [open, setOpen] = useState(active);
  const [following, setFollowing] = useState(true);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const offset = useRef<number | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    offset.current = null;
    setEntries([]);
    setFile(null);
    setPending(0);
    setError(null);
  }, [runId]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const res = await fetchTail(runId, offset.current, file);
        if (!alive) return;
        if (res.file !== file) {
          // A new turn opened a fresh log file: start over rather than mix runs.
          offset.current = null;
          setFile(res.file);
          setEntries([]);
          return;
        }
        offset.current = res.offset;
        setPending(res.pending);
        setError(null);
        const fresh = res.chunk ? res.chunk.split('\n').filter((l) => l.trim()) : [];
        if (fresh.length) {
          const next = toEntries(fresh);
          setEntries((prev) => {
            const merged = [...prev];
            for (const e of next) {
              const last = merged[merged.length - 1];
              if (e.kind === 'say' && last?.kind === 'say' && last.text.length < 4000) {
                merged[merged.length - 1] = { ...last, text: last.text + e.text };
              } else {
                merged.push(e);
              }
            }
            return merged.slice(-MAX_ENTRIES);
          });
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) timer = setTimeout(tick, following ? 1500 : 4000);
      }
    };

    void tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [open, runId, file, following]);

  useEffect(() => {
    if (!following || !open) return;
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, following, open]);

  return (
    <div className="border-t border-edge">
      <div className="flex items-center gap-2 px-4 py-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-[11px] font-medium text-fg-muted hover:text-fg"
        >
          <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
          实时日志
        </button>
        {open && file && <span className="font-mono text-[10px] text-fg-dim">{file}</span>}
        {open && pending > 0 && (
          <span className="font-mono text-[10px] text-warn">已缓冲 +{pending}B</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {open && (
            <button
              onClick={() => setFollowing((v) => !v)}
              className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${
                following
                  ? 'border-ok/30 text-ok hover:bg-ok/10'
                  : 'border-edge-strong text-fg-muted hover:bg-elevated'
              }`}
              title={following ? '暂停自动滚动' : '恢复自动滚动'}
            >
              {following ? <Pause className="size-2.5" /> : <Play className="size-2.5" />}
              {following ? '跟随中' : '已暂停'}
            </button>
          )}
          {file && (
            <button
              onClick={() => onOpenArtifact(`artifacts/${runId}/${file}`)}
              className="flex items-center gap-1 text-[10px] text-info hover:underline"
              title="打开原始 JSONL"
            >
              <FileText className="size-3" />
              原始
            </button>
          )}
        </div>
      </div>

      {open && (
        <div
          ref={box}
          className="mx-3.5 mb-2.5 max-h-72 overflow-y-auto rounded border border-edge bg-sunken px-2.5 py-2 font-mono text-[10.5px] leading-relaxed"
        >
          {error && <div className="text-danger">{error}</div>}
          {!error && entries.length === 0 && (
            <div className="py-3 text-center text-fg-dim">
              {active ? '等待 agent 输出…' : '本次运行没有 agent 日志'}
            </div>
          )}
          {entries.map((e, i) => (
            <div key={i} className={KIND_CLASS[e.kind]}>
              {e.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
