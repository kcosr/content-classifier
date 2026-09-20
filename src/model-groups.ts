import {
  Failure,
  type Segment,
  type ConversationTarget as Target,
  type Unit,
} from "./contract";
export interface ModelGroupOptions {
  maxTokens: number;
  overlapTokens: number;
  maxGroups?: number;
  estimate: (target: Target) => number;
  estimateText: (text: string) => number;
  shouldStop?: () => boolean;
}
function fragment(unit: Unit, kind: string, segment: Segment): Unit {
  return {
    target: unit.target,
    role: unit.role,
    kind: unit.kind,
    parts: [{ kind, segments: [segment] }],
  };
}
/** Largest scalar-aligned prefix; a nearby textual boundary keeps windows readable. */
export function prefix(
  text: string,
  fits: (text: string) => boolean,
  preferBoundary = true,
): number {
  let low = 0,
    high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(text.slice(0, middle))) low = middle;
    else high = middle - 1;
  }
  if (low && low < text.length && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low--;
  if (preferBoundary && low < text.length) {
    const floor = Math.floor(low * 0.8);
    for (let i = low; i > floor; i--) if (/\s/.test(text[i - 1]!)) return i;
  }
  return low;
}
/** Complete preflight. Every accepted window includes full prompt estimation. */
export function modelGroups(
  target: Target,
  options: ModelGroupOptions,
): Target[] {
  const { maxTokens, overlapTokens, estimate, estimateText } = options;
  const maxGroups = options.maxGroups ?? 1024;
  if (
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 128 ||
    !Number.isSafeInteger(overlapTokens) ||
    overlapTokens < 0 ||
    overlapTokens > maxTokens / 4 ||
    !Number.isSafeInteger(maxGroups) ||
    maxGroups < 1 ||
    maxGroups > 16384
  )
    throw new Failure("invalid_request");
  const stop = () => {
    if (options.shouldStop?.()) throw new Failure("cancelled");
  };
  const fits = (units: Unit[]) => {
    stop();
    return estimate({ kind: "conversation", units }) <= maxTokens;
  };
  if (fits(target.units)) return [target];
  if (!fits([])) throw new Failure("output_limit");
  const groups: Target[] = [];
  let current: Unit[] = [];
  let hasNew = false;
  const flush = () => {
    if (!hasNew || groups.length >= maxGroups)
      throw new Failure("output_limit");
    groups.push({ kind: "conversation", units: current });
    const retained: Unit[] = [];
    let remaining = Math.min(
      overlapTokens,
      Math.floor(
        (maxTokens - estimate({ kind: "conversation", units: [] })) / 4,
      ),
    );
    for (let i = current.length - 1; i >= 0 && remaining > 0; i--) {
      const unit = current[i]!,
        part = unit.parts[0]!,
        segment = part.segments[0]!;
      if (segment.kind !== "source") break;
      const reversed = Array.from(segment.text).reverse().join("");
      const length = prefix(
        reversed,
        (text) =>
          estimateText(Array.from(text).reverse().join("")) <= remaining,
        false,
      );
      if (!length) break;
      const text = Array.from(reversed.slice(0, length)).reverse().join("");
      const item = fragment(unit, part.kind, { kind: "source", text });
      // Reserve half of the usable prompt capacity for novel content.
      if (
        estimate({ kind: "conversation", units: [item, ...retained] }) >
        estimate({ kind: "conversation", units: [] }) +
          (maxTokens - estimate({ kind: "conversation", units: [] })) / 2
      )
        break;
      retained.unshift(item);
      remaining -= estimateText(text);
      if (length !== reversed.length) break;
    }
    current = retained;
    hasNew = false;
  };
  for (const unit of target.units)
    for (const part of unit.parts)
      for (const segment of part.segments) {
        stop();
        if (segment.kind === "redacted") {
          const item = fragment(unit, part.kind, segment);
          if (!fits([...current, item])) flush();
          if (!fits([...current, item])) current = [];
          if (!fits([...current, item])) throw new Failure("output_limit");
          current.push(item);
          hasNew = true;
          continue;
        }
        let remaining = segment.text;
        while (remaining.length) {
          const make = (text: string) =>
            fragment(unit, part.kind, { kind: "source", text });
          let length = prefix(remaining, (text) =>
            fits([...current, make(text)]),
          );
          if (!length) {
            if (hasNew) flush();
            else current = [];
            length = prefix(remaining, (text) =>
              fits([...current, make(text)]),
            );
            if (!length) throw new Failure("output_limit");
          }
          current.push(make(remaining.slice(0, length)));
          hasNew = true;
          remaining = remaining.slice(length);
          if (remaining.length) {
            flush();
            // Rejoin only the overlapping suffix from this same source fragment.
            const retained = current.at(-1)?.parts[0]?.segments[0];
            if (retained?.kind === "source") {
              remaining = retained.text + remaining;
              current.pop();
            }
          }
        }
      }
  if (hasNew) {
    if (groups.length >= maxGroups) throw new Failure("output_limit");
    groups.push({ kind: "conversation", units: current });
  }
  return groups;
}
