import { Failure, type FileTarget } from "./contract";
import { prefix } from "./model-groups";

/** Offsets are internal UTF-16 source indices, never model-supplied positions. */
export interface FileWindow extends FileTarget {
  chunk: {
    index: number;
    total: number;
    startLine: number;
    endLine: number;
    startOffset: number;
    endOffset: number;
  };
}
export interface FileGroupOptions {
  maxTokens: number;
  overlapTokens: number;
  maxGroups: number;
  estimate: (window: FileWindow) => number;
  estimateText: (text: string) => number;
  /** Optional proven bound for BOTH estimators: source UTF-16 units per token.
   * Callers with arbitrary estimators can omit this optimization. */
  maxSourceCodeUnitsPerToken?: number;
  shouldStop?: () => boolean;
}

export function fileGroups(
  target: FileTarget,
  options: FileGroupOptions,
): FileWindow[] {
  const { maxTokens, overlapTokens, maxGroups, estimate, estimateText } =
    options;
  if (
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 128 ||
    !Number.isSafeInteger(overlapTokens) ||
    overlapTokens < 0 ||
    overlapTokens > maxTokens / 4 ||
    !Number.isSafeInteger(maxGroups) ||
    maxGroups < 1 ||
    maxGroups > 16384 ||
    (options.maxSourceCodeUnitsPerToken !== undefined &&
      (!Number.isFinite(options.maxSourceCodeUnitsPerToken) ||
        options.maxSourceCodeUnitsPerToken <= 0 ||
        options.maxSourceCodeUnitsPerToken * maxTokens >
          Number.MAX_SAFE_INTEGER))
  )
    throw new Failure("invalid_request");
  const check = () => {
    if (options.shouldStop?.()) throw new Failure("cancelled");
  };
  const lineStarts = [0];
  for (let i = 0; i < target.text.length; i++) {
    if ((i & 65535) === 0) check();
    if (target.text[i] === "\n") lineStarts.push(i + 1);
  }
  const lineAt = (offset: number) => {
    let low = 0,
      high = lineStarts.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (lineStarts[mid]! <= offset) low = mid;
      else high = mid;
    }
    return low + 1;
  };
  const make = (start: number, end: number): FileWindow => ({
    kind: "file",
    path: target.path,
    text: target.text.slice(start, end),
    chunk: {
      index: maxGroups,
      total: maxGroups,
      startLine: lineAt(start),
      endLine: lineAt(Math.max(start, end - 1)),
      startOffset: start,
      endOffset: end,
    },
  });
  const fits = (start: number, end: number) => {
    check();
    return estimate(make(start, end)) <= maxTokens;
  };
  const result: FileWindow[] = [];
  let start = 0;
  while (start < target.text.length) {
    if (result.length >= maxGroups) throw new Failure("output_limit");
    let candidateEnd =
      options.maxSourceCodeUnitsPerToken === undefined
        ? target.text.length
        : Math.min(
            target.text.length,
            start + Math.floor(maxTokens * options.maxSourceCodeUnitsPerToken),
          );
    if (
      candidateEnd < target.text.length &&
      /[\uD800-\uDBFF]/.test(target.text[candidateEnd - 1] ?? "")
    )
      candidateEnd--;
    const length = prefix(target.text.slice(start, candidateEnd), (text) =>
      fits(start, start + text.length),
    );
    let end = start + length;
    if (target.text[end - 1] === "\r" && target.text[end] === "\n") end--;
    if (
      end <= start ||
      (result.length && end <= result.at(-1)!.chunk.endOffset)
    )
      throw new Failure("output_limit");
    result.push(make(start, end));
    if (end === target.text.length) break;
    // Retain a scalar-aligned suffix, capped at one quarter of usable capacity.
    const available = Math.max(0, maxTokens - estimate(make(end, end)));
    const overlapBudget = Math.min(overlapTokens, Math.floor(available / 4));
    let overlapStart =
      options.maxSourceCodeUnitsPerToken === undefined
        ? start
        : Math.max(
            start,
            end -
              Math.floor(overlapBudget * options.maxSourceCodeUnitsPerToken),
          );
    if (
      overlapStart < end &&
      /[\uDC00-\uDFFF]/.test(target.text[overlapStart] ?? "")
    )
      overlapStart++;
    const reversed = Array.from(target.text.slice(overlapStart, end))
      .reverse()
      .join("");
    const retained = prefix(
      reversed,
      (text) =>
        estimateText(Array.from(text).reverse().join("")) <= overlapBudget,
      false,
    );
    start = end - retained;
    if (target.text[start - 1] === "\r" && target.text[start] === "\n") start++;
  }
  if (!result.length) throw new Failure("invalid_request");
  for (const [index, window] of result.entries()) {
    check();
    window.chunk.index = index + 1;
    window.chunk.total = result.length;
    // Conservative metadata estimates must also hold for the final exact prompt.
    if (estimate(window) > maxTokens) throw new Failure("output_limit");
  }
  return result;
}
