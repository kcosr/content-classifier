import { mkdir } from "node:fs/promises";
await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
const output = new URL("../dist/content-classifier", import.meta.url).pathname;
const result = await Bun.build({
  entrypoints: [new URL("../src/main.ts", import.meta.url).pathname],
  minify: true,
  compile: {
    outfile: output,
    execArgv: ["--use-system-ca"],
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
});
if (!result.success) {
  console.error("classifier_build_failed");
  process.exitCode = 1;
}
