# Configuration

[README](../README.md) · [Executable integration](integration.md) · [Development](development.md)

Start with [`config.example.json`](../config.example.json) for Qwen with reasoning
disabled, or [`config.gpt-oss.example.json`](../config.gpt-oss.example.json) for low
reasoning effort. Both use placeholder endpoints that you must replace.

```sh
./dist/content-classifier --config ./config.json < request.json
```

Configuration uses version **3**. Each invocation reads the selected file directly,
so edits take effect on the next invocation without rebuilding. The file must be a
readable regular file of at most 256 KiB. Relative paths, symlinks, hard links, and
shared system files are supported under ordinary filesystem permissions.

JSON validation is strict: unknown fields, duplicate keys, invalid values, and
unsupported versions fail with `configuration_error` and exit code 2. Classification
instructions and categories belong in each request's [`policy`](integration.md#policy-reference).

## Model connection

The provider must support nonstreaming Chat Completions with JSON-object output.
The classifier sends one completion per chunk, plus configured correction attempts.

| Setting                       | Meaning                                                               |
| ----------------------------- | --------------------------------------------------------------------- |
| `provider.base_url`           | HTTPS URL ending in `/v1`; no URL credentials, query, or fragment     |
| `provider.model`              | Model identifier understood by your endpoint                          |
| `provider.auth`               | `{"kind":"none"}` or `{"kind":"bearer_file","path":"/path/to/token"}` |
| `provider.reasoning`          | `{"kind":"qwen_disabled"}` or `{"kind":"effort","effort":"low"}`      |
| `provider.output_format`      | Must be `"json_object"`                                               |
| `provider.max_tokens`         | Completion token limit, 1–32768                                       |
| `provider.max_response_bytes` | Response body limit, 1–524288 bytes                                   |
| `provider.timeout_ms`         | Classification deadline, 1–28800000 milliseconds                      |
| `validation_retries`          | Correction attempts per chunk, 0–3; defaults to 1                     |

Choose the reasoning mode supported by the provider; the classifier does not
infer it from the model name. Authentication `none` sends no Authorization header.
A bearer file contains a token, optionally ending with a single LF or CRLF;
other surrounding whitespace and control characters are rejected. Relative token
paths resolve from the process working directory.

## Network and certificates

Use `{"kind":"direct"}` for direct egress. To select a proxy explicitly:

```json
{ "egress": { "kind": "proxy_env", "variable": "HTTPS_PROXY" } }
```

The variable name must be 1–64 characters, start with an uppercase ASCII letter,
and contain only uppercase ASCII letters, digits, or underscores. Lowercase names
such as `https_proxy` are rejected.

The named environment variable must contain an HTTP or HTTPS proxy URL with no
query, fragment, or path beyond `/`. Redirects from the model endpoint are rejected.

The compiled executable uses the system certificate authorities, including locally
installed authorities. Dotenv and bunfig autoload are disabled. Configuration and
authentication come from the explicit configuration path and its selected sources.

## Token budgets and chunking

This configuration excerpt shows the example token budgets:

```json
{
  "model_screening": {
    "context_window_tokens": 32768,
    "max_input_tokens": 24000,
    "overlap_tokens": 512,
    "prompt_reserve_tokens": 1024,
    "estimation_margin_percent": 25,
    "max_groups": 1024
  }
}
```

| Setting                     | Controls                                             |
| --------------------------- | ---------------------------------------------------- |
| `context_window_tokens`     | Total model context capacity                         |
| `max_input_tokens`          | Maximum estimated input per chunk, including prompts |
| `overlap_tokens`            | Estimated source overlap between adjacent chunks     |
| `prompt_reserve_tokens`     | Capacity reserved for provider templates             |
| `estimation_margin_percent` | Extra allowance applied to local token estimates     |
| `max_groups`                | Maximum number of planned chunks                     |

The effective input budget must be at least 128 tokens. Configured overlap cannot
exceed one quarter of that budget.

Effective input budget is the smaller of `max_input_tokens` and
`context_window_tokens - provider.max_tokens - prompt_reserve_tokens`. Full system
and user prompts count, including file metadata and correction when enabled.
Chunk index/total metadata is conservatively reserved before final chunk counts
are known. Every final prompt is checked. The reserve covers provider templates;
completion capacity is reserved separately.

The estimator counts ASCII alphanumeric runs as `ceil(length / 2)`, other ASCII
characters as one, and other Unicode scalars by UTF-8 byte length, then applies the
margin. It is not an exact tokenizer or universal bound. Provider context rejection
fails the invocation; content is never silently truncated. Overlap uses the same
estimate, capped against usable capacity, and preserves Unicode scalar boundaries.

## Deadlines and size limits

`provider.timeout_ms` bounds classification, including planning and all
chunks/corrections. It starts after configuration and stdin have been read. Size
both this deadline and the caller's process timeout for the expected number of
model calls. The caller should allow cleanup headroom and bound stdin/output I/O.

Transport and output byte caps are independent of token budgets. The example
configuration uses these limits:

| `limits` field      | Example value                |
| ------------------- | ---------------------------- |
| `max_input_bytes`   | 64 MiB of request JSON       |
| `max_text_bytes`    | 8 MiB of content             |
| `max_output_bytes`  | 1 MiB of response JSON       |
| `max_findings`      | 4096 findings                |
| `max_finding_bytes` | 64 KiB per finding text      |
| `max_units`         | 4096 conversation units      |
| `max_parts`         | 65536 conversation parts     |
| `max_segments`      | 262144 conversation segments |

`max_text_bytes` cannot exceed `max_input_bytes`. All configured counts and byte
limits must be positive integers within the bounds in
[`src/contract.ts`](../src/contract.ts).
