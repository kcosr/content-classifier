/** Version 1 heuristic, not an exact model tokenizer or universal upper bound. */
export function estimatedTokens(text: string, marginPercent = 0): number {
  let tokens = 0,
    run = 0;
  for (const scalar of text) {
    if (/^[A-Za-z0-9]$/.test(scalar)) {
      run++;
      continue;
    }
    tokens += Math.ceil(run / 2);
    run = 0;
    tokens +=
      scalar.codePointAt(0)! < 128 ? 1 : Buffer.byteLength(scalar, "utf8");
  }
  return Math.ceil(
    ((tokens + Math.ceil(run / 2)) * (100 + marginPercent)) / 100,
  );
}
