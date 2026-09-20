import { policy } from "./policy";
import { describe, test, expect } from "bun:test";
import {
  mkdtemp,
  writeFile,
  rm,
  chmod,
  readFile,
  symlink,
  link,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { config, load, type ScreeningConfig } from "../src/config";
import {
  Failure,
  LIMITS,
  request,
  strictJson,
  findings,
  readBounded,
  type ConversationTarget as Target,
} from "../src/contract";
import { classify, body, type Fetch } from "../src/provider";
const target: Target = {
  kind: "conversation",
  units: [
    {
      target: true,
      role: "user",
      kind: "message",
      parts: [
        {
          kind: "text",
          segments: [
            { kind: "source", text: "Password synthetic-pass-123." },
            { kind: "redacted", label: "[REDACTED API KEY]" },
            { kind: "source", text: "No other secrets." },
          ],
        },
      ],
    },
  ],
};
const source = {
  version: 3,
  model_screening: {
    context_window_tokens: 32768,
    max_input_tokens: 24000,
    overlap_tokens: 512,
    prompt_reserve_tokens: 1024,
    estimation_margin_percent: 25,
    max_groups: 1024,
  },
  limits: {
    max_output_bytes: 1048576,
    max_findings: 4096,
    max_finding_bytes: 65536,
    max_input_bytes: 67108864,
    max_text_bytes: 8388608,
    max_units: 4096,
    max_parts: 65536,
    max_segments: 262144,
  },
  provider: {
    base_url: "https://model.example.com/v1",
    model: "qwen-model",
    auth: { kind: "none" },
    timeout_ms: 3000,
    max_response_bytes: 524288,
    max_tokens: 1024,
    output_format: "json_object",
    reasoning: { kind: "qwen_disabled" },
  },
  egress: { kind: "direct" },
};
const c = () => ({ ...config(structuredClone(source)), policy });
const envelope = (content: unknown, finish = "stop", extra = {}) =>
  new Response(
    JSON.stringify({
      id: "test",
      object: "chat.completion",
      created: 1,
      model: "test",
      choices: [
        {
          index: 0,
          finish_reason: finish,
          message: {
            role: "assistant",
            content: JSON.stringify(content),
            ...extra,
          },
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
const verdict = {
  findings: [
    {
      text: "synthetic-pass-123",
      category: "credential",
      reason: "embedded_password",
    },
  ],
};
test("strict JSON rejects duplicate escaped keys, extra documents, nonfinite and lone surrogate", () => {
  for (const x of ['{"x":1,"\\u0078":2}', "{} {}", '{"x":1e999}', '"\\ud800"'])
    expect(() => strictJson(x)).toThrow();
});
test("contract rejects all-masked and unknown fields", () => {
  const r = {
    version: 4,
    policy,
    target,
  };
  expect((request(r).target as Target).units[0]!.parts.length).toBe(1);
  for (const bad of [
    { ...r, extra: true },
    {
      ...r,
      target: {
        kind: "conversation",
        units: [
          {
            ...target.units[0]!,
            parts: [
              { kind: "text", segments: [{ kind: "redacted", label: "x" }] },
            ],
          },
        ],
      },
    },
  ])
    expect(() => request(bad)).toThrow();
});
test("findings reject invented strings, redacted labels, joined boundaries, wrong reasons, replacement fields; deduplicate", () => {
  expect(
    findings(
      { findings: [...verdict.findings, ...verdict.findings] },
      target,
      c().policy.categories,
    ),
  ).toHaveLength(1);
  for (const text of [
    "invented",
    "[REDACTED API KEY]",
    "123.[REDACTED",
    "KEY]No",
  ])
    expect(() =>
      findings(
        { findings: [{ ...verdict.findings[0], text }] },
        target,
        c().policy.categories,
      ),
    ).toThrow();
  expect(() =>
    findings(
      { findings: [{ ...verdict.findings[0], replacement: "evil" }] },
      target,
      c().policy.categories,
    ),
  ).toThrow();
  expect(() =>
    findings(
      { findings: [{ ...verdict.findings[0], reason: "other" }] },
      target,
      c().policy.categories,
    ),
  ).toThrow();
});
test("provider exact request, no auth/tools/store/developer, structured masking and successful clean/findings", async () => {
  let calls = 0;
  const transport: Fetch = async (url, init) => {
    calls++;
    expect(url.href).toBe(source.provider.base_url + "/chat/completions");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(init.redirect).toBe("error");
    expect(init.proxy).toBe("");
    const b = JSON.parse(String(init.body));
    expect(b.tools).toBeUndefined();
    expect(b.store).toBeUndefined();
    expect(b.stream).toBe(false);
    expect(b.response_format.type).toBe("json_object");
    expect(b.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(b.reasoning_effort).toBeUndefined();
    expect(b.messages.map((m: { role: string }) => m.role)).toEqual([
      "system",
      "user",
    ]);
    expect(JSON.parse(b.messages[1].content).target).toEqual(target);
    return envelope(verdict);
  };
  expect(
    await classify(c(), target, new AbortController().signal, transport),
  ).toEqual(verdict.findings);
  expect(calls).toBe(1);
  expect(
    await classify(c(), target, new AbortController().signal, async () =>
      envelope({ findings: [] }),
    ),
  ).toEqual([]);
});
test("reasoning rejects obsolete, mixed and unsupported config shapes", () => {
  for (const reasoning of [
    undefined,
    "off",
    {},
    { kind: "unknown" },
    { kind: "qwen_disabled", effort: "low" },
    { kind: "effort" },
    { kind: "effort", effort: "off" },
    { kind: "effort", effort: "high" },
    { kind: "effort", effort: "low", thinking: "off" },
  ]) {
    expect(() =>
      config({ ...source, provider: { ...source.provider, reasoning } }),
    ).toThrow(Failure);
  }
  const legacy: Record<string, unknown> = {
    ...source.provider,
    thinking: "off",
  };
  delete legacy.reasoning;
  expect(() => config({ ...source, provider: legacy })).toThrow(Failure);
  expect(() =>
    config({ ...source, provider: { ...source.provider, thinking: "off" } }),
  ).toThrow(Failure);
});

test("shipped examples validate explicit reasoning modes", async () => {
  for (const name of ["config.example.json", "config.gpt-oss.example.json"]) {
    const example = config(
      JSON.parse(
        await readFile(new URL("../" + name, import.meta.url), "utf8"),
      ),
    );
    expect(example.provider.reasoning.kind).toBe(
      name.includes("gpt-oss") ? "effort" : "qwen_disabled",
    );
  }
});

test("GPT-OSS sends low reasoning effort and consumes only complete final findings", async () => {
  const configured = c();
  configured.provider.base_url = "https://model.example.com/v1";
  configured.provider.model = "/models/gpt-oss-120b";
  configured.provider.reasoning = { kind: "effort", effort: "low" };
  let calls = 0;
  const actual = await classify(
    configured,
    target,
    new AbortController().signal,
    async (url, init) => {
      calls++;
      expect(url.href).toBe(configured.provider.base_url + "/chat/completions");
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      const wire = JSON.parse(String(init.body));
      expect(wire.model).toBe("/models/gpt-oss-120b");
      expect(wire.reasoning_effort).toBe("low");
      expect(wire.chat_template_kwargs).toBeUndefined();
      expect(wire.thinking).toBeUndefined();
      expect(wire.response_format).toEqual({ type: "json_object" });
      expect(
        wire.messages.map((message: { role: string }) => message.role),
      ).toEqual(["system", "user"]);
      expect(JSON.parse(wire.messages[1].content).target).toEqual(target);
      return envelope(verdict, "stop", {
        reasoning_content: "synthetic private analysis",
      });
    },
  );
  expect(calls).toBe(1);
  expect(actual).toEqual(verdict.findings);
  for (const response of [
    () => envelope(verdict, "length"),
    () =>
      envelope({}, "stop", {
        content: null,
        reasoning_content: "synthetic private analysis",
      }),
  ]) {
    await expect(
      classify(configured, target, new AbortController().signal, async () =>
        response(),
      ),
    ).rejects.toBeInstanceOf(Failure);
  }
});

test("provider fails closed on incomplete/refusal/tool calls/malformed output", async () => {
  for (const response of [
    () => envelope(verdict, "length"),
    () => envelope(verdict, "content_filter"),
    () => envelope(verdict, "stop", { refusal: "no" }),
    () => envelope(verdict, "stop", { tool_calls: [{}] }),
    () =>
      envelope({ findings: [{ ...verdict.findings[0], text: "not present" }] }),
    () => new Response('{"choices":[],"choices":[]}'),
    () => new Response("not json"),
  ])
    await expect(
      classify(c(), target, new AbortController().signal, async () =>
        response(),
      ),
    ).rejects.toBeInstanceOf(Failure);
});
test("429 and 5xx never retry, oversized declared and actual response fail", async () => {
  for (const status of [429, 503]) {
    let calls = 0;
    await expect(
      classify(c(), target, new AbortController().signal, async () => {
        calls++;
        return new Response("private", { status });
      }),
    ).rejects.toBeInstanceOf(Failure);
    expect(calls).toBe(1);
  }
  await expect(
    classify(
      c(),
      target,
      new AbortController().signal,
      async () =>
        new Response("x", { headers: { "content-length": "9999999" } }),
    ),
  ).rejects.toMatchObject({ code: "output_limit" });
  const small = c();
  small.provider.max_response_bytes = 10;
  await expect(
    classify(small, target, new AbortController().signal, async () =>
      envelope(verdict),
    ),
  ).rejects.toMatchObject({ code: "output_limit" });
});
test("cancellation and deadline abort actual transport", async () => {
  const hung: Fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      if (init.signal?.aborted) reject(new Error("aborted"));
      else
        init.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
    });
  const short = c();
  short.provider.timeout_ms = 20;
  await expect(
    classify(short, target, new AbortController().signal, hung),
  ).rejects.toMatchObject({ code: "deadline" });
  const controller = new AbortController();
  const pending = classify(c(), target, controller.signal, hung);
  setTimeout(() => controller.abort(), 10);
  await expect(pending).rejects.toMatchObject({ code: "cancelled" });
});
test("bounded reader cancels on overflow", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(20));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(readBounded(stream, 10)).rejects.toMatchObject({
    code: "output_limit",
  });
  expect(cancelled).toBe(true);
});
test("compiled executable accepts readable configs and refreshes config on each invocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "classifier-test-"));
  try {
    const binary = join(import.meta.dir, "../dist/content-classifier");
    const cfg = join(dir, "config.json");
    await writeFile(cfg, JSON.stringify(source), { mode: 0o644 });
    await chmod(cfg, 0o666);
    const sym = join(dir, "symbolic.json"),
      hard = join(dir, "hard.json");
    await symlink(cfg, sym);
    await link(cfg, hard);
    const run = async (
      selected: string,
      input: string,
      flags: string[] = [],
    ) => {
      const child = Bun.spawn([binary, "--config", selected, ...flags], {
        stdin: new Blob([input]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(err).toBe("");
      expect(out).not.toContain("secret-do-not-log");
      return { response: JSON.parse(out), exit };
    };
    for (const selected of [cfg, sym, hard, relative(process.cwd(), cfg)]) {
      expect((await load(selected)).provider.model).toBe(source.provider.model);
      expect(await run(selected, "{} {}")).toEqual({
        exit: 4,
        response: {
          version: 2,
          status: "error",
          code: "invalid_request",
        },
      });
    }
    // A config edit changes the next invocation without any generated artifact.
    const changed = structuredClone(source);
    changed.limits.max_input_bytes = 32;
    changed.limits.max_text_bytes = 16;
    await writeFile(cfg, JSON.stringify(changed));
    expect((await run(sym, "secret-do-not-log".repeat(10))).response.code).toBe(
      "output_limit",
    );
    await writeFile(cfg, JSON.stringify(source));
    expect(
      (await run(hard, "secret-do-not-log".repeat(10))).response.code,
    ).toBe("invalid_request");
    expect(
      (await run(cfg, "{}", ["--manifest", "obsolete.json"])).response.code,
    ).toBe("configuration_error");
    await writeFile(cfg, "invalid-config-secret-do-not-log");
    expect((await run(cfg, "{}")).response.code).toBe("configuration_error");
    await writeFile(cfg, "x".repeat(LIMITS.config + 1));
    expect((await run(cfg, "{}")).response.code).toBe("configuration_error");
    expect((await run(join(dir, "missing"), "{}")).response.code).toBe(
      "configuration_error",
    );
    expect((await run(dir, "{}")).response.code).toBe("configuration_error");
    const fifo = join(dir, "config.fifo");
    const mkfifo = Bun.spawn(["mkfifo", fifo], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await mkfifo.exited).toBe(0);
    expect((await run(fifo, "{}")).response.code).toBe("configuration_error");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);

test("readable bearer credential supplies only the configured key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "classifier-key-"));
  try {
    const path = join(directory, "key");
    await writeFile(path, "synthetic-private-key\n", { mode: 0o600 });
    const configured = c();
    configured.provider.auth = { kind: "bearer_file", path };
    expect(
      await classify(
        configured,
        target,
        new AbortController().signal,
        async (_url, init) => {
          expect(new Headers(init.headers).get("authorization")).toBe(
            "Bearer synthetic-private-key",
          );
          return envelope({ findings: [] });
        },
      ),
    ).toEqual([]);
    await chmod(path, 0o644);
    expect(
      await classify(
        configured,
        target,
        new AbortController().signal,
        async (_url, init) => {
          expect(new Headers(init.headers).get("authorization")).toBe(
            "Bearer synthetic-private-key",
          );
          return envelope({ findings: [] });
        },
      ),
    ).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("compiled helper cancels pending stdin and oversized input never invokes provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "classifier-cancel-"));
  try {
    const binary = join(import.meta.dir, "../dist/content-classifier");
    const cfg = join(directory, "config.json");
    await writeFile(cfg, JSON.stringify(source), { mode: 0o644 });
    const child = Bun.spawn([binary, "--config", cfg], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    await Bun.sleep(300);
    child.kill("SIGTERM");
    const result = await Promise.race([
      Promise.all([new Response(child.stdout).text(), child.exited]),
      Bun.sleep(3000).then(() => {
        child.kill("SIGKILL");
        throw new Error("cancel_not_reaped");
      }),
    ]);
    expect(JSON.parse(result[0]).code).toBe("cancelled");
    expect(result[1]).not.toBe(0);
    const oversized = Bun.spawn([binary, "--config", cfg], {
      stdin: new Blob(["x".repeat(LIMITS.input + 1)]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(oversized.stdout).text();
    expect(await oversized.exited).not.toBe(0);
    expect(JSON.parse(output).code).toBe("output_limit");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);

test("cross-language request/result fixtures preserve whole-unit multi-part contract", async () => {
  const input = request(
    strictJson(
      await readFile(
        join(import.meta.dir, "../fixtures/request-v4.json"),
        "utf8",
      ),
    ),
  );
  const result = JSON.parse(
    await readFile(
      join(import.meta.dir, "../fixtures/complete-v2.json"),
      "utf8",
    ),
  );
  expect((input.target as Target).units[0]!.parts).toHaveLength(2);
  expect(result.version).toBe(2);
  expect(
    findings(
      { findings: result.findings },
      input.target,
      c().policy.categories,
    ),
  ).toHaveLength(1);
});

test("ordered independent source nodes share a part without permitting cross-node invented text", () => {
  const target: Target = {
    kind: "conversation",
    units: [
      {
        target: true,
        role: "user",
        kind: "message",
        parts: [
          {
            kind: "text",
            segments: [
              { kind: "source", text: "synthetic-" },
              { kind: "source", text: "password" },
            ],
          },
        ],
      },
    ],
  };
  expect(
    (
      request({
        version: 4,
        policy,
        target,
      }).target as Target
    ).units[0]!.parts[0]!.segments,
  ).toHaveLength(2);
  expect(() =>
    findings(
      {
        findings: [
          {
            text: "synthetic-password",
            category: "credential",
            reason: "embedded_password",
          },
        ],
      },
      target,
      c().policy.categories,
    ),
  ).toThrow();
});

test("group contract preserves targets and context while rejecting obsolete shapes and aggregate excess", () => {
  const unit = target.units[0]!;
  const valid = {
    version: 4,
    policy,
    target: { kind: "conversation", units: [{ ...unit, target: false }, unit] },
  };
  expect((request(valid).target as Target).units.map((u) => u.target)).toEqual([
    false,
    true,
  ]);
  for (const bad of [
    { ...valid, target: unit },
    {
      ...valid,
      target: { kind: "conversation", units: [{ ...unit, target: undefined }] },
    },
    {
      ...valid,
      target: { kind: "conversation", units: [{ ...unit, target: "true" }] },
    },
    {
      ...valid,
      target: { kind: "conversation", units: [{ ...unit, target: false }] },
    },
    {
      ...valid,
      target: {
        kind: "conversation",
        units: [
          { ...unit, target: false },
          { ...unit, parts: [] },
        ],
      },
    },
    {
      ...valid,
      target: {
        kind: "conversation",
        units: Array.from({ length: LIMITS.units + 1 }, () => unit),
      },
    },
    {
      ...valid,
      target: {
        kind: "conversation",
        units: [
          {
            ...unit,
            parts: Array.from({ length: LIMITS.parts }, () => unit.parts[0]!),
          },
          { ...unit, parts: Array.from({ length: 1 }, () => unit.parts[0]!) },
        ],
      },
    },
    {
      ...valid,
      target: {
        kind: "conversation",
        units: [
          {
            ...unit,
            target: false,
            parts: [
              {
                kind: "text",
                segments: [{ kind: "source", text: "x".repeat(LIMITS.text) }],
              },
            ],
          },
          unit,
        ],
      },
    },
  ])
    expect(() => request(bad)).toThrow();
});

test("group findings use only exact target source segments and never cross unit or part boundaries", async () => {
  const grouped: Target = {
    kind: "conversation",
    units: [
      {
        role: "assistant",
        kind: "message",
        target: false,
        parts: [
          {
            kind: "text",
            segments: [
              { kind: "source", text: "CONTEXT_ONLY synthetic-pass-123" },
            ],
          },
        ],
      },
      {
        role: "user",
        kind: "message",
        target: true,
        parts: [
          {
            kind: "text",
            segments: [{ kind: "source", text: "synthetic-pass-123" }],
          },
        ],
      },
      {
        role: "tool",
        kind: "message",
        target: true,
        parts: [
          {
            kind: "tool_result",
            segments: [{ kind: "source", text: "suffix" }],
          },
          { kind: "text", segments: [{ kind: "source", text: "next" }] },
        ],
      },
    ],
  };
  for (const text of ["CONTEXT_ONLY", "synthetic-pass-123suffix", "suffixnext"])
    expect(() =>
      findings(
        { findings: [{ ...verdict.findings[0], text }] },
        grouped,
        c().policy.categories,
      ),
    ).toThrow();
  expect(findings(verdict, grouped, c().policy.categories)).toHaveLength(1);
  const payload = body(c(), grouped) as any;
  expect(JSON.parse(payload.messages[1].content).target).toEqual(grouped);
  expect(payload.messages[0].content).toContain("target=false");
  await expect(
    classify(c(), grouped, new AbortController().signal, async () =>
      envelope({
        findings: [{ ...verdict.findings[0], text: "CONTEXT_ONLY" }],
      }),
    ),
  ).rejects.toMatchObject({ code: "invalid_output_source" });
});

test("configured transport admits large groups and enforces each explicit bound", () => {
  const c = config(source);
  const unit = {
    target: true,
    role: "user",
    kind: "message",
    parts: [
      { kind: "text", segments: [{ kind: "source", text: "x".repeat(2048) }] },
    ],
  };
  const large = {
    version: 4,
    policy,
    target: {
      kind: "conversation",
      units: Array.from({ length: 64 }, () => unit),
    },
  };
  expect((request(large, c.limits).target as Target).units.length).toBe(64);
  expect(() => request(large, { ...c.limits, max_units: 32 })).toThrow();
  expect(() =>
    request(large, { ...c.limits, max_text_bytes: 65536 }),
  ).toThrow();
  expect(() => request(large, { ...c.limits, max_parts: 32 })).toThrow();
  expect(() => request(large, { ...c.limits, max_segments: 32 })).toThrow();
  expect(() =>
    config({
      ...source,
      limits: { ...source.limits, max_input_bytes: 268435457 },
    }),
  ).toThrow();
  expect(() =>
    config({ ...source, limits: { ...source.limits, max_findings: 0 } }),
  ).toThrow();
});

test("deployment config excludes semantic policy and rejects obsolete version", () => {
  expect(config(source).version).toBe(3);
  expect(() => config({ ...source, version: 1 })).toThrow();
  expect(() => config({ ...source, version: 2 })).toThrow();
  for (const field of ["model_revision", "authorization_scope_revision"])
    expect(() =>
      config({
        ...source,
        provider: { ...source.provider, [field]: "obsolete" },
      }),
    ).toThrow();
  expect(() => config({ ...source, policy })).toThrow();
});

test("request policy validates authoritative category descriptions and bounds", () => {
  const input = {
    version: 4,
    policy,
    target,
  };
  const category = policy.categories[0]!;
  expect(request(input).policy).toEqual(policy);
  for (const bad of [
    { ...input, version: 1 },
    { ...input, version: 3 },
    { ...input, configuration_id: "obsolete" },
    { ...input, policy: undefined },
    ...[
      { ...policy, instructions: "" },
      { ...policy, instructions: "embedded\0nul" },
      { ...policy, instructions: "x".repeat(32769) },
      { ...policy, prompt: "obsolete" },
      { ...policy, categories: [] },
      { ...policy, categories: [category, category] },
      ...[
        { ...category, id: "x".repeat(61) },
        { ...category, description: "control\ntext" },
        { ...category, description: "control\u0085text" },
        { ...category, inclusion: ["embedded\0nul"] },
        { ...category, exclusion: ["embedded\0nul"] },
        { ...category, examples: ["embedded\0nul"] },
        { ...category, description: "x".repeat(513) },
        { ...category, replacement: "not helper authority" },
        { ...category, action: "deny" },
        { ...category, inclusion: [""] },
        { ...category, exclusion: ["x".repeat(4097)] },
        { ...category, examples: Array(65).fill("example") },
        { ...category, reasons: ["duplicate", "duplicate"] },
      ].map((c) => ({ ...policy, categories: [c] })),
    ].map((p) => ({ ...input, policy: p })),
  ])
    expect(() => request(bad)).toThrow();
  const detailed = {
    ...policy,
    categories: [
      {
        ...category,
        description: "Credentials",
        inclusion: ["Private passwords"],
        exclusion: ["Public examples"],
        examples: ["Synthetic password"],
      },
    ],
  };
  expect(request({ ...input, policy: detailed }).policy).toEqual(detailed);
});
