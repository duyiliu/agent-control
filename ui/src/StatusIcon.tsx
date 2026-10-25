import type { Phase, WorkflowState } from './api';
import { isActivePhase, phaseHex, workflowHex } from './groups';

/**
 * Linear-style 14px status glyphs: hollow ring (queued), rotating
 * three-quarter arc (in progress), filled check (done), slash (canceled),
 * exclamation (needs attention), cross (failed).
 */
export default function StatusIcon(props: { phase: Phase; size?: number; className?: string }) {
  const { phase, size = 14, className } = props;
  const color = phaseHex(phase);
  const common = { fill: 'none', stroke: color, strokeWidth: 1.6 } as const;

  let glyph: React.ReactNode;
  if (isActivePhase(phase)) {
    glyph = (
      <>
        <circle cx="8" cy="8" r="5.6" {...common} opacity={0.35} />
        <circle
          cx="8"
          cy="8"
          r="5.6"
          fill="none"
          stroke={color}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeDasharray="26 35.2"
          transform="rotate(-90 8 8)"
          style={{ transformOrigin: '8px 8px', animation: 'spin-slow 1.6s linear infinite' }}
        />
      </>
    );
  } else if (phase === 'COMPLETED') {
    glyph = (
      <>
        <circle cx="8" cy="8" r="5.6" fill={color} opacity={0.9} />
        <path d="M5.3 8.2l1.9 1.9 3.5-4" fill="none" stroke="var(--color-canvas)" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
      </>
    );
  } else if (phase === 'AWAITING_REVIEW' || phase === 'AWAITING_HUMAN' || phase === 'MERGING') {
    glyph = (
      <>
        <circle cx="8" cy="8" r="5.6" fill={color} opacity={0.18} />
        <circle cx="8" cy="8" r="5.6" {...common} />
      </>
    );
  } else if (phase === 'FAILED') {
    glyph = (
      <>
        <circle cx="8" cy="8" r="5.6" {...common} />
        <path d="M6 6l4 4M10 6l-4 4" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
      </>
    );
  } else if (phase === 'CANCELED') {
    glyph = (
      <>
        <circle cx="8" cy="8" r="5.6" {...common} />
        <path d="M5.4 10.6l5.2-5.2" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
      </>
    );
  } else if (phase === 'BLOCKED' || phase === 'BLOCKED_APPROVAL_CHANGED' || phase === 'RECOVERY_REQUIRED') {
    glyph = (
      <>
        <circle cx="8" cy="8" r="5.6" {...common} />
        <path d="M8 4.9v3.6" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
        <circle cx="8" cy="10.9" r="0.95" fill={color} />
      </>
    );
  } else {
    // DISCOVERED — hollow ring
    glyph = <circle cx="8" cy="8" r="5.6" {...common} />;
  }

  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={`shrink-0 ${className ?? ''}`} aria-hidden>
      {glyph}
    </svg>
  );
}

/** The seven Issue labels have their own glyphs; null means a corrupt/missing state. */
export function WorkflowIcon(props: { state: WorkflowState | null; size?: number; className?: string }) {
  const { state, size = 14, className } = props;
  const color = workflowHex(state);
  const common = { fill: 'none', stroke: color, strokeWidth: 1.6 } as const;
  let glyph: React.ReactNode;

  if (state === 'In Progress') {
    glyph = (
      <>
        <circle cx="8" cy="8" r="5.6" {...common} opacity={0.35} />
        <circle cx="8" cy="8" r="5.6" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round"
          strokeDasharray="26 35.2" transform="rotate(-90 8 8)"
          style={{ transformOrigin: '8px 8px', animation: 'spin-slow 1.6s infinite' }} />
      </>
    );
  } else if (state === 'Todo') {
    glyph = <circle cx="8" cy="8" r="5.6" {...common} />;
  } else if (state === 'Backlog') {
    glyph = <circle cx="8" cy="8" r="5.6" {...common} strokeDasharray="2 2.2" opacity={0.75} />;
  } else if (state === 'Human Review') {
    glyph = (
      <>
        <circle cx="8" cy="8" r="5.6" fill={color} opacity={0.16} />
        <path d="M8 2.4a5.6 5.6 0 0 1 0 11.2z" fill={color} opacity={0.85} />
        <circle cx="8" cy="8" r="5.6" {...common} />
      </>
    );
  } else if (state === 'Rework') {
    glyph = (
      <>
        <path d="M4.3 6.2A4.4 4.4 0 0 1 12 8.1" {...common} strokeLinecap="round" />
        <path d="M11.7 9.8A4.4 4.4 0 0 1 4 7.9" {...common} strokeLinecap="round" />
        <path d="M3.1 4.6l1.2 1.6 1.8-.7" {...common} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12.9 11.4l-1.2-1.6-1.8.7" {...common} strokeLinecap="round" strokeLinejoin="round" />
      </>
    );
  } else if (state === 'Merging') {
    glyph = (
      <>
        <circle cx="4.6" cy="4.2" r="1.6" {...common} />
        <circle cx="4.6" cy="11.8" r="1.6" {...common} />
        <circle cx="11.4" cy="8" r="1.6" {...common} />
        <path d="M4.6 5.8v4.4M6.2 8h3.6" {...common} strokeLinecap="round" />
      </>
    );
  } else if (state === 'Done') {
    glyph = (
      <>
        <circle cx="8" cy="8" r="5.6" fill={color} opacity={0.9} />
        <path d="M5.3 8.2l1.9 1.9 3.5-4" fill="none" stroke="var(--color-canvas)" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
      </>
    );
  } else {
    glyph = (
      <>
        <circle cx="8" cy="8" r="5.6" {...common} />
        <path d="M8 4.9v3.6" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
        <circle cx="8" cy="10.9" r="0.95" fill={color} />
      </>
    );
  }

  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={`shrink-0 ${className ?? ''}`} aria-hidden>
      {glyph}
    </svg>
  );
}
