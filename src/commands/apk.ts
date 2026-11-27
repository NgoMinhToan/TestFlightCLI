import { stat } from "node:fs/promises";
import path from "node:path";
import { parseCommandArgs, readGlobals, withGlobals } from "../args.js";
import { artifactAbiOf, type ApkMetadata } from "../apk-manifest.js";
import { scanApk } from "../apk.js";
import { UsageError } from "../errors.js";
import { printHelp } from "../help.js";
import {
  configureOutput,
  formatBytes,
  heading,
  info,
  line,
  printJson,
  printTable,
} from "../output.js";

interface InspectEntry {
  path: string;
  fileName: string;
  sizeBytes: number;
  metadata: ApkMetadata;
  artifactAbi: string;
}

interface InspectErrorEntry {
  path: string;
  error: string;
}

function describeMetadata(entry: InspectEntry): void {
  const metadata = entry.metadata;
  heading(`${entry.fileName}  (${formatBytes(entry.sizeBytes)})`);
  line(`  Path:        ${entry.path}`);
  line(`  Package:     ${metadata.packageName}`);
  line(`  Version:     ${metadata.versionName ?? "(resource reference)"} (${metadata.versionCode})`);
  line(`  SDK:         minSdk ${metadata.minSdk ?? "?"} / targetSdk ${metadata.targetSdk ?? "?"}`);
  line(`  ABI:         ${entry.artifactAbi}${metadata.universal ? " (universal)" : ""}`);
  if (metadata.abis.length > 0) line(`  Native:      ${metadata.abis.join(", ")}`);
  if (metadata.split) line(`  Split:       ${metadata.split}`);
  const flags = [
    metadata.debuggable ? "debuggable" : null,
    metadata.testOnly ? "testOnly" : null,
    metadata.configSplit ? "config split" : null,
  ].filter((flag): flag is string => flag !== null);
  if (flags.length > 0) line(`  Flags:       ${flags.join(", ")}`);
  line();
}

async function inspectOne(rawPath: string): Promise<InspectEntry | InspectErrorEntry> {
  const filePath = path.resolve(rawPath);
  try {
    const infoStat = await stat(filePath).catch(() => null);
    if (!infoStat?.isFile()) return { path: filePath, error: "file not found" };
    const scan = await scanApk(filePath);
    if (!scan.metadata) {
      return {
        path: filePath,
        error: scan.metadataError ?? "AndroidManifest.xml could not be read",
      };
    }
    return {
      path: filePath,
      fileName: path.basename(filePath),
      sizeBytes: infoStat.size,
      metadata: scan.metadata,
      artifactAbi: artifactAbiOf(scan.metadata),
    };
  } catch (error) {
    return { path: filePath, error: (error as Error).message };
  }
}

function isError(entry: InspectEntry | InspectErrorEntry): entry is InspectErrorEntry {
  return "error" in entry;
}

export async function runApkCommand(argv: string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (
    subcommand === undefined ||
    subcommand === "help" ||
    subcommand === "-h" ||
    subcommand === "--help"
  ) {
    printHelp("apk");
    return 0;
  }
  if (subcommand !== "inspect") {
    throw new UsageError(
      `Unknown apk subcommand "${subcommand}".`,
      "Usage: testflight apk inspect <apk...> [--json]",
    );
  }

  const { values, positionals } = parseCommandArgs(rest, withGlobals());
  const globals = readGlobals(values);
  configureOutput({ json: globals.json, color: globals.noColor ? false : undefined });
  if (globals.help) {
    printHelp("apk inspect");
    return 0;
  }
  if (positionals.length === 0) {
    throw new UsageError(
      "At least one APK is required.",
      "Usage: testflight apk inspect <apk...> [--json]",
    );
  }

  const entries = [];
  for (const rawPath of positionals) entries.push(await inspectOne(rawPath));

  const failures = entries.filter(isError);

  if (globals.json) {
    printJson({
      files: entries.map((entry) =>
        isError(entry)
          ? { path: entry.path, error: entry.error }
          : {
              path: entry.path,
              fileName: entry.fileName,
              sizeBytes: entry.sizeBytes,
              metadata: entry.metadata,
              artifactAbi: entry.artifactAbi,
            },
      ),
    });
    return failures.length > 0 ? 1 : 0;
  }

  for (const entry of entries) {
    if (isError(entry)) {
      line(`ERROR ${entry.path}: ${entry.error}`);
    } else {
      describeMetadata(entry);
    }
  }

  const readable = entries.filter((entry): entry is InspectEntry => !isError(entry));
  if (readable.length > 0) {
    printTable(
      ["PACKAGE", "VERSION", "CODE", "MIN SDK", "ABI", "APK"],
      readable.map((entry) => [
        entry.metadata.packageName,
        entry.metadata.versionName ?? "(ref)",
        String(entry.metadata.versionCode),
        entry.metadata.minSdk === null ? "-" : String(entry.metadata.minSdk),
        entry.artifactAbi,
        entry.fileName,
      ]),
    );
  }
  if (failures.length > 0) {
    info(`${failures.length} file(s) could not be inspected.`);
    return 1;
  }
  return 0;
}
