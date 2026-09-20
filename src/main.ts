import { diagnosticWriter } from "./diagnostics";
import { load } from "./config";
import {
  Failure,
  LIMITS,
  decode,
  readBounded,
  request,
  strictJson,
} from "./contract";
import { classify } from "./provider";
import { progressWriter } from "./progress";
const control = new AbortController();
process.on("SIGTERM", () => control.abort());
process.on("SIGINT", () => control.abort());
async function emit(output: string): Promise<void> {
  try {
    await Bun.write(Bun.stdout, output);
  } catch {
    process.exitCode = 3;
  }
}
let diagnostics: ReturnType<typeof diagnosticWriter> | undefined;
let progressOutput: ReturnType<typeof progressWriter> | undefined;
try {
  const args = process.argv.slice(2);
  const progressIndex = args.indexOf("--progress");
  const showProgress = progressIndex >= 0;
  if (showProgress) args.splice(progressIndex, 1);
  if (args.length === 1 && args[0] === "--diagnostic-capabilities") {
    await emit(
      JSON.stringify({
        version: 1,
        transport: "inherited_pipe",
        events: "classifier_attempts",
      }) + "\n",
    );
    process.exit(process.exitCode ?? 0);
  }
  if (
    args.length === 6 &&
    args[2] === "--diagnostic-fd" &&
    args[3] === "3" &&
    args[4] === "--diagnostic-max-record-bytes" &&
    /^[1-9][0-9]*$/.test(args[5]!)
  ) {
    const limit = Number(args[5]);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 * 1024 * 1024)
      throw new Failure("configuration_error");
    diagnostics = diagnosticWriter(3, limit);
    args.length = 2;
  }
  if (args.length !== 2 || args[0] !== "--config")
    throw new Failure("configuration_error");
  const configuration = await load(args[1]!);
  const stdin = await readBounded(
    Bun.stdin.stream(),
    configuration.limits.max_input_bytes,
    control.signal,
  );
  let input;
  try {
    input = request(strictJson(decode(stdin)), configuration.limits);
  } finally {
    stdin.fill(0);
  }
  if (showProgress)
    progressOutput = progressWriter(
      configuration.model_screening.max_groups + 2,
    );
  const found = await classify(
    { ...configuration, policy: input.policy },
    input.target,
    control.signal,
    undefined,
    diagnostics?.emit,
    progressOutput?.emit,
  );
  if (control.signal.aborted) throw new Failure("cancelled");
  const output =
    JSON.stringify({
      version: 2,
      status: "complete",
      findings: found,
    }) + "\n";
  if (Buffer.byteLength(output) > configuration.limits.max_output_bytes)
    throw new Failure("output_limit");
  await emit(output);
} catch (error) {
  const code = error instanceof Failure ? error.code : "process_failed";
  await emit(
    JSON.stringify({
      version: 2,
      status: "error",
      code,
    }) + "\n",
  );
  process.exitCode =
    code === "configuration_error" ? 2 : code === "invalid_request" ? 4 : 3;
} finally {
  diagnostics?.finish();
  progressOutput?.finish();
}
