import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface RuntimeConfig {
  revision: number;
  mode: 'SIGNAL_ONLY' | 'PAPER' | 'LIVE';
  halted: boolean;
  autoExecute: boolean;
  marginPerSlotUsd: number;
  totalRiskPoolUsd: number;
  leverage: number;
  maxActiveSlots: number;
  microCapitalTier: 'INSTITUTIONAL_250K' | 'MICRO_FLIGHT_250' | 'MINI_MICRO_10' | 'CUSTOM';
  minLiquidationUsd: number;
  absorptionBuffer: number;
  usdQueueHurdle: number;
  allowedSymbols: string[];
  entryTimeoutSeconds: number;
  holdSeconds: number;
  takeProfitPct: number;
}
export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  revision: 0, mode: 'SIGNAL_ONLY', halted: false, autoExecute: false,
  marginPerSlotUsd: 5, totalRiskPoolUsd: 10, leverage: 10, maxActiveSlots: 2,
  microCapitalTier: 'MINI_MICRO_10', minLiquidationUsd: 50000,
  absorptionBuffer: 1.45, usdQueueHurdle: 150000,
  allowedSymbols: ['SOLUSDT', 'DOGEUSDT', 'XRPUSDT', 'SUIUSDT', 'ETHUSDT', 'AVAXUSDT'],
  entryTimeoutSeconds: 300, holdSeconds: 90, takeProfitPct: 0.005,
};
export function atomicWrite(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  if (process.platform !== 'win32') {
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
}
export function validateConfig(current: RuntimeConfig, patch: Partial<RuntimeConfig>): RuntimeConfig {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Config must be an object');
  for (const key of Object.keys(patch)) if (!(key in DEFAULT_RUNTIME_CONFIG)) throw new Error(`Unsupported execution setting: ${key}`);
  const next = { ...current, ...patch, revision: current.revision + 1 };
  if (!['SIGNAL_ONLY', 'PAPER', 'LIVE'].includes(next.mode)) throw new Error('Invalid execution mode');
  if (!['INSTITUTIONAL_250K', 'MICRO_FLIGHT_250', 'MINI_MICRO_10', 'CUSTOM'].includes(next.microCapitalTier)) throw new Error('Invalid tier');
  for (const k of ['halted', 'autoExecute'] as const) if (typeof next[k] !== 'boolean') throw new Error(`Invalid ${k}`);
  const ranges = {
    marginPerSlotUsd: [1, 25000], totalRiskPoolUsd: [1, 250000], leverage: [1, 20],
    maxActiveSlots: [1, 5], minLiquidationUsd: [1000, 1000000000], absorptionBuffer: [1, 5],
    usdQueueHurdle: [0, 1000000000], entryTimeoutSeconds: [10, 3600], holdSeconds: [10, 900], takeProfitPct: [0.0001, 0.1],
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const value = next[key as keyof RuntimeConfig];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
  }
  if (!Number.isInteger(next.maxActiveSlots) || !Number.isInteger(next.leverage)) throw new Error('Slots and leverage must be integers');
  if (next.marginPerSlotUsd * next.maxActiveSlots > next.totalRiskPoolUsd) throw new Error('Slot margins exceed the risk pool');
  if (!Array.isArray(next.allowedSymbols) || next.allowedSymbols.length > 100 || next.allowedSymbols.some(s => typeof s !== 'string' || !/^[A-Z0-9]{2,20}USDT$/.test(s))) throw new Error('Invalid symbol allowlist');
  return next;
}
export class ConfigStore {
  private value: RuntimeConfig;
  constructor(private file: string) {
    this.value = { ...DEFAULT_RUNTIME_CONFIG };
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.value = { ...validateConfig(DEFAULT_RUNTIME_CONFIG, saved), revision: saved.revision ?? 0 };
    }
  }
  get() { return structuredClone(this.value); }
  update(patch: Partial<RuntimeConfig>, revision: number) {
    if (revision !== this.value.revision) throw new Error('Config changed in another session. Refresh and retry.');
    const next = validateConfig(this.value, patch);
    atomicWrite(this.file, next);
    this.value = next;
    return this.get();
  }
}

// One writer per state directory. Crash leftovers are reclaimed only when the PID is gone.
// The lock records `pid@hostname`: a different hostname (new container on the
// same volume) means the writer cannot be alive, and PIDs inside a container's
// namespace cannot be compared across restarts.
export function acquireStateLock(directory: string) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'writer.lock');
  const owner = () => `${process.pid}@${os.hostname()}`;
  const create = () => { const fd = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(fd, owner()); fs.closeSync(fd); };
  try { create(); }
  catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    const [pidText, hostname] = fs.readFileSync(file, 'utf8').split('@');
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid execution state lock; inspect before restarting');
    if (hostname && hostname !== os.hostname()) { fs.unlinkSync(file); create(); }
    else {
      let alive = true;
      try { process.kill(pid, 0); } catch (e: any) { if (e.code === 'ESRCH') alive = false; else throw e; }
      if (alive) throw new Error('Another process owns this execution state directory');
      fs.unlinkSync(file); create();
    }
  }
  const release = () => {
    try { if (fs.readFileSync(file, 'utf8') === owner()) fs.unlinkSync(file); } catch { /* Already released. */ }
  };
  process.once('exit', release);
  return release;
}
