import {
  ATTACKER_MAX_TOKENS,
  CREDIT_USD,
  DEFENDER_MAX_TOKENS,
  JUDGE_MAX_TOKENS,
  JUDGE_MODEL,
  MARGIN,
  MAX_INPUT_TOKENS_JUDGE_CALL,
  MAX_INPUT_TOKENS_PLAYER_CALL,
  MAX_TURNS,
  PLAYER_MODEL,
  PRICE_USD_PER_MTOK,
  ROUNDS_PER_MATCH,
} from "./config";

export type PriceTable = Record<string, { input: number; output: number }>;

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingError";
  }
}

/** Throws if any configured price (or the price of a model in use) is missing / NaN. */
export function assertPricesConfigured(prices: PriceTable = PRICE_USD_PER_MTOK): void {
  for (const [model, p] of Object.entries(prices)) {
    if (!Number.isFinite(p.input) || !Number.isFinite(p.output)) {
      throw new PricingError(`Price for model "${model}" is not configured (NaN) in config.ts`);
    }
  }
  for (const model of [PLAYER_MODEL, JUDGE_MODEL]) {
    if (!prices[model]) throw new PricingError(`No price configured for model "${model}"`);
  }
}

/** Price is USD per 1M tokens, so micro-USD = tokens × price. */
export function callCostUsdMicro(
  model: string,
  inputTokens: number,
  outputTokens: number,
  prices: PriceTable = PRICE_USD_PER_MTOK,
): number {
  const p = prices[model];
  if (!p || !Number.isFinite(p.input) || !Number.isFinite(p.output)) {
    throw new PricingError(`No valid price for model "${model}"`);
  }
  return Math.round(inputTokens * p.input + outputTokens * p.output);
}

/** micro-USD → credits including margin, rounded up. Guards against float noise before ceil. */
export function usdMicroToCreditsWithMargin(usdMicro: number): number {
  const credits = (usdMicro / 1e6) * (1 + MARGIN) / CREDIT_USD;
  return Math.ceil(Number(credits.toFixed(9)));
}

/** Upper bound of the LLM cost of one match, in micro-USD (spec 9, before margin). */
export function computeMaxMatchUsdMicro(prices: PriceTable = PRICE_USD_PER_MTOK): number {
  const perTurnMicro =
    2 *
      callCostUsdMicro(
        PLAYER_MODEL,
        MAX_INPUT_TOKENS_PLAYER_CALL,
        Math.max(ATTACKER_MAX_TOKENS, DEFENDER_MAX_TOKENS),
        prices,
      ) +
    callCostUsdMicro(JUDGE_MODEL, MAX_INPUT_TOKENS_JUDGE_CALL, JUDGE_MAX_TOKENS, prices);
  return ROUNDS_PER_MATCH * 2 /* channels */ * MAX_TURNS * perTurnMicro;
}

/** Spec 9: maximum possible match cost (with margin) in credits. */
export function computeHoldCredits(prices: PriceTable = PRICE_USD_PER_MTOK): number {
  return usdMicroToCreditsWithMargin(computeMaxMatchUsdMicro(prices));
}

/** Spec 8.3: actual charge for a finished match. */
export function computeChargeCredits(actualUsdMicro: number): number {
  return usdMicroToCreditsWithMargin(actualUsdMicro);
}
