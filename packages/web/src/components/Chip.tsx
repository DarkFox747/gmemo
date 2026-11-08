import type { ReactNode } from 'react';
import type { MemoryStatus, MemoryType, QuarantineReasonCode } from '../api/types';
import { reasonCodeLabel, statusLabel, typeLabel } from '../lib/labels';

export function Chip({ variant, children }: { variant: string; children: ReactNode }) {
  return <span className={`chip chip--${variant}`}>{children}</span>;
}

export function TypeChip({ type }: { type: MemoryType }) {
  return <Chip variant={type}>{typeLabel(type)}</Chip>;
}

export function StatusChip({ status }: { status: MemoryStatus }) {
  return <Chip variant={status}>{statusLabel(status)}</Chip>;
}

export function ReasonChip({ code }: { code: QuarantineReasonCode | null }) {
  return <Chip variant="reason">{code ? reasonCodeLabel(code) : 'Sin clasificar'}</Chip>;
}
