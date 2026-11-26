import { open } from "node:fs/promises";
import { normalizeAbi, sortAbis, type Abi } from "./abi.js";
import { CliError } from "./errors.js";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;

export interface ApkScan {
  /** Native ABIs found under `lib/<abi>/` inside the APK, priority-sorted. */
  abis: Abi[];
  hasNativeLibs: boolean;
  centralDirectoryEntries: number;
  /** True when the archive needs ZIP64; callers fall back to the filename. */
  zip64: boolean;
}

function invalidApk(filePath: string, detail?: string): CliError {
  return new CliError(
    `"${filePath}" is not a readable APK/ZIP archive${detail ? ` (${detail})` : ""}.`,
    "Pass a real .apk file, or an explicit --abi with a file the CLI cannot inspect.",
  );
}

/**
 * Reads an APK's ZIP central directory and collects the ABIs of its native
 * libraries. This is deliberately dependency-free: central-directory entry
 * names are plain text, so no decompression is needed.
 */
export async function scanApk(filePath: string): Promise<ApkScan> {
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw invalidApk(filePath, "not a file");
    if (info.size < EOCD_MIN_SIZE) throw invalidApk(filePath, "too small");

    const tailSize = Math.min(info.size, EOCD_MIN_SIZE + MAX_COMMENT_SIZE);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, info.size - tailSize);

    let eocdOffset = -1;
    for (let offset = tail.length - EOCD_MIN_SIZE; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
      const commentLength = tail.readUInt16LE(offset + 20);
      if (offset + EOCD_MIN_SIZE + commentLength <= tail.length) {
        eocdOffset = offset;
        break;
      }
    }
    if (eocdOffset < 0) throw invalidApk(filePath, "no end-of-central-directory record");

    const entryCount = tail.readUInt16LE(eocdOffset + 10);
    const centralDirectorySize = tail.readUInt32LE(eocdOffset + 12);
    const centralDirectoryOffset = tail.readUInt32LE(eocdOffset + 16);

    if (
      entryCount === 0xffff ||
      centralDirectorySize === 0xffffffff ||
      centralDirectoryOffset === 0xffffffff
    ) {
      return {
        abis: [],
        hasNativeLibs: false,
        centralDirectoryEntries: entryCount,
        zip64: true,
      };
    }
    if (centralDirectorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
      throw invalidApk(filePath, "central directory is implausibly large");
    }
    if (centralDirectoryOffset + centralDirectorySize > info.size) {
      throw invalidApk(filePath, "central directory is out of bounds");
    }

    const centralDirectory = Buffer.alloc(centralDirectorySize);
    if (centralDirectorySize > 0) {
      await handle.read(
        centralDirectory,
        0,
        centralDirectorySize,
        centralDirectoryOffset,
      );
    }

    const abis = new Set<Abi>();
    let hasNativeLibs = false;
    let parsed = 0;
    let offset = 0;

    while (offset + 46 <= centralDirectory.length) {
      if (centralDirectory.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) break;
      const nameLength = centralDirectory.readUInt16LE(offset + 28);
      const extraLength = centralDirectory.readUInt16LE(offset + 30);
      const commentLength = centralDirectory.readUInt16LE(offset + 32);
      const nameStart = offset + 46;
      const nameEnd = nameStart + nameLength;
      if (nameEnd > centralDirectory.length) break;

      const name = centralDirectory.toString("utf8", nameStart, nameEnd);
      if (name.startsWith("lib/")) {
        hasNativeLibs = true;
        const abi = name.split("/")[1];
        if (abi) {
          const normalized = normalizeAbi(abi);
          if (normalized) abis.add(normalized);
        }
      }

      parsed += 1;
      offset = nameEnd + extraLength + commentLength;
    }

    return {
      abis: sortAbis(abis),
      hasNativeLibs,
      centralDirectoryEntries: parsed,
      zip64: false,
    };
  } finally {
    await handle.close();
  }
}
