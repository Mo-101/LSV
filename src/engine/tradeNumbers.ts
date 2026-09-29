// Preserve legitimate zero values when reading historical numeric fields.
export function finiteNumber(value: unknown, fallback = 0): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
