const ANSI = {
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
} as const;

let jsonMode = false;
let colorEnabled = process.stdout.isTTY === true && !Object.hasOwn(process.env, "NO_COLOR");

export interface OutputConfig {
  json: boolean;
  /** `undefined` keeps the TTY default. */
  color?: boolean;
}

export function configureOutput(config: OutputConfig): void {
  jsonMode = config.json;
  if (config.color !== undefined) colorEnabled = config.color;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

export function paint(name: keyof typeof ANSI, text: string): string {
  if (!colorEnabled) return text;
  return `\x1b[${ANSI[name]}m${text}\x1b[0m`;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function write(stream: NodeJS.WriteStream, line: string): void {
  stream.write(`${line}\n`);
}

export function line(text = ""): void {
  if (jsonMode) return;
  write(process.stdout, text);
}

export function heading(text: string): void {
  if (jsonMode) return;
  write(process.stdout, paint("bold", text));
}

export function info(text: string): void {
  if (jsonMode) return;
  write(process.stdout, paint("dim", text));
}

export function success(text: string): void {
  if (jsonMode) return;
  write(process.stdout, `${paint("green", "✓")} ${text}`);
}

export function note(text: string): void {
  if (jsonMode) return;
  write(process.stdout, `${paint("cyan", "→")} ${text}`);
}

export function warn(text: string): void {
  write(process.stderr, `${paint("yellow", "warning:")} ${text}`);
}

export function printJson(value: unknown): void {
  write(process.stdout, JSON.stringify(value, null, 2));
}

export function printError(message: string, hint?: string): void {
  write(process.stderr, `${paint("red", "error:")} ${message}`);
  if (hint) write(process.stderr, `  ${paint("dim", `hint: ${hint}`)}`);
}

export function maskKey(key: string | null | undefined): string {
  if (!key) return "(none)";
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().slice(0, 16).replace("T", " ");
}

export function shortSha(sha: string | null | undefined): string {
  if (!sha) return "-";
  return sha.slice(0, 12);
}

export type Alignment = "left" | "right";

/** Renders a borderless, aligned table. ANSI codes do not affect column widths. */
export function renderTable(
  headers: string[],
  rows: string[][],
  align: Alignment[] = [],
): string {
  const widths = headers.map((header, index) => {
    const cells = rows.map((row) => stripAnsi(row[index] ?? ""));
    return Math.max(stripAnsi(header).length, ...cells.map((cell) => cell.length), 0);
  });

  const format = (cells: string[], headerRow: boolean): string =>
    cells
      .map((cell, index) => {
        const width = widths[index] ?? 0;
        const visible = stripAnsi(cell);
        const padding = " ".repeat(Math.max(0, width - visible.length));
        const alignment = align[index] ?? "left";
        const padded = alignment === "right" ? `${padding}${cell}` : `${cell}${padding}`;
        return headerRow ? paint("bold", padded) : padded;
      })
      .join("  ")
      .trimEnd();

  const headerLine = format(headers, true);
  const divider = paint("dim", widths.map((width) => "─".repeat(width)).join("  "));
  const body = rows.map((row) => format(row, false));

  return [headerLine, divider, ...body].join("\n");
}

export function printTable(headers: string[], rows: string[][], align: Alignment[] = []): void {
  if (jsonMode) return;
  write(process.stdout, renderTable(headers, rows, align));
}

let lastProgressAt = 0;

/**
 * Draws a single-line upload/download progress bar on stderr. It is silent in
 * JSON mode, when stderr is not a TTY, or when `enabled` is false.
 */
export function progress(
  label: string,
  done: number,
  total: number,
  options: { enabled?: boolean; force?: boolean } = {},
): void {
  if (jsonMode || options.enabled === false || process.stderr.isTTY !== true) return;
  const now = Date.now();
  if (!options.force && now - lastProgressAt < 80) return;
  lastProgressAt = now;

  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  const percent = Math.floor(ratio * 100);
  const width = 22;
  const filled = Math.round(ratio * width);
  const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
  const text = `  ${label} ${bar} ${String(percent).padStart(3)}%  ${formatBytes(done)} / ${formatBytes(total)}`;
  process.stderr.write(`\r\x1b[2K${text}`);

  if (done >= total) {
    process.stderr.write("\n");
    lastProgressAt = 0;
  }
}

export function clearProgress(): void {
  if (jsonMode || process.stderr.isTTY !== true) return;
  if (lastProgressAt > 0) process.stderr.write("\r\x1b[2K");
  lastProgressAt = 0;
}
