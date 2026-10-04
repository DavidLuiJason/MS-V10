import React, { useEffect, useMemo, useState } from 'react';
import Dexie from 'dexie';
import { Shapes, ChevronDown, ChevronUp } from 'lucide-react';
import { useAppStore } from '../../state/store';
import { db } from '../../data/db';
import {
  PATTERN_DEFINITIONS,
  PATTERN_HORIZONS,
  MIN_PATTERN_SAMPLES,
  studyPatterns,
  getEventOutcome,
  type PatternCandle,
} from '../../engine/patterns';

interface Props {
  onSelectPattern?: (patternId: string) => void;
}

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];
const MAX_STUDY_CANDLES = 50000;
const MIN_CANDLES_TO_STUDY = 200;

const pct = (x: number) => (x * 100).toFixed(1) + '%';
const signed = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2) + '%';

export const PatternsScreen: React.FC<Props> = () => {
  const { patternFilter, setPatternFilter, settings, gapsVersion } = useAppStore();

  const [symbolChoice, setSymbolChoice] = useState('BTCUSDT');
  const [timeframe, setTimeframe] = useState('1h');
  const [horizon, setHorizon] = useState(5);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [candles, setCandles] = useState<PatternCandle[]>([]);
  const [loading, setLoading] = useState(true);

  const symbol: string = settings.trackedSymbols.includes(symbolChoice)
    ? symbolChoice
    : settings.trackedSymbols[0] || '';

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!symbol) {
        setCandles([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const rows = await db.candles
          .where('[src+sym+tf+t]')
          .between(['binance', symbol, timeframe, Dexie.minKey], ['binance', symbol, timeframe, Dexie.maxKey])
          .reverse()
          .limit(MAX_STUDY_CANDLES)
          .toArray();
        if (cancelled) return;
        const list: PatternCandle[] = rows
          .reverse()
          .filter((r) => r.closed)
          .map((r) => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }));
        setCandles(list);
      } catch {
        if (!cancelled) setCandles([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [symbol, timeframe, gapsVersion]);

  const study = useMemo(() => studyPatterns(candles), [candles]);
  const enoughData = candles.length >= MIN_CANDLES_TO_STUDY;

  const filterTabs: Array<{ id: 'all' | 'wins' | 'losses' | 'pending'; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'wins', label: 'Wins' },
    { id: 'losses', label: 'Losses' },
    { id: 'pending', label: 'Pending' },
  ];

  const rows = PATTERN_DEFINITIONS.map((def) => ({
    def,
    stat: study.stats.find((s) => s.patternId === def.id && s.horizon === horizon),
  }))
    .filter((r) => r.stat !== undefined)
    .filter((r) => {
      const verdict = r.stat!.verdict;
      if (patternFilter === 'wins') return verdict === 'beats';
      if (patternFilter === 'losses') return verdict === 'fails';
      if (patternFilter === 'pending') return verdict === 'unclear';
      return true;
    })
    .sort((a, b) => {
      const aEnough = a.stat!.samples >= MIN_PATTERN_SAMPLES ? 0 : 1;
      const bEnough = b.stat!.samples >= MIN_PATTERN_SAMPLES ? 0 : 1;
      if (aEnough !== bEnough) return aEnough - bEnough;
      return b.stat!.edgePoints - a.stat!.edgePoints;
    });

  const chip = (active: boolean) =>
    `px-3 py-1.5 rounded-xl border text-xs font-bold transition ${
      active
        ? 'bg-cyan-500/10 border-cyan-500/50 text-white'
        : 'bg-slate-800/60 border-slate-800 text-slate-400'
    }`;

  return (
    <div className="p-4 space-y-4 pb-20">
      <div>
        {/* Exception (a): Screen 4's title must read "Patterns" */}
        <h2 className="text-xl font-bold text-white tracking-tight mb-1">Patterns</h2>
        <p className="text-xs text-slate-400">Automated technical pattern detection and evaluation</p>
      </div>

      {/* Study settings */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-3xl p-4 space-y-3">
        <div>
          <div className="text-[11px] text-slate-400 mb-1.5">Coin</div>
          <div className="flex flex-wrap gap-2">
            {settings.trackedSymbols.map((sym: string) => (
              <button key={sym} onClick={() => setSymbolChoice(sym)} className={chip(sym === symbol)}>
                {sym}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-slate-400 mb-1.5">Timeframe</div>
          <div className="flex flex-wrap gap-2">
            {TIMEFRAMES.map((tf) => (
              <button key={tf} onClick={() => setTimeframe(tf)} className={chip(tf === timeframe)}>
                {tf}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-slate-400 mb-1.5">Look ahead (candles after the signal)</div>
          <div className="flex flex-wrap gap-2">
            {PATTERN_HORIZONS.map((h) => (
              <button key={h} onClick={() => setHorizon(h)} className={chip(h === horizon)}>
                {h}
              </button>
            ))}
          </div>
        </div>
        <div className="text-[11px] font-mono text-slate-400">
          {loading
            ? 'Loading saved candles...'
            : `Based on ${candles.length.toLocaleString()} saved candles` +
              (candles.length > 0
                ? ` (${new Date(study.from).toLocaleDateString()} to ${new Date(study.to).toLocaleDateString()})`
                : '')}
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-1.5 p-1 bg-slate-900 border border-slate-800 rounded-xl">
        {filterTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setPatternFilter(tab.id)}
            className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition ${
              patternFilter === tab.id
                ? 'bg-cyan-500 text-slate-950 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="text-[10px] text-slate-500 -mt-2 px-1">
        Wins = clearly beat random · Losses = clearly worse than random · Pending = not enough proof yet
      </div>

      {!loading && !enoughData ? (
        <div className="bg-slate-900/60 border border-slate-800/80 rounded-3xl p-8 text-center flex flex-col items-center justify-center my-6">
          <div className="w-14 h-14 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 mb-3">
            <Shapes className="w-7 h-7" />
          </div>
          <h3 className="text-base font-semibold text-slate-200 mb-1">Not enough saved candles</h3>
          <p className="text-xs text-slate-400 max-w-xs">
            You have {candles.length.toLocaleString()} closed {timeframe} candles for {symbol || 'this coin'}. At least{' '}
            {MIN_CANDLES_TO_STUDY} are needed. Go to More, then Data &amp; Storage, then Download Past Charts.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.length === 0 && !loading && (
            <div className="text-xs text-slate-500 text-center py-6">No patterns in this group.</div>
          )}
          {rows.map(({ def, stat }) => {
            const s = stat!;
            const open = expandedId === def.id;
            const edgeColor =
              s.verdict === 'beats' ? 'text-emerald-400' : s.verdict === 'fails' ? 'text-rose-400' : 'text-slate-400';
            const recent = study.events.filter((e) => e.patternId === def.id).slice(-5).reverse();
            return (
              <div key={def.id} className="bg-slate-900/80 border border-slate-800 rounded-2xl overflow-hidden">
                <button
                  onClick={() => setExpandedId(open ? null : def.id)}
                  className="w-full p-3.5 flex items-center justify-between gap-3 text-left"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-white truncate">{def.name}</div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                          def.direction === 'bullish'
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                            : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                        }`}
                      >
                        {def.direction === 'bullish' ? 'Up signal' : 'Down signal'}
                      </span>
                      <span className="text-[11px] text-slate-500 font-mono">{s.samples.toLocaleString()} samples</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right">
                      <div className="text-sm font-bold font-mono text-white">{s.samples > 0 ? pct(s.winRate) : '—'}</div>
                      <div className={`text-[11px] font-mono ${edgeColor}`}>
                        {s.samples > 0 ? (s.edgePoints >= 0 ? '+' : '') + s.edgePoints.toFixed(1) + ' pts vs random' : '—'}
                      </div>
                    </div>
                    {open ? (
                      <ChevronUp className="w-4 h-4 text-slate-400" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-slate-400" />
                    )}
                  </div>
                </button>

                {open && (
                  <div className="px-3.5 pb-3.5 space-y-3 border-t border-slate-800/80 pt-3">
                    <p className="text-xs text-slate-400">{def.description}</p>

                    <div className="text-[11px] text-slate-400">
                      Random baseline at {horizon} candles: {pct(s.baselineWinRate)}. Win rate range (99% confidence):{' '}
                      {s.samples > 0 ? pct(s.ciLow) + ' to ' + pct(s.ciHigh) : '—'}.
                    </div>

                    <div className="text-xs">
                      <div className="grid grid-cols-5 gap-1 text-[10px] text-slate-500 pb-1">
                        <div>Ahead</div>
                        <div className="text-right">Samples</div>
                        <div className="text-right">Win rate</div>
                        <div className="text-right">Avg win</div>
                        <div className="text-right">Avg loss</div>
                      </div>
                      {study.stats
                        .filter((x) => x.patternId === def.id)
                        .map((x) => (
                          <div key={x.horizon} className="grid grid-cols-5 gap-1 py-1 font-mono text-slate-300">
                            <div>{x.horizon}</div>
                            <div className="text-right">{x.samples.toLocaleString()}</div>
                            <div className="text-right">{x.samples > 0 ? pct(x.winRate) : '—'}</div>
                            <div className="text-right text-emerald-400">{x.wins > 0 ? signed(x.avgGainPct) : '—'}</div>
                            <div className="text-right text-rose-400">
                              {x.samples - x.wins > 0 ? signed(x.avgLossPct) : '—'}
                            </div>
                          </div>
                        ))}
                    </div>

                    <div>
                      <div className="text-[11px] text-slate-400 mb-1">Latest times this pattern appeared</div>
                      {recent.length === 0 ? (
                        <div className="text-xs text-slate-500">None found in the saved candles.</div>
                      ) : (
                        recent.map((e) => {
                          const out = getEventOutcome(candles, e, horizon, def.direction);
                          return (
                            <div key={e.index} className="flex items-center justify-between py-1 text-xs font-mono">
                              <span className="text-slate-400">{new Date(e.t).toLocaleString()}</span>
                              <span className="text-slate-300">
                                {e.price.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                              </span>
                              <span
                                className={
                                  out === null ? 'text-slate-500' : out > 0 ? 'text-emerald-400' : 'text-rose-400'
                                }
                              >
                                {out === null ? 'waiting' : signed(out)}
                              </span>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="bg-slate-900/40 border border-slate-800/60 rounded-2xl p-3.5 text-[11px] text-slate-400 space-y-1.5">
        <div>
          How to read this: each pattern is looked for in your saved closed candles. The trade is entered at the close of
          the signal candle and checked after the chosen number of candles. Fees are not included.
        </div>
        <div>
          "vs random" compares the win rate with how often price simply moved that way after the same number of candles. A
          pattern only counts as a win when its whole 99% range is above random and it has at least {MIN_PATTERN_SAMPLES}{' '}
          samples.
        </div>
        <div>
          With many patterns and settings tested, a few can look good by pure luck. Check the same pattern on other coins
          and timeframes before trusting it.
        </div>
      </div>
    </div>
  );
};
