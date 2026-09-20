import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { policy } from "./policy";
import { config, type ScreeningConfig } from "../src/config";
import { classify, body } from "../src/provider";
import { estimatedTokens } from "../src/token-estimate";
import { type ConversationTarget as Target } from "../src/contract";
async function settings(): Promise<ScreeningConfig> {
  const source = JSON.parse(
    await readFile(
      new URL("../config.gpt-oss.example.json", import.meta.url),
      "utf8",
    ),
  );
  source.provider.timeout_ms = 10000;
  source.provider.max_tokens = 512;
  source.model_screening = {
    context_window_tokens: 8000,
    max_input_tokens: 6000,
    overlap_tokens: 256,
    prompt_reserve_tokens: 1024,
    estimation_margin_percent: 25,
    max_groups: 128,
  };
  return { ...config(source), policy };
}
const target = (text: string): Target => ({
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
const finding = {
  text: "secret",
  category: "credential",
  reason: "embedded_password",
};
const reply = (found: unknown[] = []) =>
  Response.json({
    id: "synthetic",
    object: "chat.completion",
    created: 0,
    model: "synthetic",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify({ findings: found }),
        },
      },
    ],
  });
test("local estimate budgets complete prompts including correction without tokenizer calls", async () => {
  const c = await settings();
  let calls = 0;
  const found = await classify(
    c,
    target("secret ".repeat(5000)),
    new AbortController().signal,
    async (url, init) => {
      expect(url.pathname).toBe("/v1/chat/completions");
      calls++;
      const wire = JSON.parse(String(init.body));
      const group = JSON.parse(wire.messages[1].content).target;
      const corrected = body(c, group, true).messages as { content: string }[];
      const count = corrected.reduce(
        (n, m) => n + estimatedTokens(m.content, 25),
        0,
      );
      expect(count).toBeLessThanOrEqual(6000);
      expect(count + 512 + 1024).toBeLessThanOrEqual(8000);
      return reply([finding]);
    },
  );
  expect(calls).toBeGreaterThan(1);
  expect(found).toEqual([finding]);
});
test("late failure does not publish earlier windows", async () => {
  const c = await settings();
  let calls = 0;
  await expect(
    classify(
      c,
      target("secret ".repeat(5000)),
      new AbortController().signal,
      async () =>
        ++calls === 1
          ? reply([finding])
          : new Response("private", { status: 503 }),
    ),
  ).rejects.toThrow("provider_unavailable");
  expect(calls).toBe(2);
});
test("group exhaustion and oversized policy fail before generation", async () => {
  for (const largePolicy of [false, true]) {
    const c = await settings();
    c.model_screening.max_groups = 1;
    if (largePolicy)
      c.policy = { ...policy, instructions: "instruction ".repeat(10000) };
    let calls = 0;
    await expect(
      classify(
        c,
        target("secret ".repeat(5000)),
        new AbortController().signal,
        async () => {
          calls++;
          return reply();
        },
      ),
    ).rejects.toThrow("output_limit");
    expect(calls).toBe(0);
  }
});
test("provider context rejection and truncation fail closed", async () => {
  for (const response of [
    () => new Response("context length exceeded", { status: 400 }),
    () =>
      Response.json({
        choices: [
          {
            index: 0,
            finish_reason: "length",
            message: { role: "assistant", content: '{"findings":[]}' },
          },
        ],
      }),
  ])
    await expect(
      classify(
        await settings(),
        target("ordinary"),
        new AbortController().signal,
        async () => response(),
      ),
    ).rejects.toThrow();
});
test("obsolete planner shapes and invalid relationships are rejected", async () => {
  const c = await settings();
  const { policy: _, ...base } = c;
  for (const shape of [
    { kind: "single" },
    { ...c.model_screening, tokenizer_url: "https://example.test/tokenize" },
    { ...c.model_screening, overlap_tokens: 6000 },
    { ...c.model_screening, context_window_tokens: 600 },
  ])
    expect(() => config({ ...base, model_screening: shape })).toThrow();
});
test("estimator handles ASCII runs and Unicode scalars deterministically", () => {
  expect(estimatedTokens("abcde")).toBe(3);
  expect(estimatedTokens("é😀中")).toBe(9);
  expect(estimatedTokens("a !\n")).toBe(4);
  expect(estimatedTokens("abcde", 25)).toBe(4);
});

test("progress describes planning and successful windows without repeating retries", async () => {
  const c = await settings();
  const events: import("../src/progress").ProgressEvent[] = [];
  let calls = 0;
  await classify(
    c,
    target("secret ".repeat(5000)),
    new AbortController().signal,
    async () => {
      calls++;
      return calls === 1
        ? reply([{ ...finding, text: "invented" }])
        : reply([finding]);
    },
    undefined,
    (event) => events.push(event),
  );
  expect(events[0]).toEqual({
    version: 1,
    type: "progress",
    stage: "planning",
    completed: 0,
    total: 0,
  });
  const windows = events[1]!.total;
  expect(windows).toBeGreaterThan(1);
  expect(calls).toBe(windows + 1);
  expect(events.slice(1).map((e) => e.completed)).toEqual(
    Array.from({ length: windows + 1 }, (_, i) => i),
  );
  expect(
    events
      .slice(1)
      .every((e) => e.total === windows && e.stage === "classifying"),
  ).toBe(true);
  expect(
    await classify(
      c,
      target("secret"),
      new AbortController().signal,
      async () => reply([finding]),
      undefined,
      () => {
        throw new Error("broken progress");
      },
    ),
  ).toEqual([finding]);
});
test("failed windows are never reported complete", async () => {
  const events: import("../src/progress").ProgressEvent[] = [];
  let calls = 0;
  await expect(
    classify(
      await settings(),
      target("secret ".repeat(5000)),
      new AbortController().signal,
      async () =>
        ++calls === 1
          ? reply([finding])
          : new Response("failure", { status: 503 }),
      undefined,
      (event) => events.push(event),
    ),
  ).rejects.toThrow("provider_unavailable");
  expect(events.at(-1)!.completed).toBe(1);
  expect(events.at(-1)!.total).toBeGreaterThan(1);
});
