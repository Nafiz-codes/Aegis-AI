/**
 * Process-wide pub/sub used by the dashboard to mirror the agent's pipeline.
 *
 * The bus is intentionally tiny: we don't want any of this in the production
 * critical path. Subscribers receive a *copy* of every emitted event so a
 * slow SSE client can't backpressure the pipeline.
 */

export type TimelineKind =
  | "detected"
  | "verified"
  | "severity"
  | "audience"
  | "decision"
  | "compose"
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "failed"
  | "skipped"
  | "system"
  | "log";

export interface TimelineEvent {
  /** Monotonic timestamp within the run; surfaced as HH:MM:SS.mmm to viewers. */
  ts: string;
  /** Pipeline stage the event corresponds to. */
  kind: TimelineKind;
  /** Short uppercase tag shown next to the timestamp. */
  tag: string;
  /** Free-form one-line message shown in the timeline pane. */
  message: string;
  /** Optional structured payload (event id, channel, severity, etc.). */
  meta?: Record<string, unknown>;
  /** Monotonic millisecond counter for ordering. */
  seq: number;
}

type Listener = (e: TimelineEvent) => void;

class EventBus {
  private listeners: Listener[] = [];
  private seq = 0;

  emit(input: { kind: TimelineKind; tag: string; message: string; meta?: Record<string, unknown> }): TimelineEvent {
    const ev: TimelineEvent = {
      ts: new Date().toISOString(),
      kind: input.kind,
      tag: input.tag,
      message: input.message,
      meta: input.meta,
      seq: ++this.seq,
    };
    // Copy first so a misbehaving listener can't mutate what others see.
    const snapshot = { ...ev };
    for (const l of this.listeners) {
      try {
        l(snapshot);
      } catch {
        /* never let a subscriber crash the pipeline */
      }
    }
    return ev;
  }

  on(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Synchronous listener count (used in tests / diagnostics). */
  size(): number {
    return this.listeners.length;
  }
}

/* The single dashboard-wide bus. Imported by both the producer side
 * (entrypoint instrumentation) and the consumer side (HTTP/SSE handler). */
export const dashboardBus = new EventBus();

/**
 * Format an ISO timestamp as `HH:MM:SS` for compact timeline display.
 * Pulled out so every stage of the pipeline emits the same shape.
 */
export function fmtClock(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}