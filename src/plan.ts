import { stat } from "node:fs/promises";
import path from "node:path";
import { compareAbi, inferAbiFromFilename, normalizeAbi, type Abi } from "./abi.js";
import { artifactAbiOf, type ApkMetadata, type MismatchKind } from "./apk-manifest.js";
import { scanApk } from "./apk.js";
import type { VersionAdmin } from "./api.js";
import { CliError, UsageError } from "./errors.js";
import {
  isValidVersionName,
  parsePositiveInteger,
  VERSION_NAME_RULE,
} from "./validate.js";

export interface AppMetadataInput {
  name?: string;
  packageName?: string;
  description?: string;
  developer?: string;
}

export interface ReleaseInput {
  appId: string;
  /** When omitted, the first APK's `versionName` is used. */
  versionName?: string;
  /** When omitted, the first APK's `versionCode` is used. */
  versionCodeRaw?: string;
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
  /** Parsed manifest, or `null` when it could not be read. */
  metadata: ApkMetadata | null;
  metadataError: string | null;
  /** ABI implied by the manifest (ignores an explicit --abi override). */
  artifactAbi: Abi;
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
  versionNameInferred: boolean;
  versionCodeInferred: boolean;
  metadata: ReleaseMetadata;
  artifacts: PlannedArtifact[];
  createApp: boolean;
  force: boolean;
  dryRun: boolean;
  appMetadata: AppMetadataInput;
  /** Values the APK itself declared, for `--json` and diagnostics. */
  detected: { versionName: string | null; versionCode: number | null } | null;
  /** Categories the server may verify strictly but the user overrode. */
  allowMismatch: MismatchKind[];
  warnings: string[];
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

export interface AbiDetection {
  abi: Abi;
  source: AbiSource;
  detectedAbis: Abi[];
  artifactAbi: Abi;
  metadata: ApkMetadata | null;
  metadataError: string | null;
}

/**
 * Picks the ABI an APK should be published as. Explicit flags win, then the
 * APK's manifest + `lib/<abi>/` entries (zero or several ABIs ⇒ universal).
 * The filename is only a fallback when the manifest cannot be read, because
 * the server cannot verify such an upload and will reject it.
 */
export async function detectArtifactAbi(
  filePath: string,
  explicit: Abi | undefined,
): Promise<AbiDetection> {
  const scan = await scanApk(filePath);
  const metadata = scan.metadata;
  const detectedAbi: Abi = metadata ? artifactAbiOf(metadata) : "universal";

  if (explicit) {
    return {
      abi: explicit,
      source: "flag",
      detectedAbis: scan.abis,
      artifactAbi: detectedAbi,
      metadata,
      metadataError: scan.metadataError,
    };
  }
  if (metadata) {
    return {
      abi: artifactAbiOf(metadata),
      source: "contents",
      detectedAbis: scan.abis,
      artifactAbi: artifactAbiOf(metadata),
      metadata,
      metadataError: null,
    };
  }

  const fromName = inferAbiFromFilename(path.basename(filePath));
  if (fromName) {
    return {
      abi: fromName,
      source: "filename",
      detectedAbis: scan.abis,
      artifactAbi: fromName,
      metadata: null,
      metadataError: scan.metadataError,
    };
  }
  return {
    abi: "universal",
    source: "default",
    detectedAbis: scan.abis,
    artifactAbi: "universal",
    metadata: null,
    metadataError: scan.metadataError,
  };
}

function compareField(
  label: string,
  first: string | number,
  other: string | number,
  files: [string, string],
): string | null {
  return first === other
    ? null
    : `${label} "${String(first)}" (${files[0]}) != "${String(other)}" (${files[1]})`;
}

/** Every readable APK must describe the same package and version. */
function checkConsistency(artifacts: readonly PlannedArtifact[]): void {
  const readable = artifacts.filter(
    (artifact): artifact is PlannedArtifact & { metadata: ApkMetadata } =>
      artifact.metadata !== null,
  );
  if (readable.length < 2) return;
  const first = readable[0]!;
  const problems: string[] = [];

  for (const artifact of readable.slice(1)) {
    const fields: Array<[string, string | number, string | number]> = [
      ["packageName", first.metadata.packageName, artifact.metadata.packageName],
      ["versionCode", first.metadata.versionCode, artifact.metadata.versionCode],
    ];
    if (first.metadata.versionName !== null && artifact.metadata.versionName !== null) {
      fields.push(["versionName", first.metadata.versionName, artifact.metadata.versionName]);
    }
    for (const [label, left, right] of fields) {
      const problem = compareField(label, left, right, [first.fileName, artifact.fileName]);
      if (problem) problems.push(problem);
    }
  }

  if (problems.length > 0) {
    throw new UsageError(
      "The APKs describe different app versions.",
      `Publish one version at a time: ${problems.join("; ")}.`,
    );
  }
}

function explicitAbiList(input: ReleaseInput): Abi[] {
  if (input.abiFlags.length === 0) return [];
  if (input.abiFlags.length !== 1 && input.abiFlags.length !== input.apkPaths.length) {
    throw new UsageError(
      `Got ${input.abiFlags.length} --abi values for ${input.apkPaths.length} APKs.`,
      "Pass one --abi per APK, or omit --abi to detect it from each file.",
    );
  }
  if (input.abiFlags.length === 1 && input.apkPaths.length === 1) {
    return [resolveExplicitAbi(input.abiFlags[0]!, input.apkPaths[0]!)];
  }
  return input.abiFlags.map((raw, index) =>
    resolveExplicitAbi(raw, input.apkPaths[index] ?? `APK #${index + 1}`),
  );
}

async function planArtifacts(
  input: ReleaseInput,
  explicitAbis: readonly Abi[],
): Promise<{ artifacts: PlannedArtifact[]; warnings: string[] }> {
  const artifacts: PlannedArtifact[] = [];
  const warnings: string[] = [];

  for (const [index, rawPath] of input.apkPaths.entries()) {
    const filePath = path.resolve(rawPath);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) {
      throw new CliError(`APK not found: ${rawPath}`);
    }
    if (info.size === 0) {
      throw new CliError(`APK is empty: ${rawPath}`);
    }

    const detected = await detectArtifactAbi(filePath, explicitAbis[index]);
    if (!detected.metadata) {
      warnings.push(
        `Cannot read AndroidManifest.xml in "${path.basename(filePath)}" (${detected.metadataError ?? "unknown error"}); using the filename for its ABI. The server may reject this upload.`,
      );
    }
    artifacts.push({
      path: filePath,
      fileName: path.basename(filePath),
      sizeBytes: info.size,
      abi: detected.abi,
      source: detected.source,
      detectedAbis: detected.detectedAbis,
      metadata: detected.metadata,
      metadataError: detected.metadataError,
      artifactAbi: detected.artifactAbi,
    });
  }

  return { artifacts, warnings };
}

function rejectDuplicateAbis(artifacts: readonly PlannedArtifact[]): void {
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
}

function collectAllowMismatch(
  input: ReleaseInput,
  artifacts: readonly PlannedArtifact[],
  detected: ApkMetadata | null,
  versionCode: number,
  minSdk: number | undefined,
): MismatchKind[] {
  const kinds = new Set<MismatchKind>();

  if (
    input.versionName !== undefined &&
    detected?.versionName !== null &&
    detected !== null &&
    input.versionName !== detected.versionName
  ) {
    kinds.add("version");
  }
  if (
    input.versionCodeRaw !== undefined &&
    detected !== null &&
    versionCode !== detected.versionCode
  ) {
    kinds.add("version");
  }
  if (
    minSdk !== undefined &&
    detected?.minSdk != null &&
    minSdk !== detected.minSdk
  ) {
    kinds.add("sdk");
  }
  for (const artifact of artifacts) {
    if (
      artifact.source === "flag" &&
      artifact.metadata !== null &&
      artifact.abi !== artifact.artifactAbi
    ) {
      kinds.add("abi");
    }
  }

  return [...kinds];
}

export async function buildReleasePlan(input: ReleaseInput): Promise<ReleasePlan> {
  const minSdk =
    input.minSdkRaw === undefined
      ? undefined
      : parseInteger(input.minSdkRaw, "--min-sdk");

  if (input.apkPaths.length === 0) {
    throw new UsageError(
      "At least one APK is required.",
      "Usage: testflight release <appId> <apk...> [--version <name>] [--version-code <n>]",
    );
  }

  const explicitAbis = explicitAbiList(input);
  const { artifacts, warnings } = await planArtifacts(input, explicitAbis);

  rejectDuplicateAbis(artifacts);
  checkConsistency(artifacts);
  artifacts.sort((left, right) => compareAbi(left.abi, right.abi));

  const firstMetadata = artifacts.find((artifact) => artifact.metadata)?.metadata ?? null;
  const detectedVersionName = firstMetadata?.versionName ?? null;
  const detectedVersionCode = firstMetadata?.versionCode ?? null;

  const versionCodeRaw =
    input.versionCodeRaw ?? (detectedVersionCode !== null ? String(detectedVersionCode) : undefined);
  if (versionCodeRaw === undefined) {
    throw new UsageError(
      "Cannot infer --version-code from the APK.",
      "Pass --version-code <n> explicitly.",
    );
  }
  const versionCode = parseInteger(versionCodeRaw, "--version-code");

  // The artifact routes need a name. When the manifest uses a resource
  // reference (or is unreadable), fall back to the numeric versionCode.
  const versionName =
    input.versionName ?? detectedVersionName ?? String(versionCode);
  if (!isValidVersionName(versionName)) {
    const source = input.versionName !== undefined ? "--version" : "the APK";
    throw new UsageError(
      `Invalid version name "${versionName}" from ${source}.`,
      VERSION_NAME_RULE,
    );
  }
  const versionNameInferred = input.versionName === undefined;
  const versionCodeInferred = input.versionCodeRaw === undefined;

  const allowMismatch = collectAllowMismatch(
    input,
    artifacts,
    firstMetadata,
    versionCode,
    minSdk,
  );

  let publishedAt: string | undefined;
  if (input.publishedAt !== undefined) {
    const date = new Date(input.publishedAt);
    if (Number.isNaN(date.getTime())) {
      throw new UsageError(`Invalid publishedAt "${input.publishedAt}"; expected an ISO date.`);
    }
    publishedAt = date.toISOString();
  }

  const metadata: ReleaseMetadata = {
    versionName,
    versionCode,
    ...(minSdk !== undefined ? { minSdk } : {}),
    ...(input.releaseNotes !== undefined ? { releaseNotes: input.releaseNotes } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
  };

  return {
    appId: input.appId,
    versionName,
    versionCode,
    versionNameInferred,
    versionCodeInferred,
    metadata,
    artifacts,
    createApp: input.createApp,
    force: input.force,
    dryRun: input.dryRun,
    appMetadata: input.appMetadata,
    detected:
      detectedVersionName !== null || detectedVersionCode !== null
        ? { versionName: detectedVersionName, versionCode: detectedVersionCode }
        : null,
    allowMismatch,
    warnings,
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
