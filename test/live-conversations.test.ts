import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cases } from "../scripts/live-conversations";

const root = new URL("..", import.meta.url).pathname;
test("conversation live smoke requires explicit opt-in before reading settings or calling a provider", async () => {
  const child = Bun.spawn([process.execPath, "scripts/live-conversations.ts"], {
    cwd: root,
    env: { ...process.env, CLASSIFIER_LIVE_CONVERSATIONS: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(2);
  expect(await new Response(child.stdout).text()).toBe("");
  expect(await new Response(child.stderr).text()).toBe(
    "conversation_smoke_setup_failed_or_opt_in_missing\n",
  );
});
test("conversation live smoke exercises compiled stdin protocol and stores metadata-only expectations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conversation-smoke-test-"));
  const cert = join(dir, "cert.pem"),
    key = join(dir, "key.pem");
  const generate = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  expect(await generate.exited).toBe(0);
  const called = new Set<string>();
  const server = Bun.serve({
    port: 0,
    tls: { cert: Bun.file(cert), key: Bun.file(key) },
    async fetch(request) {
      const body = (await request.json()) as {
        messages: { content: string }[];
      };
      const text = body.messages[1]!.content;
      const target = JSON.parse(text).target as {
        units: {
          target: boolean;
          parts: { segments: { kind: string; text?: string }[] }[];
        }[];
      };
      const item = cases.find(
        ([, candidate]) =>
          JSON.stringify(candidate.units) === JSON.stringify(target.units),
      );
      if (!item) return new Response("invalid", { status: 500 });
      called.add(item[0]);
      const expectedText =
        item[0] === "group_target_password"
          ? "SYNTHETIC_TARGET_ONLY_9db1"
          : "SYNTHETIC_TEST_ONLY_PASSWORD_6b44e";
      return Response.json({
        id: "mock",
        object: "chat.completion",
        created: 0,
        model: "mock",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                findings: (item[2] ? [expectedText] : []).map((text) => ({
                  text,
                  category: "credential",
                  reason: "embedded_password",
                })),
              }),
            },
          },
        ],
      });
    },
  });
  try {
    const config = JSON.parse(
      await readFile(join(root, "config.gpt-oss.example.json"), "utf8"),
    );
    config.provider.base_url = `https://127.0.0.1:${server.port}/v1`;
    config.provider.timeout_ms = 10000;
    const configPath = join(dir, "config.json"),
      output = join(dir, "results");
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const child = Bun.spawn(
      [
        process.execPath,
        "scripts/live-conversations.ts",
        "--config",
        configPath,
        "--output",
        output,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          CLASSIFIER_LIVE_CONVERSATIONS: "1",
          NODE_EXTRA_CA_CERTS: cert,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stdout, stderr, called: [...called] }).toMatchObject({
      code: 0,
    });
    expect(stderr).toBe("");
    expect(called.size).toBe(cases.length);
    const raw = await readFile(join(output, "results.json"), "utf8");
    const result = JSON.parse(raw);
    expect(result.results.every((row: { passed: boolean }) => row.passed)).toBe(
      true,
    );
    for (const secret of [
      "SYNTHETIC_TEST_ONLY_PASSWORD_6b44e",
      "SYNTHETIC_TARGET_ONLY_9db1",
    ]) {
      expect(raw).not.toContain(secret);
      expect(stdout).not.toContain(secret);
    }
    expect(raw).not.toContain("127.0.0.1");
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});
