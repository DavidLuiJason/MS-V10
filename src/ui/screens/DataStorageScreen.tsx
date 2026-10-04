import React, { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../../state/store';
import { getDatabaseStats, getGapsList } from '../../data/repositories';
import { formatBytes } from '../../lib/formatters';
import { exportDataZip, exportCandlesCsv, importDataZip, type ExportScope, type ImportSummary } from '../../lib/exportImport';
import { saveAndShareFile, exportCandlesCsvInChunks } from '../../lib/saveAndShare';
import { workerClient } from '../../collector/workerClient';
import type { CollectorLogRecord } from '../../data/db';
import {
  Database,
  CheckCircle2,
  AlertCircle,
  Download,
  Upload,
  RefreshCw,
  HardDrive,
  CloudOff,
  X,
  FileCheck,
} from 'lucide-react';

const HISTORY_STEP_MS: Record<string, number> = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};
const HISTORY_TFS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const HISTORY_RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
];
const HISTORY_MAX_PER_SERIES = 600000;

export const DataStorageScreen: React.FC = () => {
  const { collectorState, isPaused, gapsVersion, settings, historyProgress } = useAppStore();

  const [stats, setStats] = useState({
    ticksCount: 0,
    quoteBarsCount: 0,
    candlesCount: 0,
    gapsCount: 0,
    storageUsed: 0,
    storageQuota: 0,
  });

  const [gaps, setGaps] = useState<CollectorLogRecord[]>([]);
  const [isRepairing, setIsRepairing] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportScope, setExportScope] = useState<ExportScope>('all');
  const [isExporting, setIsExporting] = useState(false);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const [historyDays, setHistoryDays] = useState(30);
  const [historyTfs, setHistoryTfs] = useState<string[]>(['1m', '5m', '15m', '1h', '4h', '1d']);

  const [historyCustomOpen, setHistoryCustomOpen] = useState(false);
  const [historyYearsText, setHistoryYearsText] = useState('2');

  const applyHistoryYears = (text: string) => {
    const years = parseFloat(text);
    if (Number.isFinite(years) && years > 0) {
      setHistoryDays(Math.max(1, Math.min(7300, Math.round(years * 365))));
    }
  };

  const [historyExcluded, setHistoryExcluded] = useState<string[]>([]);
  const historySymbols = settings.trackedSymbols.filter((s) => !historyExcluded.includes(s));

  const toggleHistorySymbol = (sym: string) => {
    setHistoryExcluded((prev) => (prev.includes(sym) ? prev.filter((x) => x !== sym) : [...prev, sym]));
  };

  const historyEstimate =
    historySymbols.length *
    historyTfs.reduce(
      (sum, tf) =>
        sum + Math.min(HISTORY_MAX_PER_SERIES, Math.ceil((historyDays * 24 * 60 * 60 * 1000) / HISTORY_STEP_MS[tf])),
      0
    );
  const historyClamped = historyTfs.filter(
    (tf) => (historyDays * 24 * 60 * 60 * 1000) / HISTORY_STEP_MS[tf] > HISTORY_MAX_PER_SERIES
  );

  const toggleHistoryTf = (tf: string) => {
    setHistoryTfs((prev) => (prev.includes(tf) ? prev.filter((x) => x !== tf) : [...prev, tf]));
  };

  const startHistoryDownload = () => {
    workerClient.downloadHistory(historySymbols, historyTfs, Date.now() - historyDays * 24 * 60 * 60 * 1000);
  };

  const loadData = async () => {
    const s = await getDatabaseStats();
    setStats(s);
    const g = await getGapsList();
    setGaps(g);
  };

  useEffect(() => {
    loadData();
  }, [gapsVersion]);

  const handleRepairAll = async () => {
    setIsRepairing(true);
    workerClient.repairAllGaps();
    setTimeout(() => {
      loadData();
      setIsRepairing(false);
    }, 2000);
  };

  const handleRepairSingle = async (gapId?: number) => {
    if (!gapId) return;
    setIsRepairing(true);
    workerClient.repairGap(gapId);
    setTimeout(() => {
      loadData();
      setIsRepairing(false);
    }, 1500);
  };

  const handleExport = async () => {
    const scopeRows =
      exportScope === 'all'
        ? stats.ticksCount + stats.quoteBarsCount + stats.candlesCount
        : exportScope === 'candles'
          ? stats.candlesCount
          : exportScope === 'liquidity'
            ? stats.ticksCount + stats.quoteBarsCount
            : 0;
    if (scopeRows > 600000) {
      alert(
        `This export has about ${scopeRows.toLocaleString()} rows, which is too many for one archive on this phone. Use "Export Candles (CSV)" for candles, or pick a smaller data type.`
      );
      return;
    }
    setIsExporting(true);
    try {
      const { blob, filename } = await exportDataZip(exportScope);
      await saveAndShareFile(blob, filename);
      setShowExportModal(false);
    } catch (err: any) {
      alert(`Export failed: ${err.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportCsv = async () => {
    setIsExporting(true);
    try {
      await exportCandlesCsvInChunks();
    } catch (err: any) {
      alert(`Export failed: ${err.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    setImportError(null);
    setImportSummary(null);

    try {
      const summary = await importDataZip(file);
      setImportSummary(summary);
      await loadData();
    } catch (err: any) {
      setImportError(err.message || 'Import failed due to corrupt or invalid archive.');
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const isHealthy = !isPaused && collectorState === 'collecting';

  return (
    <div className="p-4 space-y-4 pb-20">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight mb-1">Data & Storage</h2>
        <p className="text-xs text-slate-400">Database health, candle gap repair, import & export</p>
      </div>

      {/* 1. Collection Health */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                isHealthy
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                  : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
              }`}
            >
              <CheckCircle2 className="w-5 h-5" />
            </div>
            <div>
              <div className="text-xs text-slate-400 font-medium">Collection Health</div>
              <div className="text-sm font-bold text-white">
                {isHealthy ? 'Healthy' : isPaused ? 'Paused' : 'Connecting / Degraded'}
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-2 pt-2 border-t border-slate-800/80 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-slate-400">Market feeds</span>
            <span className="font-semibold text-emerald-400 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              Active
            </span>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-slate-400">Pattern detection</span>
            <span className="font-semibold text-slate-400 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
              Idle
            </span>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-slate-400">Data sync</span>
            <span className="font-semibold text-slate-400 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
              Local only
            </span>
          </div>
        </div>
      </div>

      {/* 2. Gaps List & Repair */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-bold text-white">Gaps</div>
            <div className="text-xs text-slate-400">
              {gaps.filter((g) => g.status === 'open').length} open gaps found
            </div>
          </div>

          <button
            onClick={handleRepairAll}
            disabled={isRepairing || gaps.filter((g) => g.status === 'open').length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cyan-500 text-slate-950 font-bold text-xs hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRepairing ? 'animate-spin' : ''}`} />
            Repair All
          </button>
        </div>

        {gaps.length === 0 ? (
          <div className="py-4 text-center text-xs text-slate-500">
            No gaps detected. Feed continuity intact.
          </div>
        ) : (
          <div className="space-y-2 pt-2 border-t border-slate-800/80 max-h-48 overflow-y-auto">
            {gaps.map((gap) => (
              <div
                key={gap.id}
                className="bg-slate-950/60 border border-slate-800/60 p-2.5 rounded-xl flex items-center justify-between text-xs"
              >
                <div>
                  <div className="font-bold text-slate-200">
                    {gap.sym} <span className="text-slate-400 font-mono text-[11px]">{gap.tf}</span>
                  </div>
                  <div className="text-[10px] text-slate-400">
                    {gap.status === 'unrecoverable'
                      ? 'Tick gaps cannot be recovered (Binance provides no history)'
                      : `${new Date(gap.from || 0).toLocaleTimeString()} - ${new Date(gap.to || 0).toLocaleTimeString()}`}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                      gap.status === 'repaired'
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        : gap.status === 'unrecoverable'
                        ? 'bg-slate-800 text-slate-400 border border-slate-700'
                        : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                    }`}
                  >
                    {gap.status}
                  </span>

                  {gap.status === 'open' && (
                    <button
                      onClick={() => handleRepairSingle(gap.id)}
                      disabled={isRepairing}
                      className="text-[11px] text-cyan-400 hover:text-cyan-300 font-semibold"
                    >
                      Repair
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 3. Storage Used */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
            <HardDrive className="w-4 h-4 text-cyan-400" />
            Storage Used
          </div>
          <div className="text-xs font-mono font-bold text-slate-200">
            {formatBytes(stats.storageUsed)}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-800/80">
          <button
            onClick={() => setShowExportModal(true)}
            className="flex items-center justify-center gap-2 py-2.5 px-3 rounded-2xl bg-cyan-500 text-slate-950 font-bold text-xs hover:bg-cyan-400 active:scale-95 transition"
          >
            <Upload className="w-4 h-4" />
            Export Data
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isImporting}
            className="flex items-center justify-center gap-2 py-2.5 px-3 rounded-2xl bg-slate-800 text-slate-200 border border-slate-700 font-bold text-xs hover:bg-slate-700 active:scale-95 transition"
          >
            <Download className="w-4 h-4" />
            {isImporting ? 'Importing...' : 'Import Data'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        <button
          onClick={handleExportCsv}
          disabled={isExporting}
          className="w-full flex items-center justify-center gap-2 py-2.5 px-3 rounded-2xl bg-slate-800 text-slate-200 border border-slate-700 font-bold text-xs hover:bg-slate-700 active:scale-95 transition"
        >
          <Upload className="w-4 h-4" />
          {isExporting ? 'Preparing file...' : 'Export Candles (CSV)'}
        </button>
      </div>

      {/* Import Result Notification */}
      {importError && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4 text-xs text-rose-300 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-bold mb-0.5">Import Error</div>
            <div>{importError}</div>
          </div>
          <button onClick={() => setImportError(null)} className="text-slate-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {importSummary && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-4 text-xs text-emerald-300 space-y-2">
          <div className="flex items-center justify-between">
            <div className="font-bold flex items-center gap-1.5">
              <FileCheck className="w-4 h-4 text-emerald-400" />
              Import Successful
            </div>
            <button onClick={() => setImportSummary(null)} className="text-slate-400 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="space-y-1 font-mono text-[11px]">
            {importSummary.tables.map((t) => (
              <div key={t.name} className="flex justify-between text-slate-300">
                <span>{t.name}:</span>
                <span>+{t.added} added, {t.skipped} skipped</span>
              </div>
            ))}
            {importSummary.skippedUnknownTables.length > 0 && (
              <div className="text-amber-400 text-[10px]">
                Notice: Skipped unknown tables: {importSummary.skippedUnknownTables.join(', ')}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Download Past Charts */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-4">
        <div>
          <div className="text-sm font-bold text-white">Download Past Charts</div>
          <div className="text-[11px] text-slate-400 mt-0.5">
            Fills your saved data with older candles from Binance so you can study patterns offline. Needs internet while downloading.
          </div>
        </div>

        <div>
          <div className="text-[11px] text-slate-400 mb-1.5">How far back</div>
          <div className="grid grid-cols-5 gap-2">
            {HISTORY_RANGES.map((r) => (
              <button
                key={r.days}
                onClick={() => {
                  setHistoryCustomOpen(false);
                  setHistoryDays(r.days);
                }}
                disabled={historyProgress.running}
                className={`py-2 rounded-xl border text-xs font-bold transition ${
                  !historyCustomOpen && historyDays === r.days
                    ? 'bg-cyan-500/10 border-cyan-500/50 text-white'
                    : 'bg-slate-800/60 border-slate-800 text-slate-400'
                }`}
              >
                {r.label}
              </button>
            ))}
            <button
              onClick={() => {
                setHistoryCustomOpen(true);
                applyHistoryYears(historyYearsText);
              }}
              disabled={historyProgress.running}
              className={`py-2 rounded-xl border text-xs font-bold transition ${
                historyCustomOpen
                  ? 'bg-cyan-500/10 border-cyan-500/50 text-white'
                  : 'bg-slate-800/60 border-slate-800 text-slate-400'
              }`}
            >
              Custom
            </button>
          </div>
          {historyCustomOpen && (
            <div className="flex items-center gap-2 mt-2">
              <input
                type="number"
                inputMode="decimal"
                min="0.1"
                max="20"
                step="0.5"
                value={historyYearsText}
                onChange={(e) => {
                  setHistoryYearsText(e.target.value);
                  applyHistoryYears(e.target.value);
                }}
                disabled={historyProgress.running}
                className="w-24 px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 text-sm text-white font-mono"
              />
              <span className="text-xs text-slate-300">years</span>
              <span className="text-[11px] text-slate-500">(= {historyDays.toLocaleString()} days, max 20 years)</span>
            </div>
          )}
        </div>

        <div>
          <div className="text-[11px] text-slate-400 mb-1.5">Coins</div>
          <div className="flex flex-wrap gap-2">
            {settings.trackedSymbols.map((sym) => (
              <button
                key={sym}
                onClick={() => toggleHistorySymbol(sym)}
                disabled={historyProgress.running}
                className={`px-3 py-2 rounded-xl border text-xs font-bold transition ${
                  !historyExcluded.includes(sym)
                    ? 'bg-cyan-500/10 border-cyan-500/50 text-white'
                    : 'bg-slate-800/60 border-slate-800 text-slate-400'
                }`}
              >
                {sym}
              </button>
            ))}
          </div>
          <div className="text-[10px] text-slate-500 mt-1.5">To add more coins, add them in Settings first.</div>
        </div>

        <div>
          <div className="text-[11px] text-slate-400 mb-1.5">Timeframes</div>
          <div className="grid grid-cols-6 gap-2">
            {HISTORY_TFS.map((tf) => (
              <button
                key={tf}
                onClick={() => toggleHistoryTf(tf)}
                disabled={historyProgress.running}
                className={`py-2 rounded-xl border text-xs font-bold transition ${
                  historyTfs.includes(tf)
                    ? 'bg-cyan-500/10 border-cyan-500/50 text-white'
                    : 'bg-slate-800/60 border-slate-800 text-slate-400'
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        <div className="text-[11px] font-mono text-slate-400">
          About {historyEstimate.toLocaleString()} candles for {historySymbols.length} {historySymbols.length === 1 ? 'coin' : 'coins'}
        </div>
        {historyClamped.length > 0 && (
          <div className="text-[11px] text-amber-300">
            {historyClamped.join(', ')}: only the newest 600,000 candles per coin are downloaded for this timeframe, to keep the phone fast.
          </div>
        )}
        <div className="text-[10px] text-slate-500">
          Candles you already have are skipped. Large downloads can take several minutes.
        </div>

        {historyProgress.text !== '' && (
          <div className="space-y-1.5">
            <div className="w-full bg-slate-800 rounded-full h-2">
              <div
                className="bg-cyan-500 h-2 rounded-full transition-all duration-500"
                style={{ width: `${historyProgress.percent}%` }}
              />
            </div>
            <div className="text-[11px] text-slate-300">{historyProgress.text}</div>
          </div>
        )}

        {historyProgress.running ? (
          <button
            onClick={() => workerClient.cancelHistory()}
            className="w-full py-3 rounded-2xl bg-slate-800 text-slate-200 border border-slate-700 font-bold text-sm active:scale-95 transition"
          >
            Cancel download
          </button>
        ) : (
          <button
            onClick={startHistoryDownload}
            disabled={historyTfs.length === 0 || historySymbols.length === 0 || (historyCustomOpen && !(parseFloat(historyYearsText) > 0))}
            className="w-full py-3 rounded-2xl bg-cyan-500 text-slate-950 font-bold text-sm hover:bg-cyan-400 active:scale-95 transition disabled:opacity-40"
          >
            Start download
          </button>
        )}
      </div>

      {/* 4. Sync Status */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-3xl p-5 shadow-xl flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center text-slate-400">
            <CloudOff className="w-5 h-5" />
          </div>
          <div>
            <div className="text-xs text-slate-400 font-medium">Sync Status</div>
            <div className="text-sm font-bold text-white">Not configured (local only)</div>
          </div>
        </div>
      </div>

      {/* Export Options Modal Sheet */}
      {showExportModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex flex-col justify-end">
          <div className="absolute inset-0" onClick={() => setShowExportModal(false)} />
          <div className="relative bg-slate-900 border-t border-slate-800 rounded-t-3xl p-5 pb-8 max-w-md mx-auto w-full z-10 shadow-2xl">
            <div className="w-10 h-1 bg-slate-700 rounded-full mx-auto mb-4" />
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-white">Export MS-Data v1</h3>
              <button onClick={() => setShowExportModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2 mb-6 text-xs">
              <label className="text-slate-400 block mb-1">Select data to include:</label>
              {[
                { id: 'all', label: 'All Data', desc: 'Candles, ticks, quote bars, gaps, and settings' },
                { id: 'candles', label: 'Candles', desc: 'Candlestick OHLCV data across timeframes' },
                { id: 'liquidity', label: 'Order Book Data', desc: 'Buy/sell price ticks and 1m quote bars' },
                { id: 'settings_profiles', label: 'Settings & Profiles', desc: 'Configuration and clicker marker profiles' },
              ].map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => setExportScope(opt.id as ExportScope)}
                  className={`w-full p-3 rounded-2xl border text-left transition ${
                    exportScope === opt.id
                      ? 'bg-cyan-500/10 border-cyan-500/50 text-white'
                      : 'bg-slate-800/60 border-slate-800 text-slate-400 hover:bg-slate-800'
                  }`}
                >
                  <div className="font-bold text-sm text-slate-100">{opt.label}</div>
                  <div className="text-[11px] text-slate-400">{opt.desc}</div>
                </button>
              ))}
            </div>

            <button
              onClick={handleExport}
              disabled={isExporting}
              className="w-full py-3 rounded-2xl bg-cyan-500 text-slate-950 font-bold text-sm hover:bg-cyan-400 active:scale-98 transition flex items-center justify-center gap-2"
            >
              <Upload className="w-4 h-4" />
              {isExporting ? 'Preparing file...' : 'Save / Share Archive (.msdata.zip)'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
