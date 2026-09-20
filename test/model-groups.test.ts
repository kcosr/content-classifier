import { expect, test } from "bun:test";
import { estimatedTokens } from "../src/token-estimate";
import { modelGroups } from "../src/model-groups";
import { type ConversationTarget as Target } from "../src/contract";
const estimator = {
  estimate: (target: Target) => estimatedTokens(JSON.stringify(target)),
  estimateText: estimatedTokens,
};
const make = (text: string, target = true): Target => ({
  kind: "conversation",
  units: [
    {
      target,
      role: "user",
      kind: "message",
      parts: [{ kind: "text", segments: [{ kind: "source", text }] }],
    },
  ],
});
const texts = (target: Target) =>
  target.units.flatMap((u) =>
    u.parts.flatMap((p) =>
      p.segments.flatMap((s) => (s.kind === "source" ? [s.text] : [])),
    ),
  );

test("fitting target retains exact structure and reference", () => {
  const target = make("small");
  expect(
    modelGroups(target, { ...estimator, maxTokens: 1024, overlapTokens: 100 }),
  ).toEqual([target]);
  expect(
    modelGroups(target, {
      ...estimator,
      maxTokens: 1024,
      overlapTokens: 100,
    })[0],
  ).toBe(target);
});

test("Unicode and escaped input is fully covered in bounded overlapping groups", () => {
  const original = Array.from({ length: 2000 }, (_, i) => `X${i}😀\n\"\\`).join(
    "",
  );
  const groups = modelGroups(make(original), {
    ...estimator,
    maxTokens: 2048,
    overlapTokens: 400,
  });
  expect(groups.length).toBeGreaterThan(1);
  for (const group of groups) {
    expect(estimator.estimate(group)).toBeLessThanOrEqual(2048);
    for (const piece of texts(group)) {
      expect(piece.isWellFormed()).toBe(true);
      expect(original.includes(piece)).toBe(true);
    }
  }
  for (let i = 0; i < 2000; i++)
    expect(
      groups.some((g) => texts(g).some((t) => t.includes(`X${i}😀\n\"\\`))),
    ).toBe(true);
});

test("cross-unit overlap retains context flags, labels and source boundaries", () => {
  const target: Target = {
    kind: "conversation",
    units: [
      ...make("context ".repeat(100), false).units,
      ...make("target ".repeat(100)).units,
    ],
  };
  const groups = modelGroups(target, {
    ...estimator,
    maxTokens: 1024,
    overlapTokens: 250,
  });
  expect(
    groups.some(
      (g) => g.units.some((u) => !u.target) && g.units.some((u) => u.target),
    ),
  ).toBe(true);
  for (const g of groups)
    for (const u of g.units) {
      expect(u.role).toBe("user");
      expect(u.kind).toBe("message");
      expect(u.parts[0]!.kind).toBe("text");
      expect(
        texts({ kind: "conversation", units: [u] })[0]!.includes(
          u.target ? "context" : "target",
        ),
      ).toBe(false);
    }
});

test("planning rejects invalid budgets and excessive groups without truncating", () => {
  expect(() =>
    modelGroups(make("x".repeat(10000)), {
      ...estimator,
      maxTokens: 512,
      overlapTokens: 100,
      maxGroups: 1,
    }),
  ).toThrow();
  expect(() =>
    modelGroups(make("x"), { ...estimator, maxTokens: 100, overlapTokens: 0 }),
  ).toThrow();
});

test("masked and adjacent source segments remain independent in every window", () => {
  const target = make("before ".repeat(200));
  target.units[0]!.parts[0]!.segments.push(
    { kind: "redacted", label: "[SECRET]" },
    { kind: "source", text: "after ".repeat(200) },
  );
  const groups = modelGroups(target, {
    ...estimator,
    maxTokens: 400,
    overlapTokens: 40,
  });
  expect(
    groups.some((g) =>
      g.units.some((u) =>
        u.parts.some((p) =>
          p.segments.some(
            (s) => s.kind === "redacted" && s.label === "[SECRET]",
          ),
        ),
      ),
    ),
  ).toBe(true);
  for (const group of groups)
    for (const text of texts(group)) {
      expect(text.includes("[SECRET]")).toBe(false);
      expect(text.includes("before") && text.includes("after")).toBe(false);
    }
});

test("overlap carries exact source across window cuts and makes forward progress", () => {
  const original = Array.from(
    { length: 600 },
    (_, i) => `item${i}😀 é中\n`,
  ).join("");
  const groups = modelGroups(make(original), {
    ...estimator,
    maxTokens: 500,
    overlapTokens: 100,
  });
  let covered = 0;
  for (const group of groups) {
    const parts = texts(group);
    expect(parts).toHaveLength(1);
    const text = parts[0]!;
    const start = original.indexOf(text);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start).toBeLessThanOrEqual(covered);
    expect(start + text.length).toBeGreaterThan(covered);
    covered = start + text.length;
  }
  expect(covered).toBe(original.length);
});
