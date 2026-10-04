import JSZip from 'jszip';
import { db, type TickRecord, type QuoteBarRecord, type CandleRecord, type CollectorLogRecord, type SettingRecord, type ClickerProfileRecord, type PaperLedgerRecord } from '../data/db';

export type ExportScope = 'all' | 'candles' | 'liquidity' | 'settings_profiles';

export interface ManifestTableEntry {
  file: string;
  count: number;
  sha256: string;
}

export interface Manifest {
  format: 'ms-data';
  version: 1;
  createdAt: string;
  app: 'MarketScope';
  appVersion: '1.0.0';
  tables: Record<string, ManifestTableEntry>;
}

export interface ImportSummary {
  tables: {
    name: string;
    file: string;
    totalInFile: number;
    added: number;
    skipped: number;
    status: 'imported' | 'skipped_unknown' | 'error';
    error?: string;
  }[];
  skippedUnknownTables: string[];
}

export async function calculateSha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function exportDataZip(scope: ExportScope = 'all'): Promise<{ blob: Blob; filename: string }> {
  const zip = new JSZip();
  const tables: Record<string, ManifestTableEntry> = {};

  const includeCandles = scope === 'all' || scope === 'candles';
  const includeLiquidity = scope === 'all' || scope === 'liquidity';
  const includeSettings = scope === 'all' || scope === 'settings_profiles';

  if (includeLiquidity) {
    // ticks
    const ticks = await db.ticks.toArray();
    const ticksNdjson = ticks.map((row) => JSON.stringify(row)).join('\n') + (ticks.length > 0 ? '\n' : '');
    const ticksSha = await calculateSha256(ticksNdjson);
    zip.file('ticks.ndjson', ticksNdjson);
    tables['ticks'] = { file: 'ticks.ndjson', count: ticks.length, sha256: ticksSha };

    // quoteBars
    const quoteBars = await db.quoteBars.toArray();
    const quoteBarsNdjson = quoteBars.map((row) => JSON.stringify(row)).join('\n') + (quoteBars.length > 0 ? '\n' : '');
    const quoteBarsSha = await calculateSha256(quoteBarsNdjson);
    zip.file('quoteBars.ndjson', quoteBarsNdjson);
    tables['quoteBars'] = { file: 'quoteBars.ndjson', count: quoteBars.length, sha256: quoteBarsSha };
  }

  if (includeCandles) {
    // candles
    const candles = await db.candles.toArray();
    const candlesNdjson = candles.map((row) => JSON.stringify(row)).join('\n') + (candles.length > 0 ? '\n' : '');
    const candlesSha = await calculateSha256(candlesNdjson);
    zip.file('candles.ndjson', candlesNdjson);
    tables['candles'] = { file: 'candles.ndjson', count: candles.length, sha256: candlesSha };
  }

  if (scope === 'all') {
    // gaps from collectorLog where type === 'gap'
    const gaps = await db.collectorLog.where('type').equals('gap').toArray();
    const gapsNdjson = gaps.map((row) => JSON.stringify(row)).join('\n') + (gaps.length > 0 ? '\n' : '');
    const gapsSha = await calculateSha256(gapsNdjson);
    zip.file('gaps.ndjson', gapsNdjson);
    tables['gaps'] = { file: 'gaps.ndjson', count: gaps.length, sha256: gapsSha };
  }

  if (includeSettings) {
    // settings
    const settings = await db.settings.toArray();
    const settingsNdjson = settings.map((row) => JSON.stringify(row)).join('\n') + (settings.length > 0 ? '\n' : '');
    const settingsSha = await calculateSha256(settingsNdjson);
    zip.file('settings.ndjson', settingsNdjson);
    tables['settings'] = { file: 'settings.ndjson', count: settings.length, sha256: settingsSha };

    // clickerProfiles
    const profiles = await db.clickerProfiles.toArray();
    const profilesNdjson = profiles.map((row) => JSON.stringify(row)).join('\n') + (profiles.length > 0 ? '\n' : '');
    const profilesSha = await calculateSha256(profilesNdjson);
    zip.file('clickerProfiles.ndjson', profilesNdjson);
    tables['clickerProfiles'] = { file: 'clickerProfiles.ndjson', count: profiles.length, sha256: profilesSha };

    // paperLedger
    const ledger = await db.paperLedger.toArray();
    const ledgerNdjson = ledger.map((row) => JSON.stringify(row)).join('\n') + (ledger.length > 0 ? '\n' : '');
    const ledgerSha = await calculateSha256(ledgerNdjson);
    zip.file('paperLedger.ndjson', ledgerNdjson);
    tables['paperLedger'] = { file: 'paperLedger.ndjson', count: ledger.length, sha256: ledgerSha };
  }

  const manifest: Manifest = {
    format: 'ms-data',
    version: 1,
    createdAt: new Date().toISOString(),
    app: 'MarketScope',
    appVersion: '1.0.0',
    tables,
  };

  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  const blob = await zip.generateAsync({ type: 'blob' });

  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const min = String(now.getUTCMinutes()).padStart(2, '0');
  const filename = `marketscope-${yyyy}-${mm}-${dd}-${hh}${min}.msdata.zip`;

  return { blob, filename };
}

export async function importDataZip(file: File): Promise<ImportSummary> {
  const zip = await JSZip.loadAsync(file);

  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) {
    throw new Error('Invalid archive: manifest.json is missing.');
  }

  let manifest: Manifest;
  try {
    const manifestText = await manifestFile.async('text');
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error('Invalid archive: manifest.json is corrupted or unreadable.');
  }

  if (manifest.format !== 'ms-data') {
    throw new Error(`Unsupported format "${manifest.format}". Expected "ms-data".`);
  }

  if (manifest.version !== 1) {
    throw new Error(`Unsupported version ${manifest.version}. Only version 1 is supported.`);
  }

  const summary: ImportSummary = {
    tables: [],
    skippedUnknownTables: [],
  };

  const knownTables = new Set(['ticks', 'quoteBars', 'candles', 'gaps', 'settings', 'clickerProfiles', 'paperLedger']);

  for (const [tableName, meta] of Object.entries(manifest.tables)) {
    if (!knownTables.has(tableName)) {
      summary.skippedUnknownTables.push(tableName);
      summary.tables.push({
        name: tableName,
        file: meta.file,
        totalInFile: meta.count,
        added: 0,
        skipped: meta.count,
        status: 'skipped_unknown',
      });
      continue;
    }

    const tableZipFile = zip.file(meta.file);
    if (!tableZipFile) {
      throw new Error(`Missing table data file "${meta.file}" referenced in manifest.`);
    }

    const contentText = await tableZipFile.async('text');
    const computedSha = await calculateSha256(contentText);

    if (computedSha !== meta.sha256) {
      throw new Error(
        `Integrity check failed for ${meta.file}. Expected SHA-256 ${meta.sha256}, got ${computedSha}. File is corrupted.`
      );
    }

    const lines = contentText.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length !== meta.count) {
      throw new Error(
        `Count mismatch in ${meta.file}. Manifest specifies ${meta.count} records, but found ${lines.length} lines.`
      );
    }

    const CHUNK_SIZE = 5000;
    let addedCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
      const chunkLines = lines.slice(i, i + CHUNK_SIZE);
      const parsedRecords = chunkLines.map((line) => JSON.parse(line));

      if (tableName === 'ticks') {
        const batch = parsedRecords as TickRecord[];
        const countBefore = await db.ticks.count();
        await db.ticks.bulkPut(batch);
        const countAfter = await db.ticks.count();
        const diff = countAfter - countBefore;
        addedCount += Math.max(0, diff);
        skippedCount += (batch.length - Math.max(0, diff));
      } else if (tableName === 'quoteBars') {
        const batch = parsedRecords as QuoteBarRecord[];
        const countBefore = await db.quoteBars.count();
        await db.quoteBars.bulkPut(batch);
        const countAfter = await db.quoteBars.count();
        const diff = countAfter - countBefore;
        addedCount += Math.max(0, diff);
        skippedCount += (batch.length - Math.max(0, diff));
      } else if (tableName === 'candles') {
        const batch = parsedRecords as CandleRecord[];
        const countBefore = await db.candles.count();
        await db.candles.bulkPut(batch);
        const countAfter = await db.candles.count();
        const diff = countAfter - countBefore;
        addedCount += Math.max(0, diff);
        skippedCount += (batch.length - Math.max(0, diff));
      } else if (tableName === 'gaps') {
        const batch = parsedRecords as CollectorLogRecord[];
        const countBefore = await db.collectorLog.count();
        await db.collectorLog.bulkPut(batch);
        const countAfter = await db.collectorLog.count();
        const diff = countAfter - countBefore;
        addedCount += Math.max(0, diff);
        skippedCount += (batch.length - Math.max(0, diff));
      } else if (tableName === 'settings') {
        const rawBatch = parsedRecords as SettingRecord[];
        // NEVER changes the current 'paperRunId'
        const batch = rawBatch.filter((s) => s.key !== 'paperRunId');
        const countBefore = await db.settings.count();
        await db.settings.bulkPut(batch);
        const countAfter = await db.settings.count();
        const diff = countAfter - countBefore;
        addedCount += Math.max(0, diff);
        skippedCount += (rawBatch.length - Math.max(0, diff));
      } else if (tableName === 'clickerProfiles') {
        const batch = parsedRecords as ClickerProfileRecord[];
        const countBefore = await db.clickerProfiles.count();
        await db.clickerProfiles.bulkPut(batch);
        const countAfter = await db.clickerProfiles.count();
        const diff = countAfter - countBefore;
        addedCount += Math.max(0, diff);
        skippedCount += (batch.length - Math.max(0, diff));
      } else if (tableName === 'paperLedger') {
        const batch = parsedRecords as PaperLedgerRecord[];
        const countBefore = await db.paperLedger.count();
        await db.paperLedger.bulkPut(batch);
        const countAfter = await db.paperLedger.count();
        const diff = countAfter - countBefore;
        addedCount += Math.max(0, diff);
        skippedCount += (batch.length - Math.max(0, diff));
      }
    }

    summary.tables.push({
      name: tableName,
      file: meta.file,
      totalInFile: lines.length,
      added: addedCount,
      skipped: skippedCount,
      status: 'imported',
    });
  }

  return summary;
}

export async function exportCandlesCsv(): Promise<{ blob: Blob; filename: string }> {
  const candles = await db.candles.toArray();
  candles.sort((a, b) => a.sym.localeCompare(b.sym) || a.tf.localeCompare(b.tf) || a.t - b.t);
  const lines: string[] = ['source,symbol,timeframe,open_time_ms,open_time_utc,open,high,low,close,volume,closed'];
  for (const c of candles) {
    lines.push(
      [c.src, c.sym, c.tf, c.t, new Date(c.t).toISOString(), c.o, c.h, c.l, c.c, c.v, c.closed ? 1 : 0].join(',')
    );
  }
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const min = String(now.getUTCMinutes()).padStart(2, '0');
  const filename = `marketscope-candles-${yyyy}-${mm}-${dd}-${hh}${min}.csv`;
  return { blob, filename };
}
