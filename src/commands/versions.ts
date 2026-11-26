import {
  booleanValue,
  parseCommandArgs,
  readGlobals,
  stringValue,
  withGlobals,
} from "../args.js";
import type { ResolvedSettings } from "../config.js";
import type { TestflightApi, VersionAdmin, VersionSummary } from "../api.js";
import { UsageError } from "../errors.js";
import { printHelp } from "../help.js";
import {
  configureOutput,
  formatBytes,
  formatDate,
  heading,
  info,
  line,
  note,
  printJson,
  printTable,
  shortSha,
  success,
} from "../output.js";
import {
  absoluteDownloadUrl,
  confirmDestructive,
  createClient,
  formatAbiList,
  parseOptionalMinSdk,
  parsePublishedAt,
  parseVersionCode,
  requireId,
  resolveReleaseNotes,
} from "./common.js";

type VersionAction = "list" | "get" | "abis" | "create" | "update" | "delete";

const ACTIONS: Record<string, VersionAction> = {
  list: "list",
  get: "get",
  show: "get",
  abis: "abis",
  create: "create",
  update: "update",
  edit: "update",
  delete: "delete",
  rm: "delete",
};

function describeNotes(notes: string | null): void {
  if (!notes) return;
  line();
  heading("Release notes:");
  for (const row of notes.split(/\r?\n/)) line(`  ${row}`);
}

function describeVersion(
  appId: string,
  version: VersionAdmin,
  settings: ResolvedSettings,
  json: boolean,
): void {
  if (json) {
    printJson({
      appId,
      version,
      downloadUrl: absoluteDownloadUrl(settings, version.downloadPath),
    });
    return;
  }

  heading(`${version.versionName}  (${appId})`);
  line(`  Code:       ${version.versionCode}`);
  line(`  Min SDK:    ${version.minSdk ?? "-"}`);
  line(`  Published:  ${formatDate(version.publishedAt)}`);
  line(`  State:      ${version.draft ? "draft (no APK yet)" : "published"}`);
  line(`  Universal:  ${version.universal ? "yes" : "no"}`);
  describeNotes(version.releaseNotes);
  line();

  if (version.artifacts.length === 0) {
    info("Draft: no APK has been uploaded yet.");
    return;
  }

  const defaultAbi = version.defaultArtifact?.abi ?? null;
  printTable(
    ["ABI", "SIZE", "SHA-256", "FILE", "DEFAULT"],
    version.artifacts.map((artifact) => [
      artifact.abi,
      formatBytes(artifact.sizeBytes),
      shortSha(artifact.sha256),
      artifact.filename,
      artifact.abi === defaultAbi ? "*" : "",
    ]),
    ["left", "right", "left", "left", "left"],
  );

  const downloadUrl = absoluteDownloadUrl(settings, version.downloadPath);
  if (downloadUrl) {
    line();
    note(`Download: ${downloadUrl}`);
  }
}

function sortVersions<T extends { versionCode: number; versionName: string }>(
  versions: T[],
): T[] {
  return [...versions].sort(
    (left, right) =>
      right.versionCode - left.versionCode ||
      right.versionName.localeCompare(left.versionName, undefined, { numeric: true }),
  );
}

async function listVersions(rest: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(
    rest,
    withGlobals({ published: { type: "boolean" } }),
  );
  const globals = readGlobals(values);
  configureOutput({ json: globals.json, color: globals.noColor ? false : undefined });
  if (globals.help) {
    printHelp(positionals.length === 2 ? "versions get" : "versions list");
    return 0;
  }

  if (positionals.length === 0) {
    throw new UsageError(
      "Missing app id.",
      "Usage: testflight versions [list] <appId> [<versionName>]",
    );
  }
  if (positionals.length > 2) {
    throw new UsageError(
      "Too many arguments.",
      "Usage: testflight versions [list] <appId> [<versionName>]",
    );
  }

  const appId = requireId(positionals[0], "app id", "testflight versions list <appId>");
  const { api, settings } = await createClient(globals, { requireKey: false });

  if (positionals.length === 2) {
    const versionName = requireId(
      positionals[1],
      "version name",
      "testflight versions get <appId> <versionName>",
    );
    const version = await api.getVersionAdmin(appId, versionName);
    describeVersion(appId, version, settings, globals.json);
    return 0;
  }

  const publishedOnly = booleanValue(values, "published");
  if (publishedOnly) {
    const app = await api.getApp(appId);
    const versions = sortVersions(app.versions);
    if (globals.json) {
      printJson({ appId, publishedOnly: true, versions });
      return 0;
    }
    if (versions.length === 0) {
      info(`No published versions for "${appId}".`);
      return 0;
    }
    printVersionTable(versions.map((version) => [version, false] as const));
    return 0;
  }

  const versions = sortVersions(await api.listVersionsAdmin(appId));
  if (globals.json) {
    printJson({ appId, publishedOnly: false, versions });
    return 0;
  }
  if (versions.length === 0) {
    info(`No versions for "${appId}" yet. Publish one with \`testflight release\`.`);
    return 0;
  }
  printVersionTable(versions.map((version) => [version, version.draft] as const));
  return 0;
}

function printVersionTable(versions: Array<readonly [VersionSummary | VersionAdmin, boolean]>): void {
  printTable(
    ["VERSION", "CODE", "MIN SDK", "SIZE", "ABIS", "PUBLISHED", "STATE"],
    versions.map(([version, draft]) => [
      version.versionName,
      String(version.versionCode),
      version.minSdk === null ? "-" : String(version.minSdk),
      formatBytes(version.sizeBytes),
      formatAbiList(version.abis),
      formatDate(version.publishedAt),
      draft ? "draft" : "published",
    ]),
    ["left", "right", "right", "right", "left", "left", "left"],
  );
}

async function getVersion(rest: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(rest, withGlobals());
  const globals = readGlobals(values);
  configureOutput({ json: globals.json, color: globals.noColor ? false : undefined });
  if (globals.help) {
    printHelp("versions get");
    return 0;
  }

  const appId = requireId(
    positionals[0],
    "app id",
    "testflight versions get <appId> <versionName>",
  );
  const versionName = requireId(
    positionals[1],
    "version name",
    "testflight versions get <appId> <versionName>",
  );

  const { api, settings } = await createClient(globals, { requireKey: false });
  const version = await api.getVersionAdmin(appId, versionName);
  describeVersion(appId, version, settings, globals.json);
  return 0;
}

async function listAbis(rest: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(rest, withGlobals());
  const globals = readGlobals(values);
  configureOutput({ json: globals.json, color: globals.noColor ? false : undefined });
  if (globals.help) {
    printHelp("versions abis");
    return 0;
  }

  const appId = requireId(
    positionals[0],
    "app id",
    "testflight versions abis <appId> <versionName>",
  );
  const versionName = requireId(
    positionals[1],
    "version name",
    "testflight versions abis <appId> <versionName>",
  );

  const { api } = await createClient(globals, { requireKey: false });
  const version = await api.getVersionAdmin(appId, versionName);

  if (globals.json) {
    printJson({
      appId,
      versionName,
      abis: version.abis,
      universal: version.universal,
      defaultAbi: version.defaultArtifact?.abi ?? null,
      artifacts: version.artifacts,
    });
    return 0;
  }

  if (version.artifacts.length === 0) {
    info(`"${versionName}" is a draft with no APK yet.`);
    return 0;
  }

  heading(`${appId} ${versionName} — ${version.abis.length} ABI(s)`);
  line();
  printTable(
    ["ABI", "SIZE", "SHA-256", "DEFAULT"],
    version.artifacts.map((artifact) => [
      artifact.abi,
      formatBytes(artifact.sizeBytes),
      shortSha(artifact.sha256),
      artifact.abi === version.defaultArtifact?.abi ? "*" : "",
    ]),
    ["left", "right", "left", "left"],
  );
  line();
  if (version.defaultArtifact) {
    info(`Default artifact: ${version.defaultArtifact.abi}`);
  }
  info(`Download one with: testflight download ${appId} ${versionName} --abi <abi>`);
  return 0;
}

async function createVersion(rest: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(
    rest,
    withGlobals({
      "version-code": { type: "string" },
      "min-sdk": { type: "string" },
      "release-notes": { type: "string" },
      "notes-file": { type: "string" },
      "published-at": { type: "string" },
    }),
  );
  const globals = readGlobals(values);
  configureOutput({ json: globals.json, color: globals.noColor ? false : undefined });
  if (globals.help) {
    printHelp("versions create");
    return 0;
  }

  const appId = requireId(
    positionals[0],
    "app id",
    "testflight versions create <appId> <versionName> --version-code <n>",
  );
  const versionName = requireId(
    positionals[1],
    "version name",
    "testflight versions create <appId> <versionName> --version-code <n>",
  );

  const versionCode = parseVersionCode(stringValue(values, "version-code"));
  const minSdk = parseOptionalMinSdk(stringValue(values, "min-sdk"));
  const releaseNotes = await resolveReleaseNotes(
    stringValue(values, "release-notes"),
    stringValue(values, "notes-file"),
  );
  const publishedAt = parsePublishedAt(stringValue(values, "published-at"));

  const { api } = await createClient(globals, { requireKey: true });
  const version = await api.createVersion(appId, {
    versionName,
    versionCode,
    ...(minSdk !== undefined ? { minSdk } : {}),
    ...(releaseNotes !== undefined ? { releaseNotes } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
  });

  if (globals.json) {
    printJson({ version });
    return 0;
  }
  success(`Created draft ${appId} ${version.versionName} (${version.versionCode}).`);
  info(`Upload an APK with: testflight release ${appId} <apk> --version ${versionName} --version-code ${versionCode}`);
  return 0;
}

async function updateVersion(rest: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(
    rest,
    withGlobals({
      "version-code": { type: "string" },
      "min-sdk": { type: "string" },
      "clear-min-sdk": { type: "boolean" },
      "release-notes": { type: "string" },
      "notes-file": { type: "string" },
      "clear-notes": { type: "boolean" },
      "published-at": { type: "string" },
    }),
  );
  const globals = readGlobals(values);
  configureOutput({ json: globals.json, color: globals.noColor ? false : undefined });
  if (globals.help) {
    printHelp("versions update");
    return 0;
  }

  const appId = requireId(
    positionals[0],
    "app id",
    "testflight versions update <appId> <versionName> [options]",
  );
  const versionName = requireId(
    positionals[1],
    "version name",
    "testflight versions update <appId> <versionName> [options]",
  );

  const minSdkRaw = stringValue(values, "min-sdk");
  const clearMinSdk = booleanValue(values, "clear-min-sdk");
  if (minSdkRaw !== undefined && clearMinSdk) {
    throw new UsageError("Use either --min-sdk or --clear-min-sdk, not both.");
  }

  const notesRaw = stringValue(values, "release-notes");
  const notesFile = stringValue(values, "notes-file");
  const clearNotes = booleanValue(values, "clear-notes");
  if ((notesRaw !== undefined || notesFile !== undefined) && clearNotes) {
    throw new UsageError(
      "Use either --release-notes/--notes-file or --clear-notes, not both.",
    );
  }

  const patch: {
    versionCode?: number;
    minSdk?: number | null;
    releaseNotes?: string | null;
    publishedAt?: string;
  } = {};

  const versionCodeRaw = stringValue(values, "version-code");
  if (versionCodeRaw !== undefined) patch.versionCode = parseVersionCode(versionCodeRaw);

  if (clearMinSdk) {
    patch.minSdk = null;
  } else {
    const minSdk = parseOptionalMinSdk(minSdkRaw);
    if (minSdk !== undefined) patch.minSdk = minSdk;
  }

  if (clearNotes) {
    patch.releaseNotes = null;
  } else {
    const releaseNotes = await resolveReleaseNotes(notesRaw, notesFile);
    if (releaseNotes !== undefined) patch.releaseNotes = releaseNotes;
  }

  const publishedAt = parsePublishedAt(stringValue(values, "published-at"));
  if (publishedAt !== undefined) patch.publishedAt = publishedAt;

  if (Object.keys(patch).length === 0) {
    throw new UsageError(
      "No fields to update.",
      "Pass --version-code, --min-sdk, --release-notes, --notes-file or --published-at.",
    );
  }

  const { api } = await createClient(globals, { requireKey: true });
  const version = await api.updateVersion(appId, versionName, patch);

  if (globals.json) {
    printJson({ version });
    return 0;
  }
  success(`Updated ${appId} ${version.versionName}.`);
  return 0;
}

async function deleteVersion(rest: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(
    rest,
    withGlobals({ yes: { type: "boolean", short: "y" } }),
  );
  const globals = readGlobals(values);
  configureOutput({ json: globals.json, color: globals.noColor ? false : undefined });
  if (globals.help) {
    printHelp("versions delete");
    return 0;
  }

  const appId = requireId(
    positionals[0],
    "app id",
    "testflight versions delete <appId> <versionName> [--yes]",
  );
  const versionName = requireId(
    positionals[1],
    "version name",
    "testflight versions delete <appId> <versionName> [--yes]",
  );

  await confirmDestructive(
    `Delete version "${versionName}" of "${appId}" and its APKs?`,
    booleanValue(values, "yes"),
  );

  const { api } = await createClient(globals, { requireKey: true });
  await api.deleteVersion(appId, versionName);

  if (globals.json) {
    printJson({ deleted: true, appId, versionName });
    return 0;
  }
  success(`Deleted ${appId} ${versionName}.`);
  return 0;
}

export async function runVersions(argv: string[]): Promise<number> {
  const first = argv[0];
  const action =
    first && Object.hasOwn(ACTIONS, first) ? ACTIONS[first]! : "list";
  const rest = first && Object.hasOwn(ACTIONS, first) ? argv.slice(1) : argv;

  switch (action) {
    case "get":
      return getVersion(rest);
    case "abis":
      return listAbis(rest);
    case "create":
      return createVersion(rest);
    case "update":
      return updateVersion(rest);
    case "delete":
      return deleteVersion(rest);
    case "list":
      return listVersions(rest);
  }
}
