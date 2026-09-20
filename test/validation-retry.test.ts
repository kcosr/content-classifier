import { estimatedTokens } from "../src/token-estimate";
import { policy } from "./policy";
import { expect, test } from "bun:test";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  config as deploymentConfig,
  type ScreeningConfig,
} from "../src/config";
import { body, classify, type Fetch } from "../src/provider";
import type { Target } from "../src/contract";

async function source(): Promise<any> {
  const value = JSON.parse(
    await readFile(
      new URL("../config.gpt-oss.example.json", import.meta.url),
      "utf8",
    ),
  );
  delete value.validation_retries;
  value.model_screening = {
    context_window_tokens: 32768,
    max_input_tokens: 24000,
    overlap_tokens: 512,
    prompt_reserve_tokens: 1024,
    estimation_margin_percent: 25,
    max_groups: 1024,
  };
  value.provider.timeout_ms = 10000;
  return value;
}
const target = (
  text = "42: Confidential acquisition of\n43: `Acme Corp` for $500 million.",
): Target => ({
  kind: "conversation",
  units: [
    {
      target: true,
      role: "user",
      kind: "message",
      parts: [{ kind: "text", segments: [{ kind: "source", text }] }],
    },
  ],
});
const fact = (text: string) => ({
  text,
  category: "credential",
  reason: "embedded_password",
});
const reply = (content: string, finish = "stop", extra = {}) =>
  Response.json({
    id: "private-provider-id-sentinel",
    object: "chat.completion",
    created: 0,
    model: "synthetic",
    choices: [
      {
        index: 0,
        finish_reason: finish,
        message: { role: "assistant", content, ...extra },
      },
    ],
  });
const clean = () => reply('{"findings":[]}');
const invalid = () =>
  reply(
    JSON.stringify({
      findings: [
        fact('Confidential acquisition of "Acme Corp" for $500 million.'),
      ],
    }),
  );
const repaired = () =>
  reply(
    JSON.stringify({ findings: [fact("Acme Corp"), fact("$500 million")] }),
  );

test("validation retry configuration defaults to one and accepts only bounded integers", async () => {
  const value = await source();
  expect(config(value).validation_retries ?? 1).toBe(1);
  for (const count of [0, 1, 3])
    expect(
      config({ ...value, validation_retries: count }).validation_retries,
    ).toBe(count);
  for (const count of [-1, 4, 1.5, "1", null, true])
    expect(() => config({ ...value, validation_retries: count })).toThrow();
});

test("malformed and nonexact output get one corrective attempt supporting multiple exact spans", async () => {
  for (const first of [invalid, () => reply('{"findings":[')]) {
    const c = config(await source()),
      input = target(),
      requests: any[] = [];
    const found = await classify(
      c,
      input,
      new AbortController().signal,
      async (_url, init) => {
        const request = JSON.parse(String(init.body));
        requests.push(request);
        return requests.length === 1 ? first() : repaired();
      },
    );
    expect(found).toEqual([fact("Acme Corp"), fact("$500 million")]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(body(c, input));
    expect(requests[1]).toEqual(body(c, input, true));
    expect(requests[1].messages[1]).toEqual(requests[0].messages[1]);
    expect(requests[1].messages).toHaveLength(2);
    expect(requests[1].messages[0].content).not.toEqual(
      requests[0].messages[0].content,
    );
    expect(requests[1].messages[0].content).toContain(
      "Each text must be a nonempty exact substring of one target=true source segment.",
    );
  }
});

test("invalid output exhausts exactly the configured retry count and zero disables correction", async () => {
  for (const retries of [0, 1, 3]) {
    const c = config({ ...(await source()), validation_retries: retries });
    let calls = 0;
    await expect(
      classify(c, target(), new AbortController().signal, async () => {
        calls++;
        return invalid();
      }),
    ).rejects.toMatchObject({ code: "invalid_output_source" });
    expect(calls).toBe(retries + 1);
  }
});

test("transport refusal incomplete and output bounds never trigger corrective retries", async () => {
  const cases: [() => Response, string][] = [
    [() => new Response("private", { status: 503 }), "provider_unavailable"],
    [() => new Response("private", { status: 429 }), "provider_overloaded"],
    [() => reply("{}", "stop", { refusal: "private" }), "provider_refused"],
    [() => reply("{}", "length"), "provider_incomplete"],
    [() => reply("{}", "content_filter"), "provider_refused"],
    [
      () => new Response("x", { headers: { "content-length": "9999999" } }),
      "output_limit",
    ],
    [
      () => {
        throw new Error("synthetic network failure");
      },
      "provider_unavailable",
    ],
  ];
  for (const [response, code] of cases) {
    let calls = 0;
    await expect(
      classify(
        config(await source()),
        target(),
        new AbortController().signal,
        async () => {
          calls++;
          return response();
        },
      ),
    ).rejects.toMatchObject({ code });
    expect(calls).toBe(1);
  }
  const c = config(await source());
  c.limits.max_output_bytes = 8;
  let calls = 0;
  await expect(
    classify(c, target(), new AbortController().signal, async () => {
      calls++;
      return invalid();
    }),
  ).rejects.toMatchObject({ code: "output_limit" });
  expect(calls).toBe(1);
});

async function overlapping(): Promise<ScreeningConfig> {
  const value = await source();
  value.provider.max_tokens = 512;
  value.model_screening = {
    context_window_tokens: 8000,
    max_input_tokens: 6000,
    overlap_tokens: 256,
    prompt_reserve_tokens: 1024,
    estimation_margin_percent: 25,
    max_groups: 128,
  };
  return config(value);
}

test("only the failed model window is repeated and aggregate findings remain unpublished on exhaustion", async () => {
  for (const recover of [true, false]) {
    const c = await overlapping(),
      models: string[] = [];
    const run = classify(
      c,
      target(Array.from({ length: 5000 }, (_, i) => `secret ${i} `).join("")),
      new AbortController().signal,
      async (url, init) => {
        expect(url.pathname).toBe("/v1/chat/completions");
        const request = JSON.parse(String(init.body));
        models.push(request.messages[1].content);
        if (models.length === 2 || (!recover && models.length === 3))
          return invalid();
        return reply(JSON.stringify({ findings: [fact("secret")] }));
      },
    );
    if (recover) expect(await run).toEqual([fact("secret")]);
    else
      await expect(run).rejects.toMatchObject({
        code: "invalid_output_source",
      });
    expect(models[2]).toBe(models[1]);
    expect(models[0]).not.toBe(models[1]);
    if (!recover) expect(models).toHaveLength(3);
  }
});

test("repair prompt is budgeted before generation", async () => {
  const c = await overlapping();
  c.model_screening.max_input_tokens = 128;
  c.model_screening.overlap_tokens = 0;
  let models = 0;
  await expect(
    classify(c, target("ordinary"), new AbortController().signal, async () => {
      models++;
      return clean();
    }),
  ).rejects.toMatchObject({ code: "output_limit" });
  expect(models).toBe(0);
});

test("correction shares the existing deadline and parent cancellation signal", async () => {
  for (const kind of ["deadline", "cancelled"] as const) {
    const c = config(await source()),
      controller = new AbortController();
    c.provider.timeout_ms = kind === "deadline" ? 80 : 10000;
    let calls = 0;
    const signals: AbortSignal[] = [];
    const transport: Fetch = async (_url, init) => {
      calls++;
      signals.push(init.signal!);
      if (calls === 1) return invalid();
      if (kind === "cancelled") queueMicrotask(() => controller.abort());
      return new Promise((_resolve, reject) => {
        if (init.signal?.aborted) reject(new Error("aborted"));
        else
          init.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
      });
    };
    await expect(
      classify(c, target(), controller.signal, transport),
    ).rejects.toMatchObject({ code: kind });
    expect(calls).toBe(2);
    expect(signals[1]).toBe(signals[0]);
  }
});

test("exhausted validation reports schema source and policy causes without provider text", async () => {
  const variants: [() => Response, string][] = [
    [() => reply('{"findings":['), "invalid_output_schema"],
    [invalid, "invalid_output_source"],
    [
      () =>
        reply(
          JSON.stringify({
            findings: [{ ...fact("Acme Corp"), reason: "not_allowed" }],
          }),
        ),
      "invalid_output_policy",
    ],
  ];
  for (const [response, code] of variants) {
    let calls = 0;
    await expect(
      classify(
        config(await source()),
        target(),
        new AbortController().signal,
        async () => {
          calls++;
          return response();
        },
      ),
    ).rejects.toMatchObject({ code, message: code });
    expect(calls).toBe(2);
  }
});

test("corrective output remains bounded and later corrective failure never retries transport", async () => {
  for (const [response, code] of [
    [
      () => new Response("x", { headers: { "content-length": "9999999" } }),
      "output_limit",
    ],
    [() => new Response("private", { status: 503 }), "provider_unavailable"],
  ] as [() => Response, string][]) {
    const c = config({ ...(await source()), validation_retries: 3 });
    let calls = 0;
    await expect(
      classify(c, target(), new AbortController().signal, async () => {
        calls++;
        return calls === 1 ? invalid() : response();
      }),
    ).rejects.toMatchObject({ code });
    expect(calls).toBe(2);
  }
});

test("disabling correction does not reserve nonexistent repair prompt tokens", async () => {
  const c = await overlapping();
  c.validation_retries = 0;
  const input = target();
  const estimate = (corrective: boolean) =>
    (body(c, input, corrective).messages as { content: string }[]).reduce(
      (n, m) =>
        n +
        estimatedTokens(m.content, c.model_screening.estimation_margin_percent),
      0,
    );
  c.model_screening.max_input_tokens = estimate(false);
  c.model_screening.overlap_tokens = 0;
  let models = 0;
  expect(
    await classify(c, input, new AbortController().signal, async (url) => {
      expect(url.pathname).toBe("/v1/chat/completions");
      models++;
      return clean();
    }),
  ).toEqual([]);
  expect(models).toBe(1);
  expect(estimate(true)).toBeGreaterThan(c.model_screening.max_input_tokens);
});

function config(value: unknown): ScreeningConfig {
  return { ...deploymentConfig(value), policy };
}

test("private diagnostics preserve exact wire requests and raw completion for every retry", async () => {
  const events: import("../src/diagnostics").DiagnosticEvent[] = [];
  const wire: string[] = [];
  const bad = JSON.stringify({ findings: [fact("invented diagnostic span")] });
  const good = JSON.stringify({ findings: [fact("Acme Corp")] });
  await classify(
    config(await source()),
    target(),
    new AbortController().signal,
    async (_url, init) => {
      wire.push(String(init.body));
      return reply(wire.length === 1 ? bad : good);
    },
    (event) => events.push(event),
  );
  expect(
    events
      .filter((e) => e.event === "classifier_request")
      .map((e) => e.request_body),
  ).toEqual(wire);
  expect(
    events
      .filter((e) => e.event === "classifier_response")
      .map((e) => e.completion_content),
  ).toEqual([bad, good]);
  expect(events.filter((e) => e.event === "classifier_attempt_result")).toEqual(
    [
      {
        version: 1,
        event: "classifier_attempt_result",
        window: 0,
        attempt: 0,
        outcome: "error",
        request_dispatched: true,
        validation_code: "invalid_output_source",
        finding_index: 0,
        validation_field: "text",
        retry: true,
      },
      {
        version: 1,
        event: "classifier_attempt_result",
        window: 0,
        attempt: 1,
        outcome: "complete",
        request_dispatched: true,
        retry: false,
      },
    ],
  );
  expect(JSON.stringify(events)).not.toContain("private-provider-id-sentinel");
});

test("diagnostic observer failure cannot change classification and malformed completion remains available", async () => {
  const c = config(await source());
  expect(
    await classify(
      c,
      target(),
      new AbortController().signal,
      async () => clean(),
      () => {
        throw new Error("private observer failure");
      },
    ),
  ).toEqual([]);
  const events: import("../src/diagnostics").DiagnosticEvent[] = [];
  let calls = 0;
  await classify(
    c,
    target(),
    new AbortController().signal,
    async () => (++calls === 1 ? reply('{"findings":[') : clean()),
    (e) => events.push(e),
  );
  expect(
    events.find((e) => e.event === "classifier_response")?.completion_content,
  ).toBe('{"findings":[');
  expect(
    events.find((e) => e.event === "classifier_attempt_result")
      ?.validation_code,
  ).toBe("invalid_output_schema");
});

test("private diagnostics exclude provider authorization, proxy credentials, and ambient environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "classifier-diagnostics-"));
  const variable = "CLASSIFIER_DIAGNOSTIC_TEST_PROXY";
  const old = process.env[variable];
  try {
    const c = config(await source());
    const path = join(directory, "key");
    await writeFile(path, "private-auth-sentinel", { mode: 0o600 });
    c.provider.auth = { kind: "bearer_file", path };
    c.egress = { kind: "proxy_env", variable };
    process.env[variable] =
      "http://private-user:private-proxy-sentinel@localhost:1234";
    const events: import("../src/diagnostics").DiagnosticEvent[] = [];
    await classify(
      c,
      target("evidence-sentinel"),
      new AbortController().signal,
      async (_url, init) => {
        expect(new Headers(init.headers).get("authorization")).toBe(
          "Bearer private-auth-sentinel",
        );
        return clean();
      },
      (e) => events.push(e),
    );
    const captured = JSON.stringify(events);
    expect(captured).toContain("evidence-sentinel");
    for (const excluded of [
      "private-auth-sentinel",
      "private-proxy-sentinel",
      variable,
      path,
      "private-provider-id-sentinel",
    ])
      expect(captured).not.toContain(excluded);
  } finally {
    if (old === undefined) delete process.env[variable];
    else process.env[variable] = old;
    await rm(directory, { recursive: true, force: true });
  }
});
