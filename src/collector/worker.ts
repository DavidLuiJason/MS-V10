import Dexie from 'dexie';
import { db, type TickRecord, type QuoteBarRecord, type CandleRecord, type CollectorLogRecord } from '../data/db';
import { BinanceAdapter, type ExchangeAdapter } from './exchangeAdapter';

let adapter: ExchangeAdapter = new BinanceAdapter();
let trackedSymbols: string[] = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
let dataSource: 'global' | 'us' = 'global';
let recordRawTicks = true;
let rawTickRetentionDays = 3;
let isPaused = false;
let currentAdapterStatus: 'connecting' | 'connected' | 'reconnecting' | 'unreachable' | 'paused' | 'idle' = 'idle';
let reconnectAttempt = 0;
let backfillStatusText: string | null = null;

// Real-time tick coalescing per symbol (at most one stored tick per symbol per 250ms)
const pendingTicksPerSymbol = new Map<string, TickRecord>();
const lastStoredTickTimePerSymbol = new Map<string, number>();

// In-memory quote bars for current minute per symbol
const currentMinuteQuoteBars = new Map<string, QuoteBarRecord>();

// Batches to be written to DB every 1 second
let tickBatch: TickRecord[] = [];
let quoteBarBatch = new Map<string, QuoteBarRecord>();
let candleBatch = new Map<string, CandleRecord>();

// Ticks received in the last 60 seconds for ticks/min calculation
const tickTimestamps: number[] = [];

// Timers
let flushTimer: any = null;
let heartbeatTimer: any = null;
let ticker24hTimer: any = null;
let retentionTimer: any = null;

function calculateTicksPerMin(): number {
  const now = Date.now();
  const cutoff = now - 60000;
  while (tickTimestamps.length > 0 && tickTimestamps[0] < cutoff) {
    tickTimestamps.shift();
  }
  return tickTimestamps.length;
}

function getDynamicStatusLabel(): string {
  if (isPaused) {
    return 'Paused';
  }
  if (currentAdapterStatus === 'unreachable') {
    return 'Data source unreachable';
  }
  if (currentAdapterStatus === 'reconnecting') {
    return `Reconnecting (attempt ${reconnectAttempt})`;
  }
  if (backfillStatusText) {
    return backfillStatusText;
  }
  if (currentAdapterStatus === 'connecting') {
    return 'Connecting...';
  }
  if (currentAdapterStatus === 'connected') {
    const tpm = calculateTicksPerMin();
    return `Collecting: ${trackedSymbols.length} symbols, ${tpm} ticks/min`;
  }
  return 'Initializing';
}

function getStatusState(): 'collecting' | 'reconnecting' | 'unreachable' | 'paused' {
  if (isPaused) return 'paused';
  if (currentAdapterStatus === 'unreachable') return 'unreachable';
  if (currentAdapterStatus === 'reconnecting' || backfillStatusText !== null) return 'reconnecting';
  if (currentAdapterStatus === 'connected') return 'collecting';
  return 'reconnecting';
}

// 1-second batch flush to IndexedDB
async function flushBatches() {
  const ticksToWrite = tickBatch;
  tickBatch = [];

  const quoteBarsToWrite = Array.from(quoteBarBatch.values());
  quoteBarBatch.clear();

  const candlesToWrite = Array.from(candleBatch.values());
  candleBatch.clear();

  try {
    if (ticksToWrite.length > 0) {
      await db.ticks.bulkPut(ticksToWrite);
    }
    if (quoteBarsToWrite.length > 0) {
      await db.quoteBars.bulkPut(quoteBarsToWrite);
    }
    if (candlesToWrite.length > 0) {
      await db.candles.bulkPut(candlesToWrite);
    }
  } catch (err) {
    console.error('Worker error flushing batches to Dexie:', err);
  }
}

// Heartbeat every 5 seconds
async function emitHeartbeat() {
  const now = Date.now();
  const ticksPerMin = calculateTicksPerMin();
  const stateLabel = getDynamicStatusLabel();
  const statusState = getStatusState();

  try {
    await db.collectorLog.add({
      t: now,
      type: 'heartbeat',
      state: stateLabel,
      symbols: trackedSymbols,
      ticksPerMin,
    });
  } catch {
    // ignore
  }

  self.postMessage({
    type: 'heartbeat',
    data: {
      t: now,
      state: stateLabel,
      statusState,
      ticksPerMin,
      symbols: trackedSymbols,
      isPaused,
    },
  });
}

// Fetch 24hr change periodically
async function update24hTickers() {
  if (isPaused || currentAdapterStatus !== 'connected') return;
  for (const sym of trackedSymbols) {
    try {
      const res = await adapter.fetch24hr(sym);
      self.postMessage({
        type: 'ticker24h',
        data: res,
      });
    } catch {
      // ignore
    }
  }
}

// Tick message handler
function handleBookTicker(data: any) {
  const sym = data.s;
  if (!trackedSymbols.includes(sym)) return;

  const now = Date.now();
  tickTimestamps.push(now);

  const u = Number(data.u);
  const bid = Number(data.b);
  const bidQty = Number(data.B);
  const ask = Number(data.a);
  const askQty = Number(data.A);

  const tick: TickRecord = {
    src: 'binance',
    sym,
    u,
    t: now,
    bid,
    ask,
    bidQty,
    askQty,
  };

  // Notify UI immediately for ring buffer / live display
  self.postMessage({
    type: 'liveTick',
    data: tick,
  });

  // Continuous quote bar calculation (1-minute quote bar)
  const minuteT = Math.floor(now / 60000) * 60000;
  const quoteKey = `${sym}_${minuteT}`;
  const spread = ask - bid;

  let qBar = currentMinuteQuoteBars.get(quoteKey);
  if (!qBar || qBar.t !== minuteT) {
    qBar = {
      src: 'binance',
      sym,
      t: minuteT,
      bidO: bid,
      bidH: bid,
      bidL: bid,
      bidC: bid,
      askO: ask,
      askH: ask,
      askL: ask,
      askC: ask,
      spreadAvg: spread,
      spreadMax: spread,
      tickCount: 1,
    };
  } else {
    qBar.bidH = Math.max(qBar.bidH, bid);
    qBar.bidL = Math.min(qBar.bidL, bid);
    qBar.bidC = bid;
    qBar.askH = Math.max(qBar.askH, ask);
    qBar.askL = Math.min(qBar.askL, ask);
    qBar.askC = ask;
    qBar.spreadMax = Math.max(qBar.spreadMax, spread);
    qBar.spreadAvg = (qBar.spreadAvg * qBar.tickCount + spread) / (qBar.tickCount + 1);
    qBar.tickCount++;
  }
  currentMinuteQuoteBars.set(quoteKey, qBar);
  quoteBarBatch.set(quoteKey, qBar);

  // Raw tick coalescing: at most one stored tick per symbol per 250 ms (store the latest)
  if (recordRawTicks) {
    pendingTicksPerSymbol.set(sym, tick);
    const lastStored = lastStoredTickTimePerSymbol.get(sym) || 0;
    if (now - lastStored >= 250) {
      lastStoredTickTimePerSymbol.set(sym, now);
      tickBatch.push(tick);
      pendingTicksPerSymbol.delete(sym);
    }
  }
}

// Kline message handler
function handleKline(data: any) {
  const sym = data.s;
  if (!trackedSymbols.includes(sym)) return;

  const k = data.k;
  const candle: CandleRecord = {
    src: 'binance',
    sym,
    tf: k.i,
    t: Number(k.t),
    o: Number(k.o),
    h: Number(k.h),
    l: Number(k.l),
    c: Number(k.c),
    v: Number(k.v),
    closed: Boolean(k.x),
  };

  const candleKey = `${sym}_${candle.tf}_${candle.t}`;
  candleBatch.set(candleKey, candle);

  self.postMessage({
    type: 'liveCandle',
    data: candle,
  });
}

function handleIncomingMessage(msg: any) {
  if (!msg) return;
  const stream = msg.stream;
  const data = msg.data;

  if (stream && stream.includes('@bookTicker')) {
    handleBookTicker(data);
  } else if (stream && stream.includes('@kline_')) {
    handleKline(data);
  }
}

function handleStatusChange(status: any, details?: any) {
  currentAdapterStatus = status;
  if (status === 'reconnecting') {
    reconnectAttempt = details?.attempt || 1;
  } else if (status === 'connected') {
    reconnectAttempt = 0;
    // On reconnect, scan gaps
    setTimeout(scanForGaps, 1000);
  }

  const stateLabel = getDynamicStatusLabel();
  const statusState = getStatusState();

  self.postMessage({
    type: 'status',
    data: {
      status,
      stateLabel,
      statusState,
      details,
    },
  });
}

let scanInProgress = false;

// Scans for gaps, then automatically re-downloads every missing candle from Binance.
async function scanForGaps() {
  if (scanInProgress) return;
  scanInProgress = true;
  try {
    await scanForGapsInner();
    await repairAllGaps();
    await refreshStaleCandles();
  } finally {
    scanInProgress = false;
  }
}

// Scan candles for gaps
async function scanForGapsInner() {
  const intervals: { tf: string; stepMs: number }[] = [
    { tf: '1m', stepMs: 60 * 1000 },
    { tf: '5m', stepMs: 5 * 60 * 1000 },
    { tf: '15m', stepMs: 15 * 60 * 1000 },
    { tf: '1h', stepMs: 60 * 60 * 1000 },
    { tf: '4h', stepMs: 4 * 60 * 60 * 1000 },
    { tf: '1d', stepMs: 24 * 60 * 60 * 1000 },
  ];

  for (const sym of trackedSymbols) {
    for (const { tf, stepMs } of intervals) {
      try {
        const seriesRange = db.candles
          .where('[src+sym+tf+t]')
          .between(['binance', sym, tf, Dexie.minKey], ['binance', sym, tf, Dexie.maxKey]);

        const seriesCount = await seriesRange.count();
        if (seriesCount < 2) continue;

        const firstCandle = await seriesRange.first();
        const lastCandle = await seriesRange.last();
        if (!firstCandle || !lastCandle) continue;

        // Fast check: if every step between the first and last candle is present, there are no gaps.
        if (seriesCount === Math.round((lastCandle.t - firstCandle.t) / stepMs) + 1) continue;

        const gapPairs: { curr: number; next: number }[] = [];
        let previousT: number | null = null;
        await seriesRange.each((c) => {
          if (previousT !== null && c.t - previousT > stepMs * 1.5) {
            gapPairs.push({ curr: previousT, next: c.t });
          }
          previousT = c.t;
        });

        for (const pair of gapPairs) {
          const curr = pair.curr;
          const next = pair.next;
          const diff = next - curr;

          if (diff > stepMs * 1.5) {
            // Gap detected!
            const from = curr + stepMs;
            const to = next - stepMs;

            // Check if already logged
            const existing = await db.collectorLog
              .where('type')
              .equals('gap')
              .filter((log) => log.sym === sym && log.tf === tf && log.from === from && log.to === to)
              .first();

            if (!existing) {
              await db.collectorLog.add({
                t: Date.now(),
                type: 'gap',
                src: 'binance',
                sym,
                tf,
                from,
                to,
                status: 'open',
                message: `Missing candles from ${new Date(from).toISOString()} to ${new Date(to).toISOString()}`,
              });
            }
          }
        }
      } catch (err) {
        console.error('Error scanning gaps for', sym, tf, err);
      }
    }
  }

  // Also check tick gaps: tick gaps cannot be recovered
  // Binance provides no historical order book / best bid/ask
  // Check ticks range
  for (const sym of trackedSymbols) {
    try {
      const windowStart = Date.now() - 6 * 60 * 60 * 1000;
      const ticks: { t: number }[] = [];
      const lastBeforeWindow = await db.ticks
        .where('[sym+t]')
        .between([sym, Dexie.minKey], [sym, windowStart], true, false)
        .last();
      if (lastBeforeWindow) ticks.push({ t: lastBeforeWindow.t });
      await db.ticks
        .where('[sym+t]')
        .between([sym, windowStart], [sym, Dexie.maxKey], true, true)
        .each((tk) => {
          ticks.push({ t: tk.t });
        });

      if (ticks.length >= 2) {
        for (let i = 0; i < ticks.length - 1; i++) {
          const diff = ticks[i + 1].t - ticks[i].t;
          // If gap > 2 minutes in active trading
          if (diff > 120000) {
            const from = ticks[i].t;
            const to = ticks[i + 1].t;
            const existing = await db.collectorLog
              .where('type')
              .equals('gap')
              .filter((log) => log.sym === sym && log.tf === 'ticks' && log.from === from)
              .first();

            if (!existing) {
              await db.collectorLog.add({
                t: Date.now(),
                type: 'gap',
                src: 'binance',
                sym,
                tf: 'ticks',
                from,
                to,
                status: 'unrecoverable',
                message: 'Tick gaps cannot be recovered (Binance provides no history for best bid/ask)',
              });
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  self.postMessage({ type: 'gapsUpdated' });
}

// Repair candle gaps by paginating REST klines
async function repairGap(gapId: number) {
  const gap = await db.collectorLog.get(gapId);
  if (!gap || gap.status !== 'open' || !gap.sym || !gap.tf || !gap.from || !gap.to) {
    return;
  }

  if (gap.tf === 'ticks') {
    // Tick gaps are unrecoverable
    await db.collectorLog.update(gapId, { status: 'unrecoverable' });
    self.postMessage({ type: 'gapsUpdated' });
    return;
  }

  const sym = gap.sym;
  const tf = gap.tf;
  let currentStartTime = gap.from;
  const endTime = gap.to;

  backfillStatusText = `Backfilling ${sym} ${tf} (0%)`;
  emitHeartbeat();

  try {
    while (currentStartTime < endTime) {
      const klines = await adapter.fetchKlines(sym, tf, currentStartTime, 1000);
      if (klines.length === 0) break;

      const candlesToAdd: CandleRecord[] = klines.map((k) => ({
        src: 'binance',
        sym,
        tf,
        t: k.openTime,
        o: k.open,
        h: k.high,
        l: k.low,
        c: k.close,
        v: k.volume,
        closed: k.isClosed,
      }));

      await db.candles.bulkPut(candlesToAdd);

      const lastKline = klines[klines.length - 1];
      const progress = Math.min(100, Math.round(((lastKline.openTime - gap.from) / (endTime - gap.from)) * 100));
      backfillStatusText = `Backfilling ${sym} ${tf} (${progress}%)`;
      emitHeartbeat();

      if (lastKline.closeTime >= endTime || lastKline.openTime === currentStartTime) {
        break;
      }
      currentStartTime = lastKline.openTime + 1;
    }

    await db.collectorLog.update(gapId, { status: 'repaired' });
  } catch (err) {
    console.error('Failed to repair gap:', err);
  } finally {
    backfillStatusText = null;
    emitHeartbeat();
    self.postMessage({ type: 'gapsUpdated' });
  }
}

async function repairAllGaps() {
  const openGaps = await db.collectorLog
    .where('type')
    .equals('gap')
    .filter((g) => g.status === 'open')
    .toArray();

  for (const gap of openGaps) {
    if (gap.id) {
      await repairGap(gap.id);
    }
  }
}

// Raw tick retention job: rolls older ticks into quote bars and deletes them
async function cleanOldTicks() {
  if (!rawTickRetentionDays || rawTickRetentionDays <= 0) return;
  const cutoff = Date.now() - rawTickRetentionDays * 24 * 60 * 60 * 1000;

  try {
    // Delete ticks older than retention cutoff
    await db.ticks.where('t').below(cutoff).delete();
  } catch (err) {
    console.error('Error running raw tick cleanup:', err);
  }
}

function startCollector() {
  adapter.setHost(dataSource);
  adapter.connect(trackedSymbols, handleIncomingMessage, handleStatusChange);

  if (!flushTimer) {
    flushTimer = setInterval(flushBatches, 1000);
  }
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(emitHeartbeat, 5000);
  }
  if (!ticker24hTimer) {
    update24hTickers();
    ticker24hTimer = setInterval(update24hTickers, 60000);
  }
  if (!retentionTimer) {
    cleanOldTicks();
    retentionTimer = setInterval(cleanOldTicks, 24 * 60 * 60 * 1000);
  }
}

function stopCollector() {
  adapter.disconnect();
  isPaused = true;
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  flushBatches();
  emitHeartbeat();
}

// ===== Past chart download and unfinished-candle refresh =====
const HISTORY_STEP_MS: Record<string, number> = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

const HISTORY_MAX_PER_SERIES = 600000;
let historyRunning = false;
let historyCancelRequested = false;

function postHistoryProgress(running: boolean, percent: number, text: string) {
  self.postMessage({
    type: 'historyProgress',
    data: { running, percent: Math.max(0, Math.min(100, Math.round(percent))), text },
  });
}

async function downloadHistory(symbols: string[], timeframes: string[], fromMs: number) {
  if (historyRunning) return;
  historyRunning = true;
  historyCancelRequested = false;

  const series: { sym: string; tf: string }[] = [];
  for (const sym of symbols) {
    for (const tf of timeframes) {
      if (HISTORY_STEP_MS[tf]) series.push({ sym, tf });
    }
  }

  let totalSaved = 0;
  let percent = 0;
  postHistoryProgress(true, 0, 'Checking what is already saved...');

  try {
    for (let index = 0; index < series.length; index++) {
      const { sym, tf } = series[index];
      const stepMs = HISTORY_STEP_MS[tf];
      const cappedFrom = Math.max(fromMs, Date.now() - HISTORY_MAX_PER_SERIES * stepMs);
      const wantedStart = Math.floor(cappedFrom / stepMs) * stepMs;

      // Work out which parts are already saved, so they are not downloaded again.
      const allSaved = db.candles
        .where('[src+sym+tf+t]')
        .between(['binance', sym, tf, Dexie.minKey], ['binance', sym, tf, Dexie.maxKey]);
      const firstSaved = await allSaved.first();
      const lastSaved = await allSaved.last();

      let parts: { from: number; until: number }[] = [{ from: wantedStart, until: Infinity }];
      if (firstSaved && lastSaved && wantedStart <= lastSaved.t) {
        const countFrom = Math.max(wantedStart, firstSaved.t);
        const savedCount = await db.candles
          .where('[src+sym+tf+t]')
          .between(['binance', sym, tf, countFrom], ['binance', sym, tf, lastSaved.t], true, true)
          .count();
        const expectedCount = Math.round((lastSaved.t - countFrom) / stepMs) + 1;
        if (savedCount === expectedCount) {
          parts = [];
          if (wantedStart < firstSaved.t) parts.push({ from: wantedStart, until: firstSaved.t });
          parts.push({ from: lastSaved.t, until: Infinity });
        }
      }

      for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        const part = parts[partIndex];
        let start = part.from;

        while (true) {
          if (historyCancelRequested) {
            postHistoryProgress(false, percent, 'Cancelled. ' + totalSaved.toLocaleString() + ' candles were saved.');
            return;
          }

          const klines = await adapter.fetchKlines(sym, tf, start, 1000);
          if (klines.length === 0) break;

          const nowMs = Date.now();
          const records: CandleRecord[] = klines
            .filter((k) => k.closeTime < nowMs && k.openTime < part.until)
            .map((k) => ({
              src: 'binance',
              sym,
              tf,
              t: k.openTime,
              o: k.open,
              h: k.high,
              l: k.low,
              c: k.close,
              v: k.volume,
              closed: true,
            }));
          if (records.length > 0) {
            await db.candles.bulkPut(records);
            totalSaved += records.length;
          }

          const last = klines[klines.length - 1];
          const partFraction = Math.min(
            1,
            Math.max(0, (last.openTime - part.from) / Math.max(1, Math.min(nowMs, part.until) - part.from))
          );
          const seriesFraction = (partIndex + partFraction) / parts.length;
          percent = ((index + seriesFraction) / series.length) * 100;
          postHistoryProgress(true, percent, 'Downloading ' + sym + ' ' + tf + ' - ' + totalSaved.toLocaleString() + ' new candles saved');

          const next = last.openTime + stepMs;
          if (klines.length < 1000 || last.closeTime >= nowMs || next >= part.until || next <= start) break;
          start = next;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    }
    postHistoryProgress(false, 100, 'Done. ' + totalSaved.toLocaleString() + ' candles saved (candles you already had were skipped).');
  } catch (err: any) {
    postHistoryProgress(
      false,
      percent,
      'Stopped: ' + String(err?.message || err) + '. ' + totalSaved.toLocaleString() + ' candles were saved. Press Start download again to continue.'
    );
  } finally {
    historyRunning = false;
    self.postMessage({ type: 'gapsUpdated' });
    setTimeout(scanForGaps, 1000);
  }
}

// Re-downloads recent candles that were saved as unfinished but have since closed (their final update was missed).
async function refreshStaleCandles() {
  const nowMs = Date.now();
  const windowStart = nowMs - 7 * 24 * 60 * 60 * 1000;
  let fixedAny = false;

  for (const sym of trackedSymbols) {
    for (const tf of Object.keys(HISTORY_STEP_MS)) {
      const stepMs = HISTORY_STEP_MS[tf];
      try {
        const stale = await db.candles
          .where('[src+sym+tf+t]')
          .between(['binance', sym, tf, windowStart], ['binance', sym, tf, Dexie.maxKey])
          .filter((c) => !c.closed && c.t + stepMs <= nowMs - 5000)
          .toArray();
        if (stale.length === 0) continue;

        let start = stale[0].t;
        for (const c of stale) {
          if (c.t < start) start = c.t;
        }

        let rounds = 0;
        while (rounds < 30) {
          rounds++;
          const klines = await adapter.fetchKlines(sym, tf, start, 1000);
          if (klines.length === 0) break;
          const checkMs = Date.now();
          const fixed: CandleRecord[] = klines
            .filter((k) => k.closeTime < checkMs)
            .map((k) => ({
              src: 'binance',
              sym,
              tf,
              t: k.openTime,
              o: k.open,
              h: k.high,
              l: k.low,
              c: k.close,
              v: k.volume,
              closed: true,
            }));
          if (fixed.length > 0) {
            await db.candles.bulkPut(fixed);
            fixedAny = true;
          }
          const last = klines[klines.length - 1];
          const next = last.openTime + stepMs;
          if (klines.length < 1000 || next <= start) break;
          start = next;
        }
      } catch (err) {
        console.error('Error refreshing unfinished candles for', sym, tf, err);
      }
    }
  }

  if (fixedAny) {
    self.postMessage({ type: 'gapsUpdated' });
  }
}

self.onmessage = async (e: MessageEvent) => {
  const { type, data } = e.data;

  switch (type) {
    case 'init': {
      if (data) {
        if (data.dataSource) dataSource = data.dataSource;
        if (data.trackedSymbols) trackedSymbols = data.trackedSymbols;
        if (typeof data.recordRawTicks === 'boolean') recordRawTicks = data.recordRawTicks;
        if (data.rawTickRetentionDays) rawTickRetentionDays = data.rawTickRetentionDays;
        if (typeof data.collectorPaused === 'boolean') isPaused = data.collectorPaused;
      }
      if (!isPaused) {
        startCollector();
      } else {
        currentAdapterStatus = 'paused';
        emitHeartbeat();
      }
      // Scan gaps on start
      setTimeout(scanForGaps, 2000);
      break;
    }

    case 'pause': {
      isPaused = true;
      stopCollector();
      break;
    }

    case 'resume': {
      isPaused = false;
      startCollector();
      break;
    }

    case 'setDataSource': {
      dataSource = data;
      adapter.setHost(dataSource);
      break;
    }

    case 'setTrackedSymbols': {
      trackedSymbols = data;
      adapter.subscribe(trackedSymbols);
      update24hTickers();
      break;
    }

    case 'setRecordRawTicks': {
      recordRawTicks = data;
      break;
    }

    case 'setRetentionDays': {
      rawTickRetentionDays = data;
      cleanOldTicks();
      break;
    }

    case 'scanGaps': {
      await scanForGaps();
      break;
    }

    case 'repairGap': {
      if (data?.gapId) {
        await repairGap(data.gapId);
      }
      break;
    }

    case 'repairAllGaps': {
      await repairAllGaps();
      break;
    }

    case 'downloadHistory': {
      if (data && Array.isArray(data.symbols) && Array.isArray(data.timeframes) && typeof data.fromMs === 'number') {
        downloadHistory(data.symbols, data.timeframes, data.fromMs);
      }
      break;
    }

    case 'cancelHistory': {
      historyCancelRequested = true;
      break;
    }
  }
};
