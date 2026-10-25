import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, FileText, Pause, Play } from 'lucide-react';
import { fetchTail } from './api';
import { clip, lines, Transcript, type Entry, type EntryKind } from './transcript';

const MAX_ENTRIES = 600;
const TRIM_AT = 1200;
const FLUSH_MS = 120;

const KIND_CLASS: Record<EntryKind, string> = {
  say: 'text-fg whitespace-pre-wrap break-words',
  think: 'text-fg-dim italic',
  tool: 'text-tool',
  mark: 'text-fg-dim/70',
};

const LIMITS = [
  { label: '1k', value: 1000 },
  { label: '4k', value: 4000 },
  { label: '16k', value: 16000 },
  { label: '不限', value: 0 },
];

function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch { return fallback; }
}

function store(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

function waitingText(raw: string): string {
  if (raw === 'no agent log yet') return '等待 agent 输出…';
  if (raw === 'no artifacts for run') return '本次运行还没有日志目录';
  if (raw === 'log disappeared') return '日志文件已被清理';
  return raw;
}

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
  const [waiting, setWaiting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(true);
  const [showThinking, setShowThinking] = useState(() => stored('ac.liveLog.thinking', true));
  const [showToolOutput, setShowToolOutput] = useState(() => stored('ac.liveLog.toolOutput', true));
  const [limit, setLimit] = useState(() => stored('ac.liveLog.limit', 4000));
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [transcript] = useState(() => new Transcript(MAX_ENTRIES, TRIM_AT));
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    store('ac.liveLog.thinking', showThinking);
  }, [showThinking]);
  useEffect(() => {
    store('ac.liveLog.toolOutput', showToolOutput);
  }, [showToolOutput]);
  useEffect(() => {
    store('ac.liveLog.limit', limit);
  }, [limit]);

  useEffect(() => {
    transcript.reset();
    setEntries([]);
    setFile(null);
    setPending(0);
    setWaiting(null);
    setError(null);
    setExpanded(new Set());
  }, [runId, transcript]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let es: EventSource | null = null;
    let errors = 0;
    let polling = false;
    let offset: number | null = null;
    let pollFile: string | null = null;

    const schedule = () => {
      if (flushTimer || !alive) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        if (!alive) return;
        setEntries(transcript.entries.slice(-MAX_ENTRIES));
      }, FLUSH_MS);
    };

    const handleChunk = (chunk: string, skipped?: number) => {
      if (skipped) transcript.mark(`已跳过 ${skipped} 字节超大记录`);
      for (const line of chunk.split('\n')) {
        if (line.trim()) transcript.feed(line);
      }
      schedule();
    };

    const startPolling = () => {
      if (polling || !alive) return;
      polling = true;
      setStreaming(false);
      const tick = async () => {
        try {
          const res = await fetchTail(runId, offset, null);
          if (!alive) return;
          if (res.file !== pollFile) {
            pollFile = res.file;
            offset = null;
            transcript.reset();
            setFile(res.file);
            setPending(0);
            schedule();
            return;
          }
          offset = res.offset;
          setPending(res.pending);
          setWaiting(null);
          handleChunk(res.chunk);
        } catch (e) {
          if (alive) setError((e as Error).message);
        } finally {
          if (alive) pollTimer = setTimeout(tick, 1500);
        }
      };
      void tick();
    };

    if (typeof EventSource === 'undefined') {
      startPolling();
    } else {
      es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);
      es.onopen = () => {
        errors = 0;
        setError(null);
        setStreaming(true);
      };
      es.addEventListener('switch', (ev) => {
        const data = JSON.parse((ev as MessageEvent).data) as { file: string };
        transcript.reset();
        setFile(data.file);
        setPending(0);
        setWaiting(null);
        setExpanded(new Set());
        schedule();
      });
      es.addEventListener('chunk', (ev) => {
        const data = JSON.parse((ev as MessageEvent).data) as { chunk: string; pending: number; skipped?: number };
        setWaiting(null);
        setPending(data.pending);
        handleChunk(data.chunk, data.skipped);
      });
      es.addEventListener('status', (ev) => {
        setPending((JSON.parse((ev as MessageEvent).data) as { pending: number }).pending);
      });
      es.addEventListener('waiting', (ev) => {
        setWaiting((JSON.parse((ev as MessageEvent).data) as { error: string }).error);
      });
      es.onerror = () => {
        if (!alive) return;
        errors += 1;
        // A missing route/proxy that refuses SSE closes the stream instead of
        // reconnecting. Do not sit on the error: the polling endpoint still
        // works on an older service.
        const closed = es?.readyState === EventSource.CLOSED;
        if (closed || errors >= 3) {
          es?.close();
          es = null;
          setError(null);
          startPolling();
          return;
        }
        setError('实时连接中断，正在重连…');
      };
    }

    return () => {
      alive = false;
      if (flushTimer) clearTimeout(flushTimer);
      if (pollTimer) clearTimeout(pollTimer);
      es?.close();
    };
  }, [open, runId, transcript]);

  useEffect(() => {
    if (!following || !open) return;
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, following, open]);

  const toggleEntry = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const visible = entries.filter((e) => (e.kind === 'think' ? showThinking : true));

  return (
    <div className="border-t border-edge">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-[11px] font-medium text-fg-muted hover:text-fg"
        >
          <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
          实时日志
        </button>
        {open && file && <span className="font-mono text-[10px] text-fg-dim">{file}</span>}
        {open && !streaming && <span className="font-mono text-[10px] text-warn">轮询模式</span>}
        {open && pending > 0 && (
          <span className="font-mono text-[10px] text-warn">已缓冲 +{pending}B</span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {open && (
            <>
              <Toggle active={showThinking} onClick={() => setShowThinking((v) => !v)} title="显示模型的思考过程">
                思考
              </Toggle>
              <Toggle active={showToolOutput} onClick={() => setShowToolOutput((v) => !v)} title="显示工具输出">
                工具输出
              </Toggle>
              <select
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                title="单条内容上限"
                className="rounded border border-edge-strong bg-sunken px-1 py-0.5 text-[10px] text-fg-muted"
              >
                {LIMITS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
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
            </>
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
          className="mx-3.5 mb-2.5 max-h-96 overflow-y-auto rounded border border-edge bg-sunken px-2.5 py-2 font-mono text-[10.5px] leading-relaxed"
        >
          {error && <div className="text-danger">{error}</div>}
          {!error && waiting && !visible.length && (
            <div className="py-3 text-center text-fg-dim">{waitingText(waiting)}</div>
          )}
          {!error && !waiting && !visible.length && (
            <div className="py-3 text-center text-fg-dim">
              {active ? '等待 agent 输出…' : '本次运行没有 agent 日志'}
            </div>
          )}
          {visible.map((e, i) => (
            <Row
              key={e.id}
              entry={e}
              tail={i === visible.length - 1}
              expanded={expanded.has(e.id)}
              onToggle={() => toggleEntry(e.id)}
              limit={limit}
              showToolOutput={showToolOutput}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Toggle(props: { active: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button
      onClick={props.onClick}
      title={props.title}
      className={`rounded border px-1.5 py-0.5 text-[10px] ${
        props.active
          ? 'border-info/40 text-info hover:bg-info/10'
          : 'border-edge-strong text-fg-dim hover:bg-elevated'
      }`}
    >
      {props.children}
    </button>
  );
}

function Row(props: {
  entry: Entry;
  tail: boolean;
  expanded: boolean;
  onToggle: () => void;
  limit: number;
  showToolOutput: boolean;
}) {
  const { entry, tail, expanded, onToggle, limit, showToolOutput } = props;

  if (entry.kind === 'mark') {
    return <div className="my-1 text-[10px] text-fg-dim/70">— {entry.text}</div>;
  }

  if (entry.kind === 'tool') {
    const full = entry.output ?? '';
    const body = expanded ? { text: full, cut: false } : clip(full, limit);
    // The newest entry streams uncollapsed: a terminal does not hide the line
    // it is writing. Older entries fold after 12 lines.
    const folded = !expanded && !tail && lines(full) > 12;
    return (
      <div className="my-0.5">
        <div className={KIND_CLASS.tool}>▶ {entry.text}</div>
        {showToolOutput && full && (
          <div className="ml-3 mt-0.5 border-l border-edge pl-2 text-fg-muted">
            <div className="whitespace-pre-wrap break-words">
              {folded ? body.text.split('\n').slice(0, 12).join('\n') : body.text}
            </div>
            {(folded || body.cut) && (
              <button onClick={onToggle} className="mt-0.5 flex items-center gap-1 text-[10px] text-info hover:underline">
                {folded && <ChevronRight className="size-2.5" />}
                {expanded ? '收起' : `展开全部（${lines(full)} 行 / ${full.length} 字符）`}
              </button>
            )}
          </div>
        )}
        {entry.meta && (
          <div className={`ml-3 text-[10px] ${entry.failed ? 'text-danger' : 'text-ok/70'}`}>
            {entry.failed ? '✗' : '✓'} {entry.meta}
          </div>
        )}
      </div>
    );
  }

  if (entry.kind === 'think') {
    const body = expanded ? { text: entry.text, cut: false } : clip(entry.text, limit);
    const folded = !expanded && !tail && lines(entry.text) > 12;
    return (
      <div className="my-1 border-l-2 border-edge-strong/60 pl-2">
        <div className="flex items-center gap-1 text-[10px] not-italic text-fg-dim/70">
          <span>思考</span>
          <span>· {lines(entry.text)} 行</span>
          {(folded || body.cut) && (
            <button onClick={onToggle} className="flex items-center gap-0.5 text-info hover:underline">
              <ChevronDown className={`size-2.5 ${expanded ? 'rotate-180' : ''}`} />
              {expanded ? '收起' : '展开'}
            </button>
          )}
        </div>
        <div className={KIND_CLASS.think}>
          {folded ? body.text.split('\n').slice(0, 12).join('\n') : body.text}
        </div>
      </div>
    );
  }

  const body = clip(entry.text, limit);
  return (
    <div className={KIND_CLASS.say}>
      {body.text}
      {body.cut && <span className="text-fg-dim"> …（截断）</span>}
    </div>
  );
}
