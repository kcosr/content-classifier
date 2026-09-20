# Content Classifier

Standalone Bun application for policy-driven classification through a versioned executable interface.

- Keep the CLI/stdin/stdout protocol strict, versioned, bounded, and metadata-only outside explicit private diagnostics.
- Preserve exact source text and validate findings against original source.
- Model invocation and token-budgeted chunking belong here; callers own policy and final actions.
- File input uses relative-path context and plain multiline content in model prompts. Conversation input retains genuine message roles.
- Do not add compatibility aliases or infer input kinds from shape.
- Run bun test, bun run check, bun run format:check, and bun run build for implementation changes.
