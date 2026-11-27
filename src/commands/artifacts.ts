import {
  booleanValue,
  parseCommandArgs,
  readGlobals,
  withGlobals,
} from "../args.js";
import { normalizeAbi } from "../abi.js";
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
  shortSha,
  success,
} from "../output.js";
import {
  confirmDestructive,
  createClient,
  requireId,
  requireVersionName,
} from "./common.js";

async function deleteArtifact(rest: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(
    rest,
    withGlobals({ yes: { type: "boolean", short: "y" } }),
  );
  const globals = readGlobals(values);
  configureOutput({ json: globals.json, color: globals.noColor ? false : undefined });
  if (globals.help) {
    printHelp("artifacts delete");
    return 0;
  }

  const appId = requireId(
    positionals[0],
    "app id",
    "testflight artifacts delete <appId> <versionName> <abi>",
  );
  const versionName = requireVersionName(
    positionals[1],
    "version name",
    "testflight artifacts delete <appId> <versionName> <abi>",
  );
  const abi = normalizeAbi(positionals[2] ?? "");
  if (!abi) {
    throw new UsageError(
      `Unknown ABI "${positionals[2] ?? ""}".`,
      "Valid ABIs: universal, arm64-v8a, armeabi-v7a, x86_64, x86, riscv64, armeabi.",
    );
  }

  await confirmDestructive(
    `Delete the ${abi} artifact from ${appId} ${versionName}?`,
    booleanValue(values, "yes"),
  );

  const { api } = await createClient(globals, { requireKey: true });
  await api.deleteArtifact(appId, versionName, abi);

  if (globals.json) {
    printJson({ deleted: true, appId, versionName, abi });
    return 0;
  }
  success(`Deleted ${abi} from ${appId} ${versionName}.`);
  return 0;
}

async function listArtifacts(rest: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(rest, withGlobals());
  const globals = readGlobals(values);
  configureOutput({ json: globals.json, color: globals.noColor ? false : undefined });
  if (globals.help) {
    printHelp("artifacts");
    return 0;
  }

  const appId = requireId(
    positionals[0],
    "app id",
    "testflight artifacts list <appId> <versionName>",
  );
  const versionName = requireVersionName(
    positionals[1],
    "version name",
    "testflight artifacts list <appId> <versionName>",
  );

  const { api } = await createClient(globals, { requireKey: false });
  const version = await api.getVersionAdmin(appId, versionName);

  if (globals.json) {
    printJson({
      appId,
      versionName,
      abis: version.abis,
      defaultAbi: version.defaultArtifact?.abi ?? null,
      artifacts: version.artifacts,
    });
    return 0;
  }

  if (version.artifacts.length === 0) {
    info(`"${versionName}" is a draft with no artifacts.`);
    return 0;
  }

  heading(`${appId} ${versionName} — artifacts`);
  line();
  printTable(
    ["ABI", "SIZE", "SHA-256", "FILE", "DEFAULT"],
    version.artifacts.map((artifact) => [
      artifact.abi,
      formatBytes(artifact.sizeBytes),
      shortSha(artifact.sha256),
      artifact.filename,
      artifact.abi === version.defaultArtifact?.abi ? "*" : "",
    ]),
    ["left", "right", "left", "left", "left"],
  );
  return 0;
}

export async function runArtifacts(argv: string[]): Promise<number> {
  const first = argv[0];
  if (first === "delete" || first === "rm") return deleteArtifact(argv.slice(1));
  if (first === "list" || first === "ls") return listArtifacts(argv.slice(1));
  if (first === "--help" || first === "-h") {
    printHelp("artifacts");
    return 0;
  }
  throw new UsageError(
    "artifacts expects a subcommand.",
    "Usage: testflight artifacts list <appId> <versionName> | testflight artifacts delete <appId> <versionName> <abi>",
  );
}
