# Executable integration

[README](../README.md) · [Configuration](configuration.md) · [Development](development.md)

## Calling the classifier

Run the examples below from the repository root.

1. Build or install the executable independently of your application.
2. Select a readable configuration using `--config PATH`. Pass arguments directly
   to a subprocess API; no shell expansion is required.
3. Write one request to stdin and close it. Each process handles one request.
4. Drain stdout and stderr concurrently and enforce process/output limits. Parse
   stdout as a single response; successful classification requires exit zero,
   version 2, and `status: "complete"`.
5. Resolve each returned exact substring in the original source and apply your
   own reporting, review, or transformation policy. Repeated identical strings
   have no occurrence-specific distinction in this protocol.

An empty findings array means completed classification with no matches. A timeout,
nonzero exit, or error response is a failed classification, never a clean result:

```json
{ "version": 2, "status": "error", "code": "provider_unavailable" }
```

Errors use fixed codes; ordinary stderr is empty. Enable `--progress` only when
prepared to consume its separate JSONL events. Progress is advisory; only the
final response establishes completion. Callers do not need Bun at runtime or
access to this application's source code.

Try the supplied conversation request after configuring your endpoint:

```sh
./dist/content-classifier --config ./config.json < fixtures/request-v4.json
```

## Version-4 input

One JSON request on stdin, one JSON response on stdout. Input is strict UTF-8 JSON;
duplicate keys, unknown fields, malformed Unicode, and unbounded structures fail.

```json
{
  "version": 4,
  "policy": {
    "instructions": "Identify real embedded credentials. Exclude clearly synthetic examples.",
    "categories": [
      {
        "id": "credential",
        "reasons": ["embedded_secret"],
        "inclusion": ["Credentials embedded for authenticating to a service"],
        "exclusion": [
          "Public placeholders, integrity checksums, and clearly synthetic fixture values"
        ],
        "examples": []
      }
    ]
  },
  "target": {
    "kind": "file",
    "path": "src/settings.ts",
    "text": "const password = \"EXAMPLE_PASSWORD\";\n"
  }
}
```

### File inputs

- `path` is a relative POSIX path of at most 4096 UTF-8 bytes. Absolute paths,
  empty components, `.` or `..` components, and NUL are rejected.
- Other legal filename characters are preserved, including backslashes, colons,
  and Unicode. The model's `File:` header quotes the path as JSON and escapes
  control/format characters and Unicode line separators.
- `text` is nonempty original file content. Send the whole file; the classifier
  plans all chunks before invoking the model. Callers handle empty files.

The file's model user message is plain multiline text, not a JSON conversation:

```text
File: "src/settings.ts"
Chunk: 1 of 1
Original lines: 1–1

--- BEGIN FILE CONTENT ---
const password = "EXAMPLE_PASSWORD";

--- END FILE CONTENT ---
```

- Content is copied verbatim, without inserted line numbers or JSON escapes.
- Line ranges are one-based, inclusive, and LF-based; CRLF counts once. A trailing
  newline does not introduce an extra reported line.
- Overlap retains positions from the original input. Added headers and boundary
  markers cannot supply findings.
- Paths and source are untrusted evidence. Filename context never automatically
  exempts a file.

### Conversation inputs

For conversation input, replace the request’s `target` object with this shape:

```json
{
  "kind": "conversation",
  "units": [
    {
      "target": true,
      "role": "user",
      "kind": "message",
      "parts": [
        {
          "kind": "text",
          "segments": [{ "kind": "source", "text": "original message" }]
        }
      ]
    }
  ]
}
```

This mode retains its structured JSON model prompt, real roles, source/redacted
segments, and target/context boundaries. Context-only units cannot supply findings;
findings cannot cross source segments or match redacted labels. The classifier does
not mask content itself. The supported target kinds are `file` and `conversation`.

## Responses and findings

```json
{
  "version": 2,
  "status": "complete",
  "findings": [
    {
      "text": "exact source substring",
      "category": "credential",
      "reason": "embedded_secret"
    }
  ]
}
```

Findings return exact text, category, and reason only. They do not return source
positions or changed content. The caller resolves occurrences and decides what to
do. Equivalent findings are deduplicated across overlapping chunks.

## Policy reference

Each request supplies its own `policy`; model configuration does not contain it.
Instructions and categories enter the model's system message.

| Field                                | Requirements                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `instructions`                       | Nonempty, at most 32 KiB; no NUL                                                      |
| `categories`                         | 1–64 categories with unique IDs                                                       |
| `id`                                 | At most 60 bytes; starts with a letter, followed by letters, digits, `_`, `.`, or `-` |
| `reasons`                            | 1–64 unique identifiers, each at most 64 bytes, using the same identifier syntax      |
| `description`                        | Optional nonempty description, at most 512 bytes; no control characters               |
| `inclusion`, `exclusion`, `examples` | Required arrays; each allows 0–64 nonempty entries, up to 4 KiB per entry; no NUL     |

Output must use allowed IDs and reasons and match the actual chunk source.
Actions, replacements, and arbitrary output schemas are not accepted.

## Validation and failure handling

`validation_retries` defaults to 1 (range 0–3):

- Invalid finding schema, policy, or source matching can trigger correction on
  the same chunk, without echoing the invalid answer.
- Transport errors, refusal, truncated completion, and output-limit failures do
  not trigger correction. SDK/network retries are disabled.
- No findings publish unless every chunk completes. Failure returns a fixed
  metadata-only error envelope and a nonzero exit; raw provider errors are not printed.

| Exit code | Meaning                                         |
| --------- | ----------------------------------------------- |
| `0`       | Complete response written successfully          |
| `2`       | Invalid configuration or CLI arguments          |
| `3`       | Classification, cancellation, or output failure |
| `4`       | Invalid request                                 |

Common error codes include `configuration_error`, `invalid_request`,
`provider_unavailable`, `provider_overloaded`, `provider_refused`,
`provider_incomplete`, `invalid_output_schema`, `invalid_output_source`,
`invalid_output_policy`, `output_limit`, `deadline`, and `cancelled`.
The complete set is defined in [`src/contract.ts`](../src/contract.ts).

A failed stdout write may leave no complete response. Always inspect process
status as well as the response envelope.

## Progress

`--progress` emits bounded metadata-only JSON lines on stderr, for example:

```json
{
  "version": 1,
  "type": "progress",
  "stage": "classifying",
  "completed": 2,
  "total": 5
}
```

Planning emits `completed:0,total:0`. Classification first announces the total,
then advances for each successfully completed chunk; retries do not advance it.
No content, filenames, policy, findings, or provider identifiers appear. Progress
is best effort and cannot block classification. Without the flag stderr is empty.

## Private diagnostics

Append diagnostic arguments in this exact order after `--config PATH`:

```sh
./dist/content-classifier --config ./config.json \
  --diagnostic-fd 3 --diagnostic-max-record-bytes 1048576
```

The caller provides the inherited nonblocking descriptor 3 and sends the request
on stdin. The record bound is a decimal integer from 1 through 67108864 bytes (64 MiB),
without leading zeros.
A single `--progress` may appear anywhere in the argument list. Other diagnostic
flag orders or descriptor numbers are configuration errors.

This channel emits private, length-prefixed attempt frames. The
`--diagnostic-capabilities` probe requires no configuration file. Diagnostics contain exact
model request bodies and completion text and therefore sensitive source data;
callers own private capture, framing checks, limits, and storage. Authorization,
headers, credentials outside source evidence, and environment are excluded. Capture
is bounded and best effort; unavailable/full sinks cannot change classification.
