import { modelScreening, type ModelScreening } from "./model-config";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import {
  type SemanticPolicy,
  type InputLimits,
  inputLimits,
  Failure,
  LIMITS,
  decode,
  integer,
  keys,
  object,
  strictJson,
  string,
} from "./contract";
export interface Config {
  version: 3;
  limits: InputLimits;
  model_screening: ModelScreening;
  validation_retries?: number;
  provider: {
    base_url: string;
    model: string;
    auth: { kind: "none" } | { kind: "bearer_file"; path: string };
    timeout_ms: number;
    max_response_bytes: number;
    max_tokens: number;
    output_format: "json_object";
    reasoning: { kind: "qwen_disabled" } | { kind: "effort"; effort: "low" };
  };
  egress: { kind: "direct" } | { kind: "proxy_env"; variable: string };
}
export type ScreeningConfig = Config & { policy: SemanticPolicy };
export function config(x: unknown): Config {
  const c = object(x);
  keys(
    c,
    ["version", "limits", "model_screening", "provider", "egress"],
    ["validation_retries"],
  );
  if (
    c.validation_retries !== undefined &&
    (!Number.isSafeInteger(c.validation_retries) ||
      Number(c.validation_retries) < 0 ||
      Number(c.validation_retries) > 3)
  )
    throw new Failure("configuration_error");
  if (c.version !== 3) throw new Failure("configuration_error");
  inputLimits(c.limits);
  const p = object(c.provider);
  keys(p, [
    "base_url",
    "model",
    "auth",
    "timeout_ms",
    "max_response_bytes",
    "max_tokens",
    "output_format",
    "reasoning",
  ]);
  const url = new URL(string(p.base_url, 2048));
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith("/v1")
  )
    throw new Failure("configuration_error");
  string(p.model, 256);
  integer(p.timeout_ms, 28800000);
  integer(p.max_response_bytes, 524288);
  integer(p.max_tokens, 32768);
  modelScreening(c.model_screening, p.max_tokens as number);
  if (p.output_format !== "json_object")
    throw new Failure("configuration_error");
  const reasoning = object(p.reasoning);
  if (reasoning.kind === "qwen_disabled") keys(reasoning, ["kind"]);
  else if (reasoning.kind === "effort") {
    keys(reasoning, ["kind", "effort"]);
    if (reasoning.effort !== "low") throw new Failure("configuration_error");
  } else throw new Failure("configuration_error");
  const a = object(p.auth);
  if (a.kind === "none") keys(a, ["kind"]);
  else if (a.kind === "bearer_file") {
    keys(a, ["kind", "path"]);
    string(a.path, 4096);
  } else throw new Failure("configuration_error");
  const e = object(c.egress);
  if (e.kind === "direct") keys(e, ["kind"]);
  else if (e.kind === "proxy_env") {
    keys(e, ["kind", "variable"]);
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(string(e.variable, 64)))
      throw new Failure("configuration_error");
  } else throw new Failure("configuration_error");
  return c as unknown as Config;
}
/** Read a bounded regular file using the caller's ordinary filesystem access. */
export async function readableFile(
  path: string,
  max: number,
): Promise<Uint8Array> {
  // Nonblocking open lets the regular-file check reject FIFOs without waiting.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(max))
      throw new Failure("configuration_error");
    const bytes = new Uint8Array(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      length !== Number(before.size) ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      bytes.fill(0);
      throw new Failure("configuration_error");
    }
    const result = bytes.slice(0, length);
    bytes.fill(0);
    return result;
  } finally {
    await file.close();
  }
}
export async function load(configPath: string): Promise<Config> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await readableFile(configPath, LIMITS.config);
    return config(strictJson(decode(bytes)));
  } catch {
    throw new Failure("configuration_error");
  } finally {
    bytes?.fill(0);
  }
}
export async function apiKey(c: Config): Promise<string> {
  if (c.provider.auth.kind === "none") return "unused-no-auth";
  const b = await readableFile(c.provider.auth.path, 16384);
  try {
    const key = decode(b).replace(/\r?\n$/, "");
    if (!key || key.trim() !== key || /[\x00-\x1f\x7f]/.test(key))
      throw new Failure("configuration_error");
    return key;
  } finally {
    b.fill(0);
  }
}
