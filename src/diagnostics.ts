import { writeSync } from "node:fs";

export type ValidationLocation = {
  finding_index?: number;
  validation_field: "findings" | "finding" | "text" | "category" | "reason";
};
type LossLocation = {
  window: number;
  attempt: number;
  event: DiagnosticEvent["event"];
  reason: "record_limit" | "queue_full" | "session_limit" | "write_failed";
};
export type DiagnosticEvent = {
  version: 1;
  event:
    | "classifier_request"
    | "classifier_response"
    | "classifier_attempt_result"
    | "channel_complete";
  window: number;
  attempt: number;
  request_body?: string;
  completion_content?: string | null;
  outcome?: "complete" | "error";
  validation_code?: string;
  finding_index?: number;
  validation_field?: ValidationLocation["validation_field"];
  retry?: boolean;
  dropped_events?: number;
  dropped_bytes?: number;
  request_dispatched?: boolean;
  window_count?: number;
  emitted_events?: number;
  loss_locations?: LossLocation[];
  loss_locations_truncated?: boolean;
};
export type DiagnosticObserver = (event: DiagnosticEvent) => void;
/** Evidence collection must never affect screening or expose errors. */
export function observe(
  observer: DiagnosticObserver | undefined,
  event: DiagnosticEvent,
): void {
  try {
    observer?.(event);
  } catch {}
}
/** The supervisor supplies an O_NONBLOCK pipe; this never opens a pathname. */
export function diagnosticWriter(
  fd: number,
  maxRecordBytes: number,
  write = writeSync,
) {
  const queue: { frame: Buffer; event: DiagnosticEvent }[] = [];
  const losses: LossLocation[] = [];
  let lossesTruncated = false,
    windowCount = 0;
  let queued = 0,
    offset = 0,
    total = 0,
    events = 0;
  let droppedEvents = 0,
    droppedBytes = 0,
    disabled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drop = (
    event: DiagnosticEvent,
    bytes: number,
    reason: LossLocation["reason"],
  ) => {
    if (losses.length < 128)
      losses.push({
        window: event.window,
        attempt: event.attempt,
        event: event.event,
        reason,
      });
    else lossesTruncated = true;
    droppedEvents++;
    droppedBytes += bytes;
  };
  const drain = (final = false) => {
    timer = undefined;
    // Final work is bounded by the existing queue, never an arbitrary byte cut.
    // Stop immediately on backpressure; no timer or wait extends helper lifetime.
    let budget = final ? queued - offset : 64 * 1024;
    while (queue.length && budget > 0 && !disabled) {
      const { frame } = queue[0]!;
      try {
        const n = write(
          fd,
          frame,
          offset,
          Math.min(frame.length - offset, budget),
        );
        if (n === 0) break;
        offset += n;
        budget -= n;
        if (offset === frame.length) {
          queued -= frame.length;
          queue.shift();
          offset = 0;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EAGAIN" || code === "EWOULDBLOCK" || code === "EINTR")
          break;
        disabled = true;
        for (const pending of queue)
          drop(pending.event, pending.frame.length - 4, "write_failed");
        queue.length = 0;
        queued = 0;
      }
    }
    if (queue.length && !disabled && !final) {
      timer = setTimeout(() => drain(), 1);
      timer.unref();
    }
  };
  const emit: DiagnosticObserver = (event) => {
    if (event.event !== "channel_complete")
      windowCount = Math.max(windowCount, event.window + 1);
    if (disabled) {
      drop(event, 0, "write_failed");
      return;
    }
    const json = JSON.stringify(event);
    const size = Buffer.byteLength(json);
    const reason =
      size > maxRecordBytes
        ? "record_limit"
        : queued + size + 4 > 2 * (maxRecordBytes + 4)
          ? "queue_full"
          : total + size + 4 > 64 * 1024 * 1024 || events >= 65536
            ? "session_limit"
            : undefined;
    if (reason) {
      drop(event, size, reason);
      return;
    }
    const frame = Buffer.allocUnsafe(size + 4);
    frame.writeUInt32BE(size);
    frame.write(json, 4);
    queue.push({ frame, event });
    queued += frame.length;
    total += frame.length;
    events++;
    if (!timer) drain();
  };
  return {
    emit,
    finish() {
      const terminal: DiagnosticEvent = {
        version: 1,
        event: "channel_complete",
        window: 0,
        attempt: 0,
        dropped_events: droppedEvents,
        dropped_bytes: droppedBytes,
        window_count: windowCount,
        emitted_events: events,
        loss_locations: [...losses],
        loss_locations_truncated: lossesTruncated,
      };
      while (
        Buffer.byteLength(JSON.stringify(terminal)) > maxRecordBytes &&
        terminal.loss_locations!.length
      ) {
        terminal.loss_locations!.pop();
        terminal.loss_locations_truncated = true;
      }
      observe(emit, terminal);
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      drain(true);
    },
  };
}
