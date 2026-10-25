export type EntryKind = 'say' | 'think' | 'tool' | 'mark';

export interface Entry {
  id: number;
  kind: EntryKind;
  /** Say/think text, the tool header, or a marker label. */
  text: string;
  /** Tool stdout/stderr, or a thinking block's full text when collapsed. */
  output?: string;
  meta?: string;
  failed?: boolean;
  done?: boolean;
}

export function preview(value: unknown, max = 200): string {
  if (value == null) return '';
  let s: string;
  try { s = typeof value === 'string' ? value : JSON.stringify(value); } catch { s = String(value); }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  const content = (result as { content?: { type?: string; text?: string }[] } | null)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!)
    .join('\n');
}

export function clip(text: string, limit: number): { text: string; cut: boolean } {
  if (!limit || text.length <= limit) return { text, cut: false };
  return { text: text.slice(0, limit), cut: true };
}

export function lines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Fold pi's JSONL event stream into a terminal-like transcript.
 *
 * pi streams `message_update` deltas (thinking/text) and emits the tool result
 * once per call; `message_end` repeats the final blocks, so the deltas are
 * authoritative and the end record is only a fallback for streams that started
 * before this view attached.
 */
export class Transcript {
  entries: Entry[] = [];
  private nextId = 1;
  private tools = new Map<string, Entry>();
  private sawText = false;
  private sawThinking = false;
  private turns = 0;
  /** Role of the message currently streaming; only assistant turns are rendered. */
  private role: string | null = null;

  constructor(private readonly maxEntries: number, private readonly trimAt: number) {}

  reset() {
    this.entries = [];
    this.tools.clear();
    this.sawText = false;
    this.sawThinking = false;
    this.turns = 0;
    this.role = null;
  }

  private add(kind: EntryKind, text: string): Entry {
    const entry: Entry = { id: this.nextId++, kind, text };
    this.entries.push(entry);
    if (this.entries.length > this.trimAt) this.entries = this.entries.slice(-this.maxEntries);
    return entry;
  }

  private openTail(kind: EntryKind): Entry | null {
    const last = this.entries[this.entries.length - 1];
    return last && last.kind === kind && !last.done ? last : null;
  }

  private closeTail(kind: EntryKind) {
    const last = this.entries[this.entries.length - 1];
    if (last && last.kind === kind) last.done = true;
  }

  mark(text: string) {
    this.add('mark', text);
  }

  private append(kind: 'say' | 'think', delta: string) {
    const tail = this.openTail(kind);
    if (tail) tail.text += delta;
    else this.add(kind, delta);
  }

  private tool(id: string, name: string, args: unknown): Entry {
    const entry = this.add('tool', `${name} ${preview(args)}`.trim());
    this.tools.set(id, entry);
    return entry;
  }

  feed(line: string) {
    let ev: Record<string, any>;
    try { ev = JSON.parse(line) as Record<string, any>; } catch { return; }
    const type = ev.type;
    if (type === 'message_start') {
      this.role = typeof ev.message?.role === 'string' ? ev.message.role : null;
      if (this.role === 'assistant') { this.sawText = false; this.sawThinking = false; }
      return;
    }
    if (type === 'message_update') {
      if (this.role !== 'assistant') return;
      const d = ev.assistantMessageEvent;
      switch (d?.type) {
        case 'thinking_delta':
          if (typeof d.delta === 'string') { this.sawThinking = true; this.append('think', d.delta); }
          return;
        case 'thinking_end':
          this.closeTail('think');
          return;
        case 'text_delta':
          if (typeof d.delta === 'string') { this.sawText = true; this.append('say', d.delta); }
          return;
        case 'text_end':
          this.closeTail('say');
          return;
        default:
          return; // toolcall_* deltas are JSON fragments; the tool events carry the result
      }
    }
    if (type === 'message_end' && ev.message?.role === 'assistant') {
      const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
      if (!this.sawThinking) {
        const thinking = blocks.filter((c: any) => c?.type === 'thinking' && typeof c.thinking === 'string').map((c: any) => c.thinking).join('\n');
        if (thinking) this.add('think', thinking).done = true;
      }
      if (!this.sawText) {
        const text = blocks.filter((c: any) => c?.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('\n');
        if (text) this.add('say', text).done = true;
      }
      return;
    }
    if (type === 'tool_execution_start') {
      this.tool(String(ev.toolCallId ?? ''), String(ev.toolName ?? 'tool'), ev.args);
      return;
    }
    if (type === 'tool_execution_update') {
      const entry = this.tools.get(String(ev.toolCallId ?? ''));
      const text = resultText(ev.partialResult);
      if (entry && text) entry.output = text; // pi sends the accumulated output, not a delta
      return;
    }
    if (type === 'tool_execution_end') {
      let entry = this.tools.get(String(ev.toolCallId ?? ''));
      if (!entry) entry = this.tool(String(ev.toolCallId ?? ''), String(ev.toolName ?? 'tool'), ev.args);
      entry.done = true;
      entry.failed = ev.isError === true;
      entry.meta = `${ev.durationMs ?? '?'}ms`;
      const text = resultText(ev.result);
      if (text) entry.output = text;
      return;
    }
    if (type === 'agent_start') { this.mark('agent 启动'); return; }
    if (type === 'turn_start') { this.turns += 1; this.mark(`第 ${this.turns} 轮`); return; }
    if (type === 'agent_settled') { this.mark(`本轮结束${ev.aborted ? '（已中止）' : ''}`); return; }
    if (type === 'auto_retry_start') { this.mark(`重试 ${ev.attempt}/${ev.maxAttempts}: ${preview(ev.errorMessage, 120)}`); return; }
    if (type === 'compaction_start') { this.mark(`上下文压缩（${ev.reason ?? ''}）`); return; }
  }
}
