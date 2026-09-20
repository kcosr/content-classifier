# Development and testing

[README](../README.md) · [Executable integration](integration.md) · [Configuration](configuration.md)

Run commands from the repository root. The build uses Bun 1.4.2 and dependencies
locked in `bun.lock`. Build before testing: the executable integration tests use
`dist/content-classifier`.

```sh
bun install --frozen-lockfile
bun run check
bun run build
bun test
bun run format:check
```

| Command                | Checks or output                                                            |
| ---------------------- | --------------------------------------------------------------------------- |
| `bun run check`        | TypeScript type checking                                                    |
| `bun test`             | Contract, chunking, provider, and CLI tests using local or mocked providers |
| `bun run format:check` | Source, script, and test formatting                                         |
| `bun run build`        | Standalone executable at `dist/content-classifier`                          |

The compiled executable needs no separate Bun interpreter or runtime dependency
downloads. It uses system CAs and disables dotenv and bunfig autoload. Build and
version it independently of calling applications.

## Opt-in conversation smoke test

Standard tests use mocked providers. To run synthetic conversation cases against
your own endpoint, supply a configuration explicitly:

```sh
CLASSIFIER_LIVE_CONVERSATIONS=1 \
  bun scripts/live-conversations.ts --config /absolute/model-config.json
```

The script invokes `dist/content-classifier` and checks clean content, password
findings, redacted segments, multiple parts, and context-only boundaries.

- `--executable` selects another binary.
- `--output` selects the result directory; the default is
  `var/conversation-smoke/<timestamp>`.
- Results contain only case IDs, counts, timing, and pass/fail status.
- No provider is called without explicit opt-in.

## Opt-in file audit smoke test

The generic runtime contains no credential-specific policy. The caller-supplied
[credential audit example](../examples/credential-audit-policy.json) distinguishes
synthetic scanner fixtures and hashes from embedded remote-authentication values.
A test filename provides context rather than automatic exemption. These are model
judgments, so a passing smoke run does not guarantee accuracy on other sources.

```sh
CLASSIFIER_LIVE_FILES=1 \
  bun scripts/live-files.ts \
  --config /absolute/model-config.json \
  --policy examples/credential-audit-policy.json
```

The script calls the endpoint selected by `--config` through the compiled
`dist/content-classifier`, using a temporary configuration copy.

- `--executable` selects another binary.
- `--output` selects the metadata result directory; the default is
  `var/file-smoke/<timestamp>`.
- The child inherits the caller's CA environment and uses the installed system CAs.
- No provider is called without explicit opt-in. Temporary configuration copies
  are removed after completion.

Five synthetic cases cover a fabricated fixture, documentation placeholders,
a package checksum, remote-authentication source, and remote authentication under
a test path. The same invented password appears in fixture and positive cases to
test contextual judgment. Negative cases must be clean; positives must return the
expected exact credential substring.

Result JSON contains case IDs, pass/fail, counts, and durations. It excludes source
text, finding strings, endpoint URLs, and credentials.

## Live-test exit codes

Both live-test scripts use the same exit codes:

| Code | Meaning               |
| ---- | --------------------- |
| `0`  | All cases passed      |
| `1`  | A case failed         |
| `2`  | Setup or opt-in error |

`bun test` includes a localhost HTTPS mock of this compiled-CLI path; it requires
`openssl` to generate its ephemeral certificate and never calls the live endpoint.
