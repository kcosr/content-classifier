import { closeSync, constants, openSync, writeSync } from "node:fs";

export type ProgressEvent = {
  version: 1;
  type: "progress";
  stage: "planning" | "classifying";
  completed: number;
  total: number;
};
export type ProgressObserver = (event: ProgressEvent) => void;
export function progress(
  observer: ProgressObserver | undefined,
  stage: ProgressEvent["stage"],
  completed: number,
  total: number,
): void {
  try {
    observer?.({ version: 1, type: "progress", stage, completed, total });
  } catch {
    /* Progress never changes screening. */
  }
}
/** No queue: drop under backpressure. Pipe frames fit the atomic-write bound. */
export function boundedProgressWriter(
  write: (frame: Buffer) => number,
  maxEvents: number,
): ProgressObserver {
  let events = 0,
    disabled = false;
  return (event) => {
    if (disabled || events++ >= maxEvents) return;
    const frame = Buffer.from(JSON.stringify(event) + "\n");
    if (frame.length >= 1024) return;
    try {
      if (write(frame) !== frame.length) disabled = true;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EAGAIN" &&
        (error as NodeJS.ErrnoException).code !== "EWOULDBLOCK"
      )
        disabled = true;
    }
  };
}
/** Linux helper deployments already require /proc. Reopen without changing the
 * supervisor's descriptor flags, and never queue or wait on a full stderr pipe. */
export function progressWriter(maxEvents: number): {
  emit: ProgressObserver;
  finish: () => void;
} {
  let fd: number | undefined;
  let pending = false,
    disabled = false;
  try {
    fd = openSync(
      "/proc/self/fd/2",
      constants.O_WRONLY | constants.O_NONBLOCK | constants.O_APPEND,
    );
  } catch {
    // Node and Bun may supply socketpairs, which /proc cannot reopen. Keep at
    // most one asynchronous stream write in flight and drop until it finishes.
    process.stderr.on("error", () => {
      disabled = true;
      pending = false;
    });
  }
  const emit = boundedProgressWriter((frame) => {
    if (fd !== undefined) return writeSync(fd, frame);
    if (disabled) return 0;
    if (pending) throw Object.assign(new Error("busy"), { code: "EAGAIN" });
    pending = true;
    try {
      process.stderr.write(frame, (error?: Error | null) => {
        pending = false;
        if (error) disabled = true;
      });
    } catch {
      pending = false;
      disabled = true;
      return 0;
    }
    return frame.length;
  }, maxEvents);
  return {
    emit,
    finish() {
      disabled = true;
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {}
        fd = undefined;
      } else if (pending) process.stderr.destroy(); // cancel; never await progress
    },
  };
}
