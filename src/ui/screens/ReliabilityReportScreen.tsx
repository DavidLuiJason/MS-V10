import React from 'react';
import { ShieldCheck, TrendingUp, TrendingDown, HelpCircle } from 'lucide-react';

export const ReliabilityReportScreen: React.FC = () => {
  return (
    <div className="p-4 space-y-4 pb-20">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight mb-1">Reliability Report</h2>
        <p className="text-xs text-slate-400">Statistical edge and model verification against baseline</p>
      </div>

      {/* Top Stat Cards & Circular Progress */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-slate-400 font-medium mb-1">Win Rate</div>
            <div className="text-3xl font-extrabold text-white font-mono">—</div>
            <div className="text-[11px] text-slate-500 mt-0.5">Sample size: 0</div>
          </div>

          {/* Circular Gauge */}
          <div className="relative w-16 h-16 flex items-center justify-center">
            <svg className="w-16 h-16 transform -rotate-90" viewBox="0 0 36 36">
              <path
                className="text-slate-800"
                strokeWidth="3.5"
                stroke="currentColor"
                fill="none"
                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
              />
              <path
                className="text-cyan-500"
                strokeDasharray="0, 100"
                strokeWidth="3.5"
                strokeLinecap="round"
                stroke="currentColor"
                fill="none"
                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
              />
            </svg>
            <span className="absolute text-xs font-mono font-bold text-slate-400">0%</span>
          </div>
        </div>

        {/* Exception (b): Screen 7: Average Gain shows only the average gain value, and a second stat "Average Loss" sits beside it */}
        <div className="grid grid-cols-2 gap-3 pt-3 border-t border-slate-800">
          <div className="bg-slate-950/50 p-3 rounded-2xl border border-slate-800/60">
            <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mb-1">
              <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
              Average Gain
            </div>
            <div className="text-base font-bold text-emerald-400 font-mono">—</div>
          </div>

          <div className="bg-slate-950/50 p-3 rounded-2xl border border-slate-800/60">
            <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mb-1">
              <TrendingDown className="w-3.5 h-3.5 text-rose-400" />
              Average Loss
            </div>
            <div className="text-base font-bold text-rose-400 font-mono">—</div>
          </div>
        </div>

        <div className="flex items-center justify-between text-xs pt-1 px-1">
          <span className="text-slate-400">Confidence Range</span>
          <span className="text-slate-300 font-mono font-medium">—</span>
        </div>
      </div>

      {/* Results vs Random Baseline Chart area */}
      <div className="space-y-2">
        <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider px-1">
          Results vs Random Baseline
        </div>

        <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-8 text-center flex flex-col items-center justify-center">
          <div className="w-12 h-12 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 mb-2.5">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <h4 className="text-sm font-semibold text-slate-300 mb-0.5">No trades yet</h4>
          <p className="text-xs text-slate-500">Available in the next build</p>
        </div>
      </div>

      {/* Info Callout */}
      <div className="bg-slate-900/40 border border-slate-800/60 rounded-2xl p-3.5 flex items-start gap-3 text-xs text-slate-400">
        <HelpCircle className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
        <div>
          Baseline comparisons calculate whether pattern win rates outperform a binomial random entry distribution at 95% confidence intervals.
        </div>
      </div>
    </div>
  );
};
