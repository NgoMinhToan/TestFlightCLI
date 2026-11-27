import { stat } from "node:fs/promises";
import path from "node:path";
import {
  booleanValue,
  parseCommandArgs,
  readGlobals,
  stringValue,
  withGlobals,
  type ParsedValues,
} from "../args.js";
import { artifactAbiOf, type DetectedApk, type MismatchKind } from "../apk-manifest.js";
import { scanApk } from "../apk.js";
import { CliError, UsageError } from "../errors.js";
import { isValidVersionName, VERSION_NAME_RULE } from "../validate.js";
import { printHelp } from "../help.js";
import {
  clearProgress,
  configureOutput,
  formatBytes,
  heading,
  info,
  line,
  note,
  printJson,
  printTable,
  progress,
  shortSha,
  success,
  warn,
} from "../output.js";
import type { ImportResult } from "../api.js";
import {
  absoluteDownloadUrl,
  createClient,
  mergeAllowMismatch,
  parseAllowMismatch,
  parsePublishedAt,
  parseVersionCode,
  requireId,
  requireVersionName,
  resolveReleaseNotes,
} from "./common.js";

const MAX_RELEASE_NOTES_QUERY_BYTES = 4 * 1024;

interface InspectedFile {
  path: string;
  fileName: string;
  sizeBytes: number;
  detected: DetectedApk;
}

interface PublishIdentity {
  appId: string;
  /** `null` when the APK uses a resource reference and no --version was given. */
  versionName: string | null;
  versionCode: number;
  versionNameSource: "flag" | "apk" | "server";
  versionCodeSource: "flag" | "apk";
  create: boolean;
  allowMismatch: MismatchKind[];
  warnings: string[];
}

async function inspectFile(rawPath: string): Promise<InspectedFile> {
  const filePath = path.resolve(rawPath);
  const infoStat = await stat(filePath).catch(() => null);
  if (!infoStat?.isFile()) throw new CliError(`APK not found: ${rawPath}`);
  if (infoStat.size === 0) throw new CliError(`APK is empty: ${rawPath}`);

  const scan = await scanApk(filePath);
  if (!scan.metadata) {
    throw new CliError(
      `Cannot read AndroidManifest.xml in "${path.basename(filePath)}": ${scan.metadataError ?? "unknown error"}`,
      "`publish` needs the manifest to infer the package and version. Use `release` with explicit flags for archives the CLI cannot inspect.",
    );
  }
  const detected: DetectedApk = {
    ...scan.metadata,
    artifactAbi: artifactAbiOf(scan.metadata),
  };
  if (detected.configSplit) {
    throw new CliError(
      `"${path.basename(filePath)}" is a configuration split (${detected.split ?? "configForSplit"}).`,
      "Publish the base APK and its ABI splits instead; config splits cannot be served on their own.",
    );
  }
  return {
    path: filePath,
    fileName: path.basename(filePath),
    sizeBytes: infoStat.size,
    detected,
  };
}

function checkConsistency(files: readonly InspectedFile[]): void {
  const first = files[0]!;
  const problems: string[] = [];
  for (const file of files.slice(1)) {
    if (file.detected.packageName !== first.detected.packageName) {
      problems.push(
        `packageName "${file.detected.packageName}" (${file.fileName}) != "${first.detected.packageName}" (${first.fileName})`,
      );
    }
    if (file.detected.versionCode !== first.detected.versionCode) {
      problems.push(
        `versionCode ${file.detected.versionCode} (${file.fileName}) != ${first.detected.versionCode} (${first.fileName})`,
      );
    }
    if (
      first.detected.versionName !== null &&
      file.detected.versionName !== null &&
      file.detected.versionName !== first.detected.versionName
    ) {
      problems.push(
        `versionName "${file.detected.versionName}" (${file.fileName}) != "${first.detected.versionName}" (${first.fileName})`,
      );
    }
  }
  if (problems.length > 0) {
    throw new UsageError(
      "The APKs describe different app versions.",
      `Publish one version at a time: ${problems.join("; ")}.`,
    );
  }

  const byAbi = new Map<string, string>();
  for (const file of files) {
    const duplicate = byAbi.get(file.detected.artifactAbi);
    if (duplicate) {
      throw new UsageError(
        `Both "${duplicate}" and "${file.fileName}" resolve to ABI "${file.detected.artifactAbi}".`,
        "A version publishes at most one APK per ABI.",
      );
    }
    byAbi.set(file.detected.artifactAbi, file.fileName);
  }
}

function resolveIdentity(
  values: ParsedValues,
  files: readonly InspectedFile[],
  requested: readonly MismatchKind[],
): PublishIdentity {
  const first = files[0]!;
  const appIdRaw = stringValue(values, "app-id") ?? first.detected.packageName;
  const appId = requireId(appIdRaw, "app id", "testflight publish <apk...> [--app-id <id>]");

  const versionFlag = stringValue(values, "version");
  const versionCodeFlag = stringValue(values, "version-code");
  if (versionFlag !== undefined) {
    requireVersionName(versionFlag, "version name", "testflight publish <apk...>");
  }

  // A null name means "did not resolve a literal": omit the `version` query
  // entirely and let the server resolve it (it falls back to versionCode).
  const versionName = versionFlag ?? first.detected.versionName;
  const versionNameSource: PublishIdentity["versionNameSource"] =
    versionFlag !== undefined ? "flag" : versionName !== null ? "apk" : "server";
  if (versionName !== null && !isValidVersionName(versionName)) {
    throw new UsageError(
      `Invalid version name "${versionName}" from the APK.`,
      VERSION_NAME_RULE,
    );
  }

  const versionCode =
    versionCodeFlag !== undefined
      ? parseVersionCode(versionCodeFlag)
      : first.detected.versionCode;

  const kinds = new Set<MismatchKind>(requested);
  if (
    versionFlag !== undefined &&
    first.detected.versionName !== null &&
    versionFlag !== first.detected.versionName
  ) {
    kinds.add("version");
  }
  if (versionCodeFlag !== undefined && versionCode !== first.detected.versionCode) {
    kinds.add("version");
  }

  const warnings: string[] = [];
  for (const file of files) {
    if (file.detected.debuggable) {
      warnings.push(`"${file.fileName}" is debuggable.`);
    }
    if (file.detected.testOnly) {
      warnings.push(`"${file.fileName}" is testOnly.`);
    }
  }

  return {
    appId,
    versionName,
    versionCode,
    versionNameSource,
    versionCodeSource: versionCodeFlag === undefined ? "apk" : "flag",
    create: booleanValue(values, "create"),
    allowMismatch: mergeAllowMismatch([...kinds]),
    warnings,
  };
}

function printDryRun(identity: PublishIdentity, files: readonly InspectedFile[]): void {
  const versionLabel = identity.versionName ?? "(server resolves)";
  heading(
    `Plan: publish ${files.length} APK(s) to ${identity.appId} ${versionLabel} (${identity.versionCode})`,
  );
  line();
  line(`  App:      ${identity.appId}${identity.create ? " (create if missing)" : ""}`);
  line(
    `  Version:  ${versionLabel} (${identity.versionCode})` +
      ` [name from ${identity.versionNameSource}, code from ${identity.versionCodeSource}]`,
  );
  if (identity.allowMismatch.length > 0) {
    line(`  Allow:    ${identity.allowMismatch.join(", ")}`);
  }
  line();
  printTable(
    ["ABI", "PACKAGE", "VERSION", "CODE", "APK", "SIZE"],
    files.map((file) => [
      file.detected.artifactAbi,
      file.detected.packageName,
      file.detected.versionName ?? "(ref)",
      String(file.detected.versionCode),
      file.fileName,
      formatBytes(file.sizeBytes),
    ]),
    ["left", "left", "left", "right", "left", "right"],
  );
  for (const warning of identity.warnings) warn(warning);
  info("Dry run: no changes were sent to the server.");
}

export async function runPublish(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(
    argv,
    withGlobals({
      "app-id": { type: "string" },
      create: { type: "boolean" },
      name: { type: "string" },
      version: { type: "string" },
      "version-code": { type: "string" },
      "release-notes": { type: "string" },
      "notes-file": { type: "string" },
      "published-at": { type: "string" },
      "allow-mismatch": { type: "string" },
      "dry-run": { type: "boolean", short: "n" },
      "no-progress": { type: "boolean" },
    }),
  );
  const globals = readGlobals(values);
  configureOutput({ json: globals.json, color: globals.noColor ? false : undefined });
  if (globals.help) {
    printHelp("publish");
    return 0;
  }

  if (positionals.length === 0) {
    throw new UsageError(
      "At least one APK is required.",
      "Usage: testflight publish <apk...> [--app-id <id>] [--create]",
    );
  }

  const requestedMismatch = parseAllowMismatch(stringValue(values, "allow-mismatch"));
  const notes = await resolveReleaseNotes(
    stringValue(values, "release-notes"),
    stringValue(values, "notes-file"),
  );
  const publishedAt = parsePublishedAt(stringValue(values, "published-at"));
  const create = booleanValue(values, "create");
  const name = stringValue(values, "name");
  const dryRun = booleanValue(values, "dry-run");

  // Inspect every file up front: publish must not create anything before it
  // knows the whole batch is coherent.
  const files: InspectedFile[] = [];
  for (const rawPath of positionals) files.push(await inspectFile(rawPath));
  checkConsistency(files);
  const identity = resolveIdentity(values, files, requestedMismatch);
  for (const warning of identity.warnings) warn(warning);

  const notesForQuery =
    notes !== undefined && Buffer.byteLength(notes, "utf8") <= MAX_RELEASE_NOTES_QUERY_BYTES
      ? notes
      : undefined;
  const needsNotesFollowUp = notes !== undefined && notesForQuery === undefined;

  if (dryRun) {
    if (globals.json) {
      printJson({
        dryRun: true,
        appId: identity.appId,
        create: identity.create,
        versionName: identity.versionName,
        versionCode: identity.versionCode,
        versionNameSource: identity.versionNameSource,
        versionCodeSource: identity.versionCodeSource,
        allowMismatch: identity.allowMismatch,
        releaseNotesFollowUp: needsNotesFollowUp,
        warnings: identity.warnings,
        files: files.map((file) => {
          const { artifactAbi, ...metadata } = file.detected;
          return {
            path: file.path,
            fileName: file.fileName,
            sizeBytes: file.sizeBytes,
            metadata,
            artifactAbi,
          };
        }),
        imports: [],
      });
      return 0;
    }
    printDryRun(identity, files);
    return 0;
  }

  const { api, settings } = await createClient(globals, { requireKey: true });
  const showProgress = !booleanValue(values, "no-progress") && !globals.json;
  const imports: ImportResult[] = [];
  let notesUpdated = false;

  try {
    for (const file of files) {
      if (!globals.json) {
        line(
          `Importing ${file.fileName} as ${file.detected.artifactAbi} (${formatBytes(file.sizeBytes)})`,
        );
      }
      const result = await api.importApk(
        file.path,
        {
          appId: identity.appId,
          create: create || undefined,
          versionName: identity.versionName ?? undefined,
          versionCode: identity.versionCode,
          name,
          publishedAt,
          releaseNotes: notesForQuery,
          allowMismatch: identity.allowMismatch,
        },
        {
          onProgress: (uploaded, total) => {
            progress(file.detected.artifactAbi, uploaded, total, { enabled: showProgress });
          },
        },
      );
      progress(file.detected.artifactAbi, file.sizeBytes, file.sizeBytes, {
        enabled: showProgress,
        force: true,
      });

      if (!result.verified) {
        throw new CliError(
          `The server's SHA-256 for ${file.fileName} does not match the local file.`,
          "The upload may have been corrupted. Re-run the import.",
        );
      }

      if (needsNotesFollowUp && notes !== undefined) {
        await api.updateVersion(result.app.id, result.version.versionName, {
          releaseNotes: notes,
        });
        notesUpdated = true;
      }

      imports.push(result);
      if (!globals.json) {
        success(
          `${result.createdArtifact ? "Imported" : "Replaced"} ${result.artifact?.abi ?? file.detected.artifactAbi} — ${formatBytes(result.sizeBytes)}, sha256 ${shortSha(result.sha256)}`,
        );
      }
    }
  } catch (error) {
    clearProgress();
    if (imports.length > 0) {
      warn(
        `${imports.length} APK(s) were imported before the failure; re-run \`publish\` to finish (existing artifacts are replaced).`,
      );
    }
    throw error;
  }

  const last = imports.at(-1);
  const version = last?.version ?? null;
  const downloadUrl = version ? absoluteDownloadUrl(settings, version.downloadPath) : null;

  if (globals.json) {
    printJson({
      appId: last?.app.id ?? identity.appId,
      create: identity.create,
      version,
      versionName: version?.versionName ?? identity.versionName,
      versionCode: version?.versionCode ?? identity.versionCode,
      versionNameSource: identity.versionNameSource,
      versionCodeSource: identity.versionCodeSource,
      allowMismatch: identity.allowMismatch,
      releaseNotesUpdated: notesUpdated,
      createdApp: imports.some((entry) => entry.createdApp),
      createdVersion: imports.some((entry) => entry.createdVersion),
      imports: imports.map((entry) => ({
        filePath: entry.filePath,
        abi: entry.artifact?.abi ?? entry.detected?.artifactAbi ?? null,
        sizeBytes: entry.sizeBytes,
        sha256: entry.sha256,
        serverSha256: entry.serverSha256,
        createdArtifact: entry.createdArtifact,
        createdApp: entry.createdApp,
        createdVersion: entry.createdVersion,
        status: entry.status,
        versionName: entry.version.versionName,
        versionCode: entry.version.versionCode,
        detected: entry.detected,
      })),
      downloadUrl,
    });
    return 0;
  }

  line();
  success(
    `Published ${last?.app.id ?? identity.appId} ${version?.versionName ?? identity.versionName} (${version?.versionCode ?? identity.versionCode}).`,
  );
  if (version) {
    printTable(
      ["ABI", "SIZE", "SHA-256"],
      version.artifacts.map((artifact) => [
        artifact.abi,
        formatBytes(artifact.sizeBytes),
        shortSha(artifact.sha256),
      ]),
      ["left", "right", "left"],
    );
  }
  if (downloadUrl) note(`Download: ${downloadUrl}`);
  return 0;
}
