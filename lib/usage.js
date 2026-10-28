// Keeps the AI bill predictable: estimates what each check costs, and pauses AI verdicts for the rest of the
// day (UTC) once a token budget is used up. The count lives in this process's memory, so on serverless
// hosting each warm instance counts separately; treat the budget as a safety net, not an exact meter.

// USD per million tokens: [input, output]. Prompts over 100K tokens cost more; ours are a few thousand.
const PRICES = { 'claude-haiku-5-5': [0.10, 0.50] };

/** @returns {number|null} estimated dollars, or null for a model whose price is not known here */
export function estimateCost(model, { inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0 }) {
  const price = PRICES[model];
  if (!price) return null;
  const [inRate, outRate] = price;
  return (inputTokens * inRate + cacheReadTokens * inRate * 0.1 + cacheWriteTokens * inRate * 1.25 + outputTokens * outRate) / 1e6;
}

export function dailyBudget() {
  const raw = process.env.INFOMEDICS_DAILY_TOKEN_BUDGET;
  if (raw === undefined || raw === '') return 2_000_000; // about 1,000 to 2,000 checks on Haiku 5.5
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 2_000_000; // 0 turns the budget off
}

const today = () => new Date().toISOString().slice(0, 10);
const state = { day: today(), tokens: 0 };

function roll() {
  const d = today();
  if (state.day !== d) { state.day = d; state.tokens = 0; }
}

export function recordTokens(n) {
  roll();
  state.tokens += Math.max(0, Number(n) || 0);
}

export function budgetExhausted() {
  roll();
  const limit = dailyBudget();
  return limit > 0 && state.tokens >= limit;
}

export function budgetStatus() {
  roll();
  return { limit: dailyBudget(), used: state.tokens, exhausted: budgetExhausted() };
}

/** For tests. */
export function resetBudget() { state.day = today(); state.tokens = 0; }
