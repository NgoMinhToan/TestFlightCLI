/** Same id rules the server applies to app ids and version names. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value);
}

export function parsePositiveInteger(raw: string, label: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${label} must be a positive integer (got "${raw}")`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer (got "${raw}")`);
  }
  return value;
}

export function parseOptionalDate(raw: string, label: string): string {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be an ISO date (got "${raw}")`);
  }
  return date.toISOString();
}
