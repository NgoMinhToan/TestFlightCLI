/**
 * ABI labels in the same priority order the server uses. The first artifact a
 * version publishes is its default, so `universal` always wins.
 */
export const ABI_PRIORITY = [
  "universal",
  "arm64-v8a",
  "armeabi-v7a",
  "x86_64",
  "x86",
  "riscv64",
  "armeabi",
] as const;

export type Abi = (typeof ABI_PRIORITY)[number];

const ABI_RANK = new Map<string, number>(ABI_PRIORITY.map((abi, index) => [abi, index]));
const ABI_SET = new Set<string>(ABI_PRIORITY);

/**
 * Filename tokens, longest/most specific first so `armeabi-v7a` never matches
 * as `armeabi` and `x86_64` never matches as `x86`.
 */
const FILENAME_TOKENS: readonly Abi[] = [
  "universal",
  "arm64-v8a",
  "armeabi-v7a",
  "x86_64",
  "riscv64",
  "armeabi",
  "x86",
];

export function normalizeAbi(value: string): Abi | null {
  const normalized = value.trim().toLowerCase();
  return ABI_SET.has(normalized) ? (normalized as Abi) : null;
}

export function compareAbi(left: Abi, right: Abi): number {
  return (ABI_RANK.get(left) ?? 99) - (ABI_RANK.get(right) ?? 99);
}

export function sortAbis(abis: Iterable<Abi>): Abi[] {
  return [...new Set(abis)].sort(compareAbi);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Infers an ABI from an APK filename such as `app-arm64-v8a.apk` or
 * `release_universal.apk`. Returns `null` when no token matches.
 */
export function inferAbiFromFilename(filename: string): Abi | null {
  const base = filename.toLowerCase().replace(/\.apk$/i, "");
  for (const abi of FILENAME_TOKENS) {
    const token = escapeRegExp(abi);
    const pattern = new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`);
    if (pattern.test(base)) return abi;
  }
  return null;
}

export function isAbi(value: string): value is Abi {
  return ABI_SET.has(value);
}
