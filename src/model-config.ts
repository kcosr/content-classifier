import { Failure, integer, keys, object } from "./contract";
export interface ModelScreening {
  context_window_tokens: number;
  max_input_tokens: number;
  overlap_tokens: number;
  prompt_reserve_tokens: number;
  estimation_margin_percent: number;
  max_groups: number;
}
export function inputBudget(
  settings: ModelScreening,
  maxTokens: number,
): number {
  return Math.min(
    settings.max_input_tokens,
    settings.context_window_tokens - maxTokens - settings.prompt_reserve_tokens,
  );
}
export function modelScreening(
  value: unknown,
  maxTokens: number,
): ModelScreening {
  const x = object(value);
  keys(x, [
    "context_window_tokens",
    "max_input_tokens",
    "overlap_tokens",
    "prompt_reserve_tokens",
    "estimation_margin_percent",
    "max_groups",
  ]);
  integer(x.context_window_tokens, 4_194_304);
  integer(x.max_input_tokens, 4_194_304);
  integer(x.max_groups, 16_384);
  for (const [key, max] of [
    ["overlap_tokens", 1_048_576],
    ["prompt_reserve_tokens", 4_194_304],
    ["estimation_margin_percent", 1000],
  ] as const) {
    if (
      !Number.isSafeInteger(x[key]) ||
      Number(x[key]) < 0 ||
      Number(x[key]) > max
    )
      throw new Failure("configuration_error");
  }
  const settings = x as unknown as ModelScreening;
  const budget = inputBudget(settings, maxTokens);
  if (budget < 128 || settings.overlap_tokens > Math.floor(budget / 4))
    throw new Failure("configuration_error");
  return settings;
}
