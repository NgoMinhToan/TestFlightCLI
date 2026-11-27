/** App id rules the server applies: one safe path segment. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** versionName may also be a string; keep the id pattern for app ids only. */
export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** C0 controls (0x00-0x1F), DEL, and C1 controls (0x80-0x9F). */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Play Console-style version names, shared with the server: any non-empty
 * UTF-8 string up to 200 bytes that is safe as a single path segment.
 *
 * Allowed: spaces (not leading/trailing), `+`, parentheses, brackets, Unicode.
 * Rejected: empty/blank, leading or trailing dot/space, `.`/`..`, `/`, `\`,
 * NUL and other control characters.
 */
export function isValidVersionName(value: string): boolean {
  if (value.length === 0) return false;
  if (value !== value.trim()) return false;
  if (value === "." || value === "..") return false;
  if (value.startsWith(".") || value.endsWith(".")) return false;
  if (Buffer.byteLength(value, "utf8") > 200) return false;
  if (/[/\\]/.test(value)) return false;
  if (CONTROL_CHARACTERS.test(value)) return false;
  return true;
}

/** The hint shown whenever a version name is rejected. */
export const VERSION_NAME_RULE =
  "Use 1-200 UTF-8 bytes with no leading/trailing spaces or dots, no path separators (/ or \\), and no control characters. Spaces, '+', parentheses and Unicode are allowed.";

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
