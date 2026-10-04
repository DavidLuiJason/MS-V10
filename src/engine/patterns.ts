export interface PatternCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type PatternDirection = 'bullish' | 'bearish';

export interface PatternDefinition {
  id: string;
  name: string;
  direction: PatternDirection;
  description: string;
}

export interface PatternEvent {
  patternId: string;
  index: number;
  t: number;
  price: number;
}

export interface PatternStat {
  patternId: string;
  horizon: number;
  samples: number;
  wins: number;
  winRate: number;
  avgGainPct: number;
  avgLossPct: number;
  baselineWinRate: number;
  edgePoints: number;
  ciLow: number;
  ciHigh: number;
  verdict: 'beats' | 'fails' | 'unclear';
}

export interface PatternStudy {
  candleCount: number;
  from: number;
  to: number;
  stats: PatternStat[];
  events: PatternEvent[];
}

export const PATTERN_HORIZONS = [1, 3, 5, 10];
export const MIN_PATTERN_SAMPLES = 30;
const WARMUP = 22;

export const PATTERN_DEFINITIONS: PatternDefinition[] = [
  {
    id: 'bullish_engulfing',
    name: 'Bullish Engulfing',
    direction: 'bullish',
    description: 'A red candle is followed by a green candle whose body fully covers the red body.',
  },
  {
    id: 'bearish_engulfing',
    name: 'Bearish Engulfing',
    direction: 'bearish',
    description: 'A green candle is followed by a red candle whose body fully covers the green body.',
  },
  {
    id: 'hammer',
    name: 'Hammer',
    direction: 'bullish',
    description: 'After a 3-candle fall, a candle with a long lower wick and its body near the top.',
  },
  {
    id: 'shooting_star',
    name: 'Shooting Star',
    direction: 'bearish',
    description: 'After a 3-candle rise, a candle with a long upper wick and its body near the bottom.',
  },
  {
    id: 'rsi_oversold_cross',
    name: 'RSI leaves oversold',
    direction: 'bullish',
    description: 'RSI (14) crosses back above 30 after being below it.',
  },
  {
    id: 'rsi_overbought_cross',
    name: 'RSI leaves overbought',
    direction: 'bearish',
    description: 'RSI (14) crosses back below 70 after being above it.',
  },
  {
    id: 'ema_cross_up',
    name: 'EMA 9 crosses above EMA 21',
    direction: 'bullish',
    description: 'The fast average (9) moves from below to above the slow average (21).',
  },
  {
    id: 'ema_cross_down',
    name: 'EMA 9 crosses below EMA 21',
    direction: 'bearish',
    description: 'The fast average (9) moves from above to below the slow average (21).',
  },
  {
    id: 'breakout_up',
    name: 'Breakout above 20-candle high',
    direction: 'bullish',
    description: 'A candle closes above the highest high of the previous 20 candles (first close only).',
  },
  {
    id: 'breakout_down',
    name: 'Breakdown below 20-candle low',
    direction: 'bearish',
    description: 'A candle closes below the lowest low of the previous 20 candles (first close only).',
  },
];

function calcEma(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function calcRsi(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function detectPatterns(candles: PatternCandle[]): PatternEvent[] {
  const n = candles.length;
  const events: PatternEvent[] = [];
  if (n <= WARMUP + 1) return events;

  const closes = candles.map((c) => c.c);
  const rsi = calcRsi(closes, 14);
  const ema9 = calcEma(closes, 9);
  const ema21 = calcEma(closes, 21);

  const highestPrior = (i: number): number => {
    let m = -Infinity;
    for (let j = i - 20; j < i; j++) if (candles[j].h > m) m = candles[j].h;
    return m;
  };
  const lowestPrior = (i: number): number => {
    let m = Infinity;
    for (let j = i - 20; j < i; j++) if (candles[j].l < m) m = candles[j].l;
    return m;
  };

  const push = (patternId: string, i: number) => {
    events.push({ patternId, index: i, t: candles[i].t, price: candles[i].c });
  };

  for (let i = WARMUP; i < n; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const range = cur.h - cur.l;

    // Engulfing
    if (prev.c < prev.o && cur.c > cur.o && cur.o <= prev.c && cur.c >= prev.o) push('bullish_engulfing', i);
    if (prev.c > prev.o && cur.c < cur.o && cur.o >= prev.c && cur.c <= prev.o) push('bearish_engulfing', i);

    // Hammer / Shooting star
    if (range > 0) {
      const lower = Math.min(cur.o, cur.c) - cur.l;
      const upper = cur.h - Math.max(cur.o, cur.c);
      if (lower >= 0.6 * range && upper <= 0.15 * range && closes[i - 1] < closes[i - 4]) push('hammer', i);
      if (upper >= 0.6 * range && lower <= 0.15 * range && closes[i - 1] > closes[i - 4]) push('shooting_star', i);
    }

    // RSI crosses
    if (!isNaN(rsi[i]) && !isNaN(rsi[i - 1])) {
      if (rsi[i - 1] < 30 && rsi[i] >= 30) push('rsi_oversold_cross', i);
      if (rsi[i - 1] > 70 && rsi[i] <= 70) push('rsi_overbought_cross', i);
    }

    // EMA crosses
    if (!isNaN(ema9[i]) && !isNaN(ema21[i]) && !isNaN(ema9[i - 1]) && !isNaN(ema21[i - 1])) {
      if (ema9[i - 1] <= ema21[i - 1] && ema9[i] > ema21[i]) push('ema_cross_up', i);
      if (ema9[i - 1] >= ema21[i - 1] && ema9[i] < ema21[i]) push('ema_cross_down', i);
    }

    // Breakouts (first close beyond the prior 20-candle range)
    if (i >= 21) {
      if (cur.c > highestPrior(i) && prev.c <= highestPrior(i - 1)) push('breakout_up', i);
      if (cur.c < lowestPrior(i) && prev.c >= lowestPrior(i - 1)) push('breakout_down', i);
    }
  }
  return events;
}

// Move in the direction the pattern predicts, in percent, after `horizon` candles. null if not enough later candles.
export function getEventOutcome(
  candles: PatternCandle[],
  event: PatternEvent,
  horizon: number,
  direction: PatternDirection
): number | null {
  const exitIndex = event.index + horizon;
  if (exitIndex >= candles.length) return null;
  const entry = candles[event.index].c;
  if (!(entry > 0)) return null;
  const movePct = ((candles[exitIndex].c - entry) / entry) * 100;
  return direction === 'bullish' ? movePct : -movePct;
}

function wilson(wins: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 0 };
  const z = 2.576;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

export function studyPatterns(candles: PatternCandle[], horizons: number[] = PATTERN_HORIZONS): PatternStudy {
  const n = candles.length;
  const events = detectPatterns(candles);
  const stats: PatternStat[] = [];

  // Baseline: how often price was simply higher / lower after H candles, over the same stretch of candles.
  const baselineUp: Record<number, number> = {};
  const baselineDown: Record<number, number> = {};
  for (const h of horizons) {
    let up = 0;
    let down = 0;
    let total = 0;
    for (let j = WARMUP; j + h < n; j++) {
      total++;
      if (candles[j + h].c > candles[j].c) up++;
      else if (candles[j + h].c < candles[j].c) down++;
    }
    baselineUp[h] = total > 0 ? up / total : 0;
    baselineDown[h] = total > 0 ? down / total : 0;
  }

  for (const def of PATTERN_DEFINITIONS) {
    const own = events.filter((e) => e.patternId === def.id);
    for (const h of horizons) {
      let samples = 0;
      let wins = 0;
      let gainSum = 0;
      let lossSum = 0;
      for (const e of own) {
        const out = getEventOutcome(candles, e, h, def.direction);
        if (out === null) continue;
        samples++;
        if (out > 0) {
          wins++;
          gainSum += out;
        } else {
          lossSum += out;
        }
      }
      const winRate = samples > 0 ? wins / samples : 0;
      const baseline = def.direction === 'bullish' ? baselineUp[h] : baselineDown[h];
      const ci = wilson(wins, samples);
      let verdict: 'beats' | 'fails' | 'unclear' = 'unclear';
      if (samples >= MIN_PATTERN_SAMPLES) {
        if (ci.low > baseline) verdict = 'beats';
        else if (ci.high < baseline) verdict = 'fails';
      }
      stats.push({
        patternId: def.id,
        horizon: h,
        samples,
        wins,
        winRate,
        avgGainPct: wins > 0 ? gainSum / wins : 0,
        avgLossPct: samples - wins > 0 ? lossSum / (samples - wins) : 0,
        baselineWinRate: baseline,
        edgePoints: (winRate - baseline) * 100,
        ciLow: ci.low,
        ciHigh: ci.high,
        verdict,
      });
    }
  }

  return {
    candleCount: n,
    from: n > 0 ? candles[0].t : 0,
    to: n > 0 ? candles[n - 1].t : 0,
    stats,
    events,
  };
}
