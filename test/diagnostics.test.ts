import { expect, test } from "bun:test";
import { diagnosticWriter, type DiagnosticEvent } from "../src/diagnostics";
import { writeSync } from "node:fs";

const event: DiagnosticEvent = {
  version: 1,
  event: "classifier_request",
  window: 0,
  attempt: 0,
  request_body: "private",
};
const decode = (bytes: Buffer) => {
  const result: DiagnosticEvent[] = [];
  while (bytes.length) {
    const size = bytes.readUInt32BE();
    result.push(JSON.parse(bytes.subarray(4, size + 4).toString()));
    bytes = bytes.subarray(size + 4);
  }
  return result;
};
test("private channel frames whole records and reports oversized record loss", () => {
  const chunks: Buffer[] = [];
  const writer = diagnosticWriter(3, 1024, ((
    _fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
  ) => {
    const size = Math.min(17, length);
    chunks.push(Buffer.from(buffer.subarray(offset, offset + size)));
    return size;
  }) as typeof writeSync);
  writer.emit(event);
  writer.emit({ ...event, request_body: "x".repeat(2048) });
  writer.finish();
  const records = decode(Buffer.concat(chunks));
  expect(records[0]).toEqual(event);
  expect(records[1]).toMatchObject({
    event: "channel_complete",
    dropped_events: 1,
  });
});
test("nonblocking channel preserves a partial frame across backpressure", async () => {
  const chunks: Buffer[] = [];
  let writes = 0;
  const writer = diagnosticWriter(3, 1024, ((
    _fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
  ) => {
    if (++writes === 2)
      throw Object.assign(new Error("private"), { code: "EAGAIN" });
    const size = Math.min(11, length);
    chunks.push(Buffer.from(buffer.subarray(offset, offset + size)));
    return size;
  }) as typeof writeSync);
  writer.emit(event);
  await Bun.sleep(10);
  writer.finish();
  expect(decode(Buffer.concat(chunks))[0]).toEqual(event);
});
test("permanent channel failure disables writes without throwing", () => {
  let writes = 0;
  const writer = diagnosticWriter(3, 1024, (() => {
    writes++;
    throw Object.assign(new Error("private"), { code: "EPIPE" });
  }) as typeof writeSync);
  writer.emit(event);
  writer.emit(event);
  writer.finish();
  expect(writes).toBe(1);
});
test("capability probe requires no deployment and writes only fixed metadata", async () => {
  const process = Bun.spawn(
    [
      Bun.which("bun")!,
      "--no-env-file",
      "src/main.ts",
      "--diagnostic-capabilities",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await new Response(process.stdout).text()).toBe(
    '{"version":1,"transport":"inherited_pipe","events":"classifier_attempts"}\n',
  );
  expect(await new Response(process.stderr).text()).toBe("");
  expect(await process.exited).toBe(0);
});

test("queue overflow drops whole future frames with bounded keyed loss attribution", async () => {
  const chunks: Buffer[] = [];
  let blocked = true;
  const writer = diagnosticWriter(3, 1024, ((
    _fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
  ) => {
    if (blocked) throw Object.assign(new Error("private"), { code: "EAGAIN" });
    chunks.push(Buffer.from(buffer.subarray(offset, offset + length)));
    return length;
  }) as typeof writeSync);
  for (let attempt = 0; attempt < 200; attempt++)
    writer.emit({
      ...event,
      window: 4,
      attempt,
      request_body: "x".repeat(600),
    });
  blocked = false;
  await Bun.sleep(10);
  writer.finish();
  const records = decode(Buffer.concat(chunks));
  const terminal = records.at(-1)!;
  expect(
    records.slice(0, -1).every((e) => e.request_body === "x".repeat(600)),
  ).toBe(true);
  expect(terminal).toMatchObject({
    event: "channel_complete",
    window_count: 5,
    emitted_events: records.length - 1,
    loss_locations_truncated: true,
  });
  expect(terminal.loss_locations?.[0]).toMatchObject({
    window: 4,
    event: "classifier_request",
    reason: "queue_full",
  });
  expect(terminal.dropped_events).toBe(201 - records.length);
});

test("final nonblocking drain completes a queued completion larger than 1MiB without waiting", () => {
  const chunks: Buffer[] = [];
  let blocked = true;
  const writer = diagnosticWriter(3, 4 * 1024 * 1024, ((
    _fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
  ) => {
    if (blocked) throw Object.assign(new Error("private"), { code: "EAGAIN" });
    chunks.push(Buffer.from(buffer.subarray(offset, offset + length)));
    return length;
  }) as typeof writeSync);
  const content = "x".repeat(2 * 1024 * 1024);
  writer.emit({
    version: 1,
    event: "classifier_response",
    window: 0,
    attempt: 0,
    completion_content: content,
  });
  blocked = false;
  writer.finish();
  const records = decode(Buffer.concat(chunks));
  expect(records[0]?.completion_content).toBe(content);
  expect(records.at(-1)?.event).toBe("channel_complete");
});

test("a reduced positive envelope budget drops records without changing screening", () => {
  let writes = 0;
  const writer = diagnosticWriter(3, 1, (() => {
    writes++;
    return 0;
  }) as typeof writeSync);
  expect(() => {
    writer.emit(event);
    writer.finish();
  }).not.toThrow();
  expect(writes).toBe(0);
});
