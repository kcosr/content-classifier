import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedProgressWriter, progress } from "../src/progress";
import { policy } from "./policy";

test("progress drops full-pipe events without queues and bounds total writes", () => {
  let calls = 0;
  const frames: Buffer[] = [];
  const observer = boundedProgressWriter((frame) => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("full"), { code: "EAGAIN" });
    frames.push(frame);
    return frame.length;
  }, 3);
  for (let i = 0; i < 10; i++) progress(observer, "classifying", i, 10);
  expect(calls).toBe(3);
  expect(frames).toHaveLength(2);
  for (const frame of frames) {
    expect(frame.length).toBeLessThan(1024);
    expect(Object.keys(JSON.parse(frame.toString())).sort()).toEqual([
      "completed",
      "stage",
      "total",
      "type",
      "version",
    ]);
  }
});
test("progress write errors and partial writes disable output without throwing", () => {
  for (const failure of [
    () => {
      throw new Error("closed");
    },
    () => 1,
  ]) {
    let calls = 0;
    const observer = boundedProgressWriter(() => {
      calls++;
      return failure();
    }, 10);
    for (let i = 0; i < 5; i++) progress(observer, "planning", 0, 0);
    expect(calls).toBe(1);
  }
  expect(() =>
    progress(
      () => {
        throw new Error("observer");
      },
      "planning",
      0,
      0,
    ),
  ).not.toThrow();
});
test("compiled helper progress is opt-in and coexists with diagnostic arguments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "classifier-progress-"));
  try {
    const binary = join(import.meta.dir, "../dist/content-classifier");
    const source = JSON.parse(
      await readFile(
        new URL("../config.example.json", import.meta.url),
        "utf8",
      ),
    );
    source.model_screening.max_input_tokens = 128;
    source.model_screening.overlap_tokens = 0;
    const cb = JSON.stringify(source);
    const cfg = join(dir, "config.json");
    await writeFile(cfg, cb, { mode: 0o644 });
    const request = {
      version: 4,
      policy,
      target: {
        kind: "conversation",
        units: [
          {
            role: "user",
            kind: "file",
            target: true,
            parts: [
              {
                kind: "text",
                segments: [
                  { kind: "source", text: "private input never logged" },
                ],
              },
            ],
          },
        ],
      },
    };
    for (const flags of [
      [],
      ["--progress"],
      [
        "--diagnostic-fd",
        "3",
        "--diagnostic-max-record-bytes",
        "1024",
        "--progress",
      ],
    ]) {
      // Exercise a Node.js caller, including socket-backed stdio.
      const launcher = `
        const {spawn}=require("node:child_process");
        const child=spawn(process.argv[1],process.argv.slice(2),{stdio:["pipe","pipe","pipe"]});
        let stdout="",stderr="";
        child.stdout.on("data",b=>stdout+=b);child.stderr.on("data",b=>stderr+=b);
        child.on("close",code=>process.stdout.write(JSON.stringify({stdout,stderr,code})));
        child.stdin.end(require("node:fs").readFileSync(0));
      `;
      const child = Bun.spawn(
        [Bun.which("node")!, "-e", launcher, binary, "--config", cfg, ...flags],
        {
          stdin: new Blob([JSON.stringify(request)]),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      const { stdout, stderr, code } = JSON.parse(output) as {
        stdout: string;
        stderr: string;
        code: number;
      };
      expect(code).toBe(3);
      expect(JSON.parse(stdout)).toEqual({
        version: 2,
        status: "error",
        code: "output_limit",
      });
      expect(stderr).not.toContain("private input");
      if (flags.length)
        expect(
          stderr
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual([
          {
            version: 1,
            type: "progress",
            stage: "planning",
            completed: 0,
            total: 0,
          },
        ]);
      else expect(stderr).toBe("");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
