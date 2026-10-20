import type { Phase } from './api';
import { isActivePhase, phaseHex } from './groups';

/**
 * Linear-style 14px status glyphs: hollow ring (queued), breathing
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
        <circle cx="8" cy="8" r="5.6" {...common} opacity={0.25} />
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
          style={{ animation: 'breathe 2.4s ease-in-out infinite' }}
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
  } else if (phase === 'AWAITING_MERGE') {
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
