import { open } from "node:fs/promises";
import type { Abi } from "./abi.js";
import {
  ApkInspectionError,
  collectAbis,
  fileByteSource,
  inspectSource,
  readCentralDirectory,
  type ApkMetadata,
} from "./apk-manifest.js";
import { CliError } from "./errors.js";

export interface ApkScan {
  /** Native ABIs found under `lib/<abi>/` inside the APK, priority-sorted. */
  abis: Abi[];
  hasNativeLibs: boolean;
  centralDirectoryEntries: number;
  /** True when the archive needs ZIP64; callers fall back to the filename. */
  zip64: boolean;
  /** Parsed binary manifest, or `null` when it could not be read. */
  metadata: ApkMetadata | null;
  /** Why `metadata` is null; `null` when the manifest was readable. */
  metadataError: string | null;
}

function invalidApk(filePath: string, detail?: string): CliError {
  return new CliError(
    `"${filePath}" is not a readable APK/ZIP archive${detail ? ` (${detail})` : ""}.`,
    "Pass a real .apk file, or an explicit --abi with a file the CLI cannot inspect.",
  );
}

function inspectionDetail(error: ApkInspectionError): string {
  return error.message;
}

/**
 * Reads an APK's ZIP central directory and binary AndroidManifest.xml. The
 * scan stays useful when the manifest cannot be parsed (for example a ZIP64
 * archive): `abis` is still filled and `metadataError` explains the fallback.
 */
export async function scanApk(filePath: string): Promise<ApkScan> {
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw invalidApk(filePath, "not a file");
    if (info.size < 22) throw invalidApk(filePath, "too small");

    const source = fileByteSource(handle, info.size);

    let entries;
    try {
      entries = await readCentralDirectory(source);
    } catch (error) {
      if (error instanceof ApkInspectionError) {
        if (error.code === "zip64") {
          return {
            abis: [],
            hasNativeLibs: false,
            centralDirectoryEntries: 0xffff,
            zip64: true,
            metadata: null,
            metadataError: inspectionDetail(error),
          };
        }
        throw invalidApk(filePath, inspectionDetail(error));
      }
      throw error;
    }

    const abis = collectAbis(entries);
    const hasNativeLibs = entries.some((entry) => entry.name.startsWith("lib/"));

    let metadata: ApkMetadata | null = null;
    let metadataError: string | null = null;
    try {
      const { artifactAbi: _artifactAbi, ...parsed } = await inspectSource(source);
      metadata = parsed;
    } catch (error) {
      if (error instanceof ApkInspectionError) {
        metadataError = error.message;
      } else {
        throw error;
      }
    }

    return {
      abis,
      hasNativeLibs,
      centralDirectoryEntries: entries.length,
      zip64: false,
      metadata,
      metadataError,
    };
  } finally {
    await handle.close();
  }
}
