/** Opt-in, synthetic end-to-end file smoke test. Results contain metadata only. */
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { config } from "../src/config";
import {
  decode,
  findings,
  keys,
  object,
  readBounded,
  request,
  semanticPolicy,
  strictJson,
} from "../src/contract";

export const cases = [
  {
    id: "explicit_test_fixture",
    path: "test/password.test.ts",
    text: 'import {expect, test} from "bun:test";\n// Deliberately fabricated fixture. No remote authentication; parser assertion only.\nconst dummyPassword = "q9Tr7!Km2xW8vR5p";\ntest("password extraction", () => expect(parsePassword(dummyPassword)).toBe(dummyPassword));\n',
    expected: [],
  },
  {
    id: "documented_example",
    path: "examples/client.md",
    text: "# Authentication example\nReplace the placeholder with your own key, loaded from the environment.\n```sh\nAPI_KEY=YOUR_API_KEY_HERE example-client\n```\n",
    expected: [],
  },
  {
    id: "integrity_checksum",
    path: "package-lock.json",
    text: '{"packages":{"node_modules/example":{"version":"1.0.0","integrity":"sha512-DHdEaCgpNlpPnYy62HNXJPFAAlPGHVJKLp9QQ53PB74myFKPiPNV68WLGR5WLMVyp5vrKO3L2FjgCrJACqpRXQ=="}}}\n',
    expected: [],
  },
  {
    id: "embedded_remote_auth",
    path: "src/customer-service.ts",
    text: 'const servicePassword = "q9Tr7!Km2xW8vR5p";\nexport async function fetchCustomer(id: string) {\n  return fetch(`https://customers.example.com/customers/${id}`, {\n    headers: {Authorization: "Basic " + btoa("service-reader:" + servicePassword)}\n  });\n}\n',
    expected: ["q9Tr7!Km2xW8vR5p"],
  },
  {
    id: "test_path_remote_auth",
    path: "test/live-customer.test.ts",
    text: '// Live integration against the deployed customer service; authenticates remotely.\nconst servicePassword = "q9Tr7!Km2xW8vR5p";\nexport async function integrationCheck() {\n  return fetch("https://customers.example.com/customers/42", {\n    headers: {Authorization: "Basic " + btoa("service-reader:" + servicePassword)}\n  });\n}\n',
    expected: ["q9Tr7!Km2xW8vR5p"],
  },
];

async function main() {
  if (process.env.CLASSIFIER_LIVE_FILES !== "1")
    throw new Error("explicit_live_opt_in_required");
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!,
      value = args[i + 1];
    if (
      !["--config", "--policy", "--executable", "--output"].includes(name) ||
      !value ||
      values.has(name)
    )
      throw new Error("invalid_arguments");
    values.set(name, value);
  }
  if (!values.has("--config") || !values.has("--policy"))
    throw new Error("config_and_policy_required");
  const binary = await realpath(
    resolve(values.get("--executable") ?? "dist/content-classifier"),
  );
  const configBytes = await readFile(resolve(values.get("--config")!));
  const settings = config(strictJson(decode(configBytes)));
  const policy = semanticPolicy(
    strictJson(decode(await readFile(resolve(values.get("--policy")!)))),
  );
  const output = resolve(
    values.get("--output") ??
      join("var/file-smoke", new Date().toISOString().replaceAll(":", "-")),
  );
  await mkdir(output, { recursive: true, mode: 0o700 });
  await chmod(output, 0o700);
  const staging = await realpath(
    await mkdtemp(join(tmpdir(), "classifier-file-smoke-")),
  );
  try {
    const configPath = join(staging, "config.json");
    await writeFile(configPath, configBytes, { mode: 0o600 });
    const results = [];
    for (const item of cases) {
      const target = {
        kind: "file" as const,
        path: item.path,
        text: item.text,
      };
      const input = request({ version: 4, policy, target }, settings.limits);
      const started = performance.now();
      const child = Bun.spawn([binary, "--config", configPath], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        child.kill("SIGKILL");
      }, settings.provider.timeout_ms + 10000);
      let passed = false,
        result = "process_failed",
        count = 0;
      try {
        await child.stdin.write(JSON.stringify(input));
        child.stdin.end();
        const [stdout, stderr, code] = await Promise.all([
          readBounded(child.stdout, settings.limits.max_output_bytes),
          readBounded(child.stderr, 4096),
          child.exited,
        ]);
        const response = object(strictJson(decode(stdout)));
        if (code !== 0 || stderr.length !== 0)
          throw new Error("process_failed");
        keys(response, ["version", "status", "findings"]);
        if (response.version !== 2 || response.status !== "complete")
          throw new Error("invalid_response");
        const found = findings(
          { findings: response.findings },
          target,
          policy.categories,
          settings.limits,
        );
        count = found.length;
        passed =
          item.expected.length === 0
            ? found.length === 0
            : item.expected.every((text) => found.some((f) => f.text === text));
        result = passed ? "pass" : "unexpected_findings";
      } catch {
        result = expired ? "deadline" : "invalid_or_failed_response";
      } finally {
        clearTimeout(timer);
        child.kill("SIGKILL");
        await child.exited;
      }
      results.push({
        case: item.id,
        passed,
        result,
        finding_count: count,
        duration_ms: Math.round(performance.now() - started),
      });
      console.log(JSON.stringify({ case: item.id, passed, result }));
    }
    await writeFile(
      join(output, "results.json"),
      JSON.stringify(
        {
          version: 1,
          results,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    if (results.some((result) => !result.passed)) process.exitCode = 1;
  } finally {
    configBytes.fill(0);
    await rm(staging, { recursive: true, force: true });
  }
}
if (import.meta.main)
  main().catch(() => {
    console.error("file_smoke_setup_failed_or_opt_in_missing");
    process.exitCode = 2;
  });
