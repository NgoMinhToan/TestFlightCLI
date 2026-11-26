import { stat } from "node:fs/promises";
import path from "node:path";
import { compareAbi, inferAbiFromFilename, normalizeAbi, type Abi } from "./abi.js";
import { scanApk } from "./apk.js";
import type { VersionAdmin } from "./api.js";
import { CliError, UsageError } from "./errors.js";
import { parsePositiveInteger } from "./validate.js";

export interface AppMetadataInput {
  name?: string;
  packageName?: string;
  description?: string;
  developer?: string;
}

export interface ReleaseInput {
  appId: string;
  versionName: string;
  versionCodeRaw: string;
  minSdkRaw?: string;
  releaseNotes?: string;
  publishedAt?: string;
  apkPaths: string[];
  abiFlags: string[];
  createApp: boolean;
  force: boolean;
  dryRun: boolean;
  appMetadata: AppMetadataInput;
}

export type AbiSource = "flag" | "contents" | "filename" | "default";

export interface PlannedArtifact {
  path: string;
  fileName: string;
  sizeBytes: number;
  abi: Abi;
  source: AbiSource;
  detectedAbis: Abi[];
}

export interface ReleaseMetadata {
  versionName: string;
  versionCode: number;
  minSdk?: number | null;
  releaseNotes?: string | null;
  publishedAt?: string | null;
}

export interface ReleasePlan {
  appId: string;
  versionName: string;
  versionCode: number;
  metadata: ReleaseMetadata;
  artifacts: PlannedArtifact[];
  createApp: boolean;
  force: boolean;
  dryRun: boolean;
  appMetadata: AppMetadataInput;
}

function parseInteger(raw: string, label: string): number {
  try {
    return parsePositiveInteger(raw, label);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

function resolveExplicitAbi(raw: string, label: string): Abi {
  const abi = normalizeAbi(raw);
  if (!abi) {
    throw new UsageError(
      `Unknown ABI "${raw}" for ${label}.`,
      "Valid ABIs: universal, arm64-v8a, armeabi-v7a, x86_64, x86, riscv64, armeabi.",
    );
  }
  return abi;
}

/**
 * Picks the ABI an APK should be published as. Explicit flags win, then the
 * native libraries inside the APK, then a token in the filename. Anything with
 * zero or several native ABIs is treated as a universal APK.
 */
export async function detectArtifactAbi(
  filePath: string,
  explicit: Abi | undefined,
): Promise<{ abi: Abi; source: AbiSource; detectedAbis: Abi[] }> {
  const scan = await scanApk(filePath);
  if (explicit) return { abi: explicit, source: "flag", detectedAbis: scan.abis };
  if (scan.abis.length === 1) {
    return { abi: scan.abis[0]!, source: "contents", detectedAbis: scan.abis };
  }
  if (scan.abis.length > 1) {
    return { abi: "universal", source: "contents", detectedAbis: scan.abis };
  }

  const fromName = inferAbiFromFilename(path.basename(filePath));
  if (fromName) return { abi: fromName, source: "filename", detectedAbis: [] };
  return { abi: "universal", source: "default", detectedAbis: [] };
}

export async function buildReleasePlan(input: ReleaseInput): Promise<ReleasePlan> {
  const versionCode = parseInteger(input.versionCodeRaw, "--version-code");
  const minSdk =
    input.minSdkRaw === undefined
      ? undefined
      : parseInteger(input.minSdkRaw, "--min-sdk");

  if (input.apkPaths.length === 0) {
    throw new UsageError(
      "At least one APK is required.",
      "Usage: testflight release <appId> <apk...> --version <name> --version-code <n>",
    );
  }

  if (input.abiFlags.length !== 0 && input.abiFlags.length !== 1) {
    if (input.abiFlags.length !== input.apkPaths.length) {
      throw new UsageError(
        `Got ${input.abiFlags.length} --abi values for ${input.apkPaths.length} APKs.`,
        "Pass one --abi per APK, or omit --abi to detect it from each file.",
      );
    }
  }

  const explicitAbis =
    input.abiFlags.length === 1 && input.apkPaths.length === 1
      ? [resolveExplicitAbi(input.abiFlags[0]!, input.apkPaths[0]!)]
      : input.abiFlags.map((raw, index) =>
          resolveExplicitAbi(raw, input.apkPaths[index] ?? `APK #${index + 1}`),
        );

  const artifacts: PlannedArtifact[] = [];

  for (const [index, rawPath] of input.apkPaths.entries()) {
    const filePath = path.resolve(rawPath);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) {
      throw new CliError(`APK not found: ${rawPath}`);
    }
    if (info.size === 0) {
      throw new CliError(`APK is empty: ${rawPath}`);
    }

    const explicit = explicitAbis[index];
    const detected = await detectArtifactAbi(filePath, explicit);
    artifacts.push({
      path: filePath,
      fileName: path.basename(filePath),
      sizeBytes: info.size,
      abi: detected.abi,
      source: detected.source,
      detectedAbis: detected.detectedAbis,
    });
  }

  const seen = new Map<Abi, PlannedArtifact>();
  for (const artifact of artifacts) {
    const duplicate = seen.get(artifact.abi);
    if (duplicate) {
      throw new UsageError(
        `Both "${duplicate.fileName}" and "${artifact.fileName}" resolve to ABI "${artifact.abi}".`,
        "A version publishes at most one APK per ABI. Pass explicit --abi values to disambiguate.",
      );
    }
    seen.set(artifact.abi, artifact);
  }

  artifacts.sort((left, right) => compareAbi(left.abi, right.abi));

  let publishedAt: string | undefined;
  if (input.publishedAt !== undefined) {
    const date = new Date(input.publishedAt);
    if (Number.isNaN(date.getTime())) {
      throw new UsageError(`Invalid publishedAt "${input.publishedAt}"; expected an ISO date.`);
    }
    publishedAt = date.toISOString();
  }

  const metadata: ReleaseMetadata = {
    versionName: input.versionName,
    versionCode,
    ...(minSdk !== undefined ? { minSdk } : {}),
    ...(input.releaseNotes !== undefined ? { releaseNotes: input.releaseNotes } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
  };

  return {
    appId: input.appId,
    versionName: input.versionName,
    versionCode,
    metadata,
    artifacts,
    createApp: input.createApp,
    force: input.force,
    dryRun: input.dryRun,
    appMetadata: input.appMetadata,
  };
}

/** Human-readable metadata differences between a stored version and a plan. */
export function metadataDifferences(
  existing: VersionAdmin,
  metadata: ReleaseMetadata,
): string[] {
  const differences: string[] = [];

  if (existing.versionCode !== metadata.versionCode) {
    differences.push(`versionCode ${existing.versionCode} → ${metadata.versionCode}`);
  }
  if (metadata.minSdk !== undefined && existing.minSdk !== metadata.minSdk) {
    differences.push(`minSdk ${existing.minSdk ?? "-"} → ${metadata.minSdk ?? "-"}`);
  }
  if (
    metadata.releaseNotes !== undefined &&
    (existing.releaseNotes ?? "") !== (metadata.releaseNotes ?? "")
  ) {
    differences.push("release notes change");
  }
  if (metadata.publishedAt !== undefined && metadata.publishedAt !== null) {
    const existingTime = new Date(existing.publishedAt).getTime();
    const nextTime = new Date(metadata.publishedAt).getTime();
    if (existingTime !== nextTime) {
      differences.push(`publishedAt ${existing.publishedAt} → ${metadata.publishedAt}`);
    }
  }

  return differences;
}

export function conflictingAbis(
  existing: VersionAdmin,
  artifacts: PlannedArtifact[],
): Abi[] {
  const published = new Set(existing.artifacts.map((artifact) => artifact.abi));
  return artifacts.map((artifact) => artifact.abi).filter((abi) => published.has(abi));
}
