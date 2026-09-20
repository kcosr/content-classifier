import type { ValidationLocation } from "./diagnostics";
/** Versioned one-call contract; payload-bearing values must never be logged. */
export const LIMITS = {
  input: 67108864,
  output: 1048576,
  text: 8388608,
  units: 4096,
  parts: 65536,
  segments: 262144,
  findings: 4096,
  finding: 65536,
  config: 262144,
  stderr: 4096,
} as const;
export interface InputLimits {
  max_output_bytes: number;
  max_findings: number;
  max_finding_bytes: number;
  max_input_bytes: number;
  max_text_bytes: number;
  max_units: number;
  max_parts: number;
  max_segments: number;
}
export const DEFAULT_INPUT_LIMITS: InputLimits = {
  max_output_bytes: LIMITS.output,
  max_findings: LIMITS.findings,
  max_finding_bytes: LIMITS.finding,
  max_input_bytes: LIMITS.input,
  max_text_bytes: LIMITS.text,
  max_units: LIMITS.units,
  max_parts: LIMITS.parts,
  max_segments: LIMITS.segments,
};
export function inputLimits(value: unknown): InputLimits {
  const limits = object(value);
  keys(limits, [
    "max_output_bytes",
    "max_findings",
    "max_finding_bytes",
    "max_input_bytes",
    "max_text_bytes",
    "max_units",
    "max_parts",
    "max_segments",
  ]);
  integer(limits.max_output_bytes, 16777216);
  integer(limits.max_findings, 65536);
  integer(limits.max_finding_bytes, 1048576);
  integer(limits.max_input_bytes, 268435456);
  integer(limits.max_text_bytes, 67108864);
  integer(limits.max_units, 65536);
  integer(limits.max_parts, 262144);
  integer(limits.max_segments, 1048576);
  if (Number(limits.max_text_bytes) > Number(limits.max_input_bytes))
    throw new Failure("configuration_error");
  return limits as unknown as InputLimits;
}
export const CODES = [
  "invalid_request",
  "configuration_error",
  "provider_unavailable",
  "provider_overloaded",
  "provider_refused",
  "provider_incomplete",
  "invalid_output",
  "invalid_output_schema",
  "invalid_output_source",
  "invalid_output_policy",
  "output_limit",
  "deadline",
  "cancelled",
  "process_failed",
  "admission_exhausted",
] as const;
export type Code = (typeof CODES)[number];
export class Failure extends Error {
  constructor(readonly code: Code) {
    super(code);
  }
}
export type Segment =
  | { kind: "source"; text: string }
  | { kind: "redacted"; label: string };
export interface ConversationTarget {
  kind: "conversation";
  units: Unit[];
}
export interface FileTarget {
  kind: "file";
  path: string;
  text: string;
}
export type Target = ConversationTarget | FileTarget;
export interface Unit {
  target: boolean;
  role: string;
  kind: string;
  parts: { kind: string; segments: Segment[] }[];
}
export interface Request {
  version: 4;
  policy: SemanticPolicy;
  target: Target;
}
export interface Finding {
  text: string;
  category: string;
  reason: string;
}
export interface Category {
  id: string;
  reasons: string[];
}
export interface SemanticCategory extends Category {
  description?: string;
  inclusion: string[];
  exclusion: string[];
  examples: string[];
}
export interface SemanticPolicy {
  instructions: string;
  categories: SemanticCategory[];
}
export function semanticPolicy(value: unknown): SemanticPolicy {
  const p = object(value);
  keys(p, ["instructions", "categories"]);
  if (string(p.instructions, 32768).includes("\0"))
    throw new Failure("invalid_request");
  if (
    !Array.isArray(p.categories) ||
    !p.categories.length ||
    p.categories.length > 64
  )
    throw new Failure("invalid_request");
  const ids = new Set<string>();
  for (const raw of p.categories) {
    const c = object(raw);
    keys(
      c,
      ["id", "reasons", "inclusion", "exclusion", "examples"],
      ["description"],
    );
    const id = identifier(c.id);
    if (bytes(id) > 60 || ids.has(id)) throw new Failure("invalid_request");
    ids.add(id);
    if (!Array.isArray(c.reasons) || !c.reasons.length || c.reasons.length > 64)
      throw new Failure("invalid_request");
    const reasons = c.reasons.map(identifier);
    if (new Set(reasons).size !== reasons.length)
      throw new Failure("invalid_request");
    if (
      c.description !== undefined &&
      /\p{Cc}/u.test(string(c.description, 512))
    )
      throw new Failure("invalid_request");
    for (const key of ["inclusion", "exclusion", "examples"]) {
      const entries = c[key];
      if (!Array.isArray(entries) || entries.length > 64)
        throw new Failure("invalid_request");
      for (const entry of entries)
        if (string(entry, 4096).includes("\0"))
          throw new Failure("invalid_request");
    }
  }
  return p as unknown as SemanticPolicy;
}
export const bytes = (s: string) => Buffer.byteLength(s, "utf8");
export function object(x: unknown): Record<string, unknown> {
  if (!x || typeof x !== "object" || Array.isArray(x))
    throw new Failure("invalid_request");
  return x as Record<string, unknown>;
}
export function keys(
  x: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): void {
  if (
    required.some((k) => !Object.hasOwn(x, k)) ||
    Object.keys(x).some((k) => ![...required, ...optional].includes(k))
  )
    throw new Failure("invalid_request");
}
export function string(x: unknown, max: number, empty = false): string {
  if (
    typeof x !== "string" ||
    !x.isWellFormed() ||
    (!empty && !x.length) ||
    bytes(x) > max
  )
    throw new Failure("invalid_request");
  return x;
}
export function identifier(x: unknown): string {
  const s = string(x, 64);
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(s))
    throw new Failure("invalid_request");
  return s;
}
export function integer(x: unknown, max: number): number {
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 1 || x > max)
    throw new Failure("invalid_request");
  return x;
}
/** Recursive syntax scanner rejects duplicate keys before JSON.parse can erase them. */
export function strictJson(text: string): unknown {
  let i = 0;
  const ws = () => {
    while (/[\x20\t\r\n]/.test(text[i] ?? "x")) i++;
  };
  const str = (): string => {
    const start = i;
    if (text[i++] !== '"') throw new Failure("invalid_request");
    while (i < text.length) {
      const c = text[i++];
      if (c === '"') {
        const s = JSON.parse(text.slice(start, i));
        if (!s.isWellFormed()) throw new Failure("invalid_request");
        return s;
      }
      if (c === "\\") i++;
    }
    throw new Failure("invalid_request");
  };
  const value = (depth: number): void => {
    if (depth > 32) throw new Failure("invalid_request");
    ws();
    if (text[i] === '"') {
      str();
      return;
    }
    if (text[i] === "{") {
      i++;
      ws();
      const seen = new Set<string>();
      if (text[i] === "}") {
        i++;
        return;
      }
      while (true) {
        ws();
        const k = str();
        if (seen.has(k)) throw new Failure("invalid_request");
        seen.add(k);
        ws();
        if (text[i++] !== ":") throw new Failure("invalid_request");
        value(depth + 1);
        ws();
        const c = text[i++];
        if (c === "}") return;
        if (c !== ",") throw new Failure("invalid_request");
      }
    }
    if (text[i] === "[") {
      i++;
      ws();
      if (text[i] === "]") {
        i++;
        return;
      }
      while (true) {
        value(depth + 1);
        ws();
        const c = text[i++];
        if (c === "]") return;
        if (c !== ",") throw new Failure("invalid_request");
      }
    }
    const m = text
      .slice(i)
      .match(
        /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/,
      );
    if (!m) throw new Failure("invalid_request");
    i += m[0].length;
    if (
      typeof JSON.parse(m[0]) === "number" &&
      !Number.isFinite(JSON.parse(m[0]))
    )
      throw new Failure("invalid_request");
  };
  try {
    value(0);
    ws();
    if (i !== text.length) throw new Failure("invalid_request");
    return JSON.parse(text);
  } catch {
    throw new Failure("invalid_request");
  }
}
export function decode(data: Uint8Array): string {
  try {
    return new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(
      data,
    );
  } catch {
    throw new Failure("invalid_request");
  }
}
export function request(
  x: unknown,
  limits: InputLimits = DEFAULT_INPUT_LIMITS,
): Request {
  const r = object(x);
  keys(r, ["version", "policy", "target"]);
  semanticPolicy(r.policy);
  if (r.version !== 4) throw new Failure("invalid_request");
  const t = object(r.target);
  if (t.kind === "file") {
    keys(t, ["kind", "path", "text"]);
    const path = string(t.path, 4096);
    if (
      path.includes("\0") ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Failure("invalid_request");
    string(t.text, limits.max_text_bytes);
    return r as unknown as Request;
  }
  if (t.kind !== "conversation") throw new Failure("invalid_request");
  keys(t, ["kind", "units"]);
  if (
    !Array.isArray(t.units) ||
    !t.units.length ||
    t.units.length > limits.max_units
  )
    throw new Failure("invalid_request");
  let count = 0,
    total = 0,
    source = 0,
    parts = 0;
  for (const rawUnit of t.units) {
    const unit = object(rawUnit);
    keys(unit, ["role", "kind", "target", "parts"]);
    identifier(unit.role);
    identifier(unit.kind);
    if (typeof unit.target !== "boolean" || !Array.isArray(unit.parts))
      throw new Failure("invalid_request");
    for (const raw of unit.parts) {
      if (++parts > limits.max_parts) throw new Failure("invalid_request");
      const p = object(raw);
      keys(p, ["kind", "segments"]);
      identifier(p.kind);
      if (!Array.isArray(p.segments)) throw new Failure("invalid_request");
      for (const rawS of p.segments) {
        const s = object(rawS);
        if (++count > limits.max_segments) throw new Failure("invalid_request");
        if (s.kind === "source") {
          keys(s, ["kind", "text"]);
          total += bytes(string(s.text, limits.max_text_bytes));
          if (unit.target) source++;
        } else if (s.kind === "redacted") {
          keys(s, ["kind", "label"]);
          total += bytes(string(s.label, 4096));
        } else throw new Failure("invalid_request");
        if (total > limits.max_text_bytes) throw new Failure("invalid_request");
      }
    }
  }
  if (source === 0) throw new Failure("invalid_request");
  return r as unknown as Request;
}
export function findings(
  x: unknown,
  target: Target,
  categories: Category[],
  limits: InputLimits = DEFAULT_INPUT_LIMITS,
  observer?: (location: ValidationLocation) => void,
): Finding[] {
  let location: ValidationLocation = { validation_field: "findings" };
  try {
    const r = object(x);
    keys(r, ["findings"]);
    if (!Array.isArray(r.findings)) throw new Failure("invalid_output_schema");
    if (r.findings.length > limits.max_findings)
      throw new Failure("output_limit");
    const result: Finding[] = [];
    const seen = new Set<string>();
    for (const [index, raw] of r.findings.entries()) {
      location = { finding_index: index, validation_field: "finding" };
      const f = object(raw);
      keys(f, ["text", "category", "reason"]);
      location.validation_field = "text";
      if (
        typeof f.text === "string" &&
        bytes(f.text) > limits.max_finding_bytes
      )
        throw new Failure("output_limit");
      const text = string(f.text, limits.max_finding_bytes);
      location.validation_field = "category";
      const category = identifier(f.category);
      location.validation_field = "reason";
      const reason = identifier(f.reason);
      if (
        !categories.some((c) => c.id === category && c.reasons.includes(reason))
      ) {
        location.validation_field = categories.some((c) => c.id === category)
          ? "reason"
          : "category";
        throw new Failure("invalid_output_policy");
      }
      location.validation_field = "text";
      if (
        !(target.kind === "file"
          ? target.text.includes(text)
          : target.units.some(
              (unit) =>
                unit.target &&
                unit.parts.some((p) =>
                  p.segments.some(
                    (s) => s.kind === "source" && s.text.includes(text),
                  ),
                ),
            ))
      )
        throw new Failure("invalid_output_source");
      const key = JSON.stringify([text, category, reason]);
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ text, category, reason });
      }
    }
    return result;
  } catch (error) {
    try {
      observer?.(location);
    } catch {}
    if (error instanceof Failure && error.code !== "invalid_request")
      throw error;
    throw new Failure("invalid_output_schema");
  }
}
export async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new Failure("cancelled");
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new Failure("cancelled");
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        value.fill(0);
        await reader.cancel();
        throw new Failure("output_limit");
      }
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  } finally {
    signal?.removeEventListener("abort", abort);
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
}
