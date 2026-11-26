import {
  booleanValue,
  expandCsv,
  listValue,
  parseCommandArgs,
  readGlobals,
  stringValue,
  withGlobals,
} from "../args.js";
import { CliError, UsageError } from "../errors.js";
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
import { confirm, isInteractive } from "../prompt.js";
import type { AppDetail, UploadResult, VersionAdmin } from "../api.js";
import {
  buildReleasePlan,
  conflictingAbis,
  metadataDifferences,
  type PlannedArtifact,
  type ReleasePlan,
} from "../plan.js";
import {
  absoluteDownloadUrl,
  createClient,
  parseOptionalMinSdk,
  parsePublishedAt,
  requireId,
  resolveReleaseNotes,
  type CommandClient,
} from "./common.js";

function describeSource(artifact: PlannedArtifact): string {
  switch (artifact.source) {
    case "flag":
      return "--abi";
    case "contents":
      return artifact.detectedAbis.length > 1
        ? `universal (has ${artifact.detectedAbis.join(", ")})`
        : "lib/ in APK";
    case "filename":
      return "filename";
    case "default":
      return "default (no native libs)";
  }
}

function printPlan(
  plan: ReleasePlan,
  client: CommandClient & { app: AppDetail | null; version: VersionAdmin | null },
  differences: string[],
  conflicts: string[],
): void {
  heading(`Plan: ${plan.appId} ${plan.versionName} (${plan.versionCode})`);
  line();

  const appState = client.app
    ? `exists — ${client.app.name}`
    : plan.createApp
      ? "will be created"
      : "missing (pass --create to create it)";
  line(`  App:      ${appState}`);
  line(`  Version:  ${client.version ? "exists" : "will be created"}`);
  if (differences.length > 0) {
    line(`  Metadata: ${differences.join("; ")}`);
  }
  if (conflicts.length > 0) {
    line(`  Existing: artifacts ${conflicts.join(", ")} would be replaced`);
  }
  line();

  printTable(
    ["ACTION", "ABI", "APK", "SIZE", "DETECTED BY"],
    plan.artifacts.map((artifact) => [
      client.version && conflicts.includes(artifact.abi) ? "replace" : "upload",
      artifact.abi,
      artifact.fileName,
      formatBytes(artifact.sizeBytes),
      describeSource(artifact),
    ]),
    ["left", "left", "left", "right", "left"],
  );
}

export async function runRelease(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(
    argv,
    withGlobals({
      version: { type: "string" },
      "version-code": { type: "string" },
      abi: { type: "string", multiple: true },
      "min-sdk": { type: "string" },
      "release-notes": { type: "string" },
      "notes-file": { type: "string" },
      "published-at": { type: "string" },
      create: { type: "boolean" },
      name: { type: "string" },
      package: { type: "string" },
      description: { type: "string" },
      developer: { type: "string" },
      force: { type: "boolean", short: "f" },
      yes: { type: "boolean", short: "y" },
      "dry-run": { type: "boolean", short: "n" },
      universal: { type: "boolean" },
      "no-progress": { type: "boolean" },
    }),
  );
  const globals = readGlobals(values);
  configureOutput({ json: globals.json, color: globals.noColor ? false : undefined });
  if (globals.help) {
    printHelp("release");
    return 0;
  }

  const appId = requireId(
    positionals[0],
    "app id",
    "testflight release <appId> <apk...> --version <name> --version-code <n>",
  );
  const apkPaths = positionals.slice(1);
  if (apkPaths.length === 0) {
    throw new UsageError(
      "At least one APK is required.",
      "Usage: testflight release <appId> <apk...> --version <name> --version-code <n>",
    );
  }

  const versionName = requireId(
    stringValue(values, "version"),
    "version name",
    "testflight release <appId> <apk...> --version <name> --version-code <n>",
  );
  const versionCodeRaw = stringValue(values, "version-code");
  if (versionCodeRaw === undefined) {
    throw new UsageError(
      "Missing --version-code.",
      "Every version needs a positive integer versionCode.",
    );
  }

  let abiFlags = expandCsv(listValue(values, "abi"));
  const universal = booleanValue(values, "universal");
  if (universal) {
    if (abiFlags.length > 0) {
      throw new UsageError("Use either --universal or --abi, not both.");
    }
    if (apkPaths.length > 1) {
      throw new UsageError(
        "--universal accepts exactly one APK.",
        "Omit --universal to upload one APK per ABI, or pass --abi for each file.",
      );
    }
    abiFlags = ["universal"];
  }

  const releaseNotes = await resolveReleaseNotes(
    stringValue(values, "release-notes"),
    stringValue(values, "notes-file"),
  );
  const publishedAt = parsePublishedAt(stringValue(values, "published-at"));
  const minSdkRaw = stringValue(values, "min-sdk");
  if (minSdkRaw !== undefined) parseOptionalMinSdk(minSdkRaw);

  const dryRun = booleanValue(values, "dry-run");
  const plan = await buildReleasePlan({
    appId,
    versionName,
    versionCodeRaw,
    minSdkRaw,
    releaseNotes,
    publishedAt,
    apkPaths,
    abiFlags,
    createApp: booleanValue(values, "create"),
    force: booleanValue(values, "force"),
    dryRun,
    appMetadata: {
      name: stringValue(values, "name"),
      packageName: stringValue(values, "package"),
      description: stringValue(values, "description"),
      developer: stringValue(values, "developer"),
    },
  });

  const { api, settings } = await createClient(globals, { requireKey: !dryRun });

  const existingApp = await api.findApp(appId);
  const existingVersions = existingApp ? await api.listVersionsAdmin(appId) : [];
  const existingVersion =
    existingVersions.find((version) => version.versionName === versionName) ?? null;

  const differences = existingVersion
    ? metadataDifferences(existingVersion, plan.metadata)
    : [];
  const conflicts = existingVersion
    ? conflictingAbis(existingVersion, plan.artifacts)
    : [];

  const clientInfo = {
    api,
    settings,
    app: existingApp,
    version: existingVersion,
  };

  if (dryRun) {
    if (globals.json) {
      printJson({
        dryRun: true,
        appId,
        versionName,
        versionCode: plan.versionCode,
        appExists: existingApp !== null,
        versionExists: existingVersion !== null,
        wouldCreateApp: existingApp === null && plan.createApp,
        metadataDifferences: differences,
        conflictingArtifacts: conflicts,
        artifacts: plan.artifacts.map((artifact) => ({
          path: artifact.path,
          fileName: artifact.fileName,
          sizeBytes: artifact.sizeBytes,
          abi: artifact.abi,
          detectedBy: artifact.source,
        })),
        needsForce: differences.length > 0 || conflicts.length > 0,
      });
      return 0;
    }
    printPlan(plan, clientInfo, differences, conflicts);
    if (!existingApp && !plan.createApp) {
      warn("The app does not exist; add --create to create it during the release.");
    }
    if (differences.length > 0 || conflicts.length > 0) {
      warn("Re-running this release without --force would be refused.");
    }
    info("Dry run: no changes were sent to the server.");
    return 0;
  }

  if (!existingApp && !plan.createApp) {
    throw new CliError(
      `App "${appId}" does not exist.`,
      `Create it with \`testflight apps create ${appId}\`, or add --create to this release.`,
    );
  }

  let force = plan.force;
  if (existingVersion && (differences.length > 0 || conflicts.length > 0)) {
    const summary = [
      ...differences,
      ...(conflicts.length > 0 ? [`replace ${conflicts.join(", ")}`] : []),
    ].join("; ");

    if (!force && booleanValue(values, "yes")) {
      force = true;
    } else if (!force) {
      if (isInteractive() && !globals.json) {
        const accepted = await confirm(
          `Version "${versionName}" already exists (${summary}). Replace it?`,
          false,
        );
        if (!accepted) throw new CliError("Cancelled.");
        force = true;
      } else {
        throw new CliError(
          `Version "${versionName}" already exists (${summary}).`,
          "Re-run with --force to replace it, or publish a different --version.",
        );
      }
    }
  }

  let createdApp = false;
  let createdVersion = false;
  let updatedVersion = false;

  let app = existingApp;
  if (!app) {
    app = await api.createApp({
      id: appId,
      name: plan.appMetadata.name,
      packageName: plan.appMetadata.packageName,
      description: plan.appMetadata.description,
      developer: plan.appMetadata.developer,
    });
    createdApp = true;
    if (!globals.json) success(`Created app "${appId}" (${app.name}).`);
  }

  if (!existingVersion) {
    await api.createVersion(appId, plan.metadata);
    createdVersion = true;
    if (!globals.json) success(`Created version ${versionName} (${plan.versionCode}).`);
  } else if (force && differences.length > 0) {
    const { versionName: _ignored, ...patch } = plan.metadata;
    await api.updateVersion(appId, versionName, patch);
    updatedVersion = true;
    if (!globals.json) success(`Updated version metadata (${differences.join("; ")}).`);
  }

  const showProgress = !booleanValue(values, "no-progress") && !globals.json;
  const uploads: UploadResult[] = [];

  try {
    for (const artifact of plan.artifacts) {
      if (!globals.json) {
        line(`Uploading ${artifact.fileName} → ${artifact.abi} (${formatBytes(artifact.sizeBytes)})`);
      }
      const result = await api.uploadArtifact(
        appId,
        versionName,
        artifact.abi,
        artifact.path,
        {
          onProgress: (uploaded, total) => {
            progress(artifact.abi, uploaded, total, {
              enabled: showProgress,
            });
          },
        },
      );
      progress(artifact.abi, artifact.sizeBytes, artifact.sizeBytes, {
        enabled: showProgress,
        force: true,
      });

      if (!result.verified) {
        throw new CliError(
          `The server's SHA-256 for ${artifact.abi} does not match the local file.`,
          "The upload may have been corrupted. Re-run the release with --force.",
        );
      }

      uploads.push(result);
      if (!globals.json) {
        success(
          `${result.created ? "Uploaded" : "Replaced"} ${artifact.abi} — ${formatBytes(result.sizeBytes)}, sha256 ${shortSha(result.sha256)}`,
        );
      }
    }
  } catch (error) {
    clearProgress();
    if (uploads.length > 0) {
      warn(
        `${uploads.length} artifact(s) were uploaded before the failure; re-run with --force to finish.`,
      );
    }
    throw error;
  }

  const version = await api.getVersionAdmin(appId, versionName);
  const downloadUrl = absoluteDownloadUrl(settings, version.downloadPath);

  if (globals.json) {
    printJson({
      appId,
      app,
      version,
      createdApp,
      createdVersion,
      updatedVersion,
      forced: force,
      uploads: uploads.map((upload) => ({
        abi: upload.abi,
        file: upload.filePath,
        sizeBytes: upload.sizeBytes,
        sha256: upload.sha256,
        serverSha256: upload.serverSha256,
        created: upload.created,
      })),
      downloadUrl,
    });
    return 0;
  }

  line();
  success(`Published ${appId} ${versionName} (${plan.versionCode}).`);
  printTable(
    ["ABI", "SIZE", "SHA-256"],
    version.artifacts.map((artifact) => [
      artifact.abi,
      formatBytes(artifact.sizeBytes),
      shortSha(artifact.sha256),
    ]),
    ["left", "right", "left"],
  );
  if (downloadUrl) {
    note(`Download: ${downloadUrl}`);
  }
  return 0;
}
