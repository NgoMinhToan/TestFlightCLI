import { stat } from "node:fs/promises";
import path from "node:path";
import {
  booleanValue,
  parseCommandArgs,
  readGlobals,
  stringValue,
  withGlobals,
} from "../args.js";
import { normalizeAbi, type Abi } from "../abi.js";
import { CliError, UsageError } from "../errors.js";
import { printHelp } from "../help.js";
import {
  clearProgress,
  configureOutput,
  formatBytes,
  info,
  line,
  printJson,
  progress,
  shortSha,
  success,
} from "../output.js";
import { createClient, requireId } from "./common.js";

export async function runDownload(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(
    argv,
    withGlobals({
      abi: { type: "string" },
      out: { type: "string", short: "o" },
      force: { type: "boolean", short: "f" },
      "no-progress": { type: "boolean" },
    }),
  );
  const globals = readGlobals(values);
  configureOutput({ json: globals.json, color: globals.noColor ? false : undefined });
  if (globals.help) {
    printHelp("download");
    return 0;
  }

  const appId = requireId(
    positionals[0],
    "app id",
    "testflight download <appId> <versionName> [options]",
  );
  const versionName = requireId(
    positionals[1],
    "version name",
    "testflight download <appId> <versionName> [options]",
  );

  const { api } = await createClient(globals, { requireKey: false });
  const version = await api.getVersionAdmin(appId, versionName);
  if (version.artifacts.length === 0) {
    throw new CliError(
      `Version "${versionName}" is a draft with no APK yet.`,
      `Upload one with \`testflight release ${appId} <apk> --version ${versionName} --version-code <n>\`.`,
    );
  }

  const abiRaw = stringValue(values, "abi");
  let abi: Abi | null = null;
  if (abiRaw !== undefined) {
    abi = normalizeAbi(abiRaw);
    if (!abi) {
      throw new UsageError(
        `Unknown ABI "${abiRaw}".`,
        "Valid ABIs: universal, arm64-v8a, armeabi-v7a, x86_64, x86, riscv64, armeabi.",
      );
    }
    if (!version.artifacts.some((artifact) => artifact.abi === abi)) {
      throw new CliError(
        `Version "${versionName}" has no ${abi} artifact.`,
        `Available ABIs: ${version.abis.join(", ") || "none"}.`,
      );
    }
  }

  const defaultAbi = version.defaultArtifact?.abi ?? null;
  const fileName = `${appId}-${versionName}${abi ? `-${abi}` : ""}.apk`;
  const out = stringValue(values, "out");
  let destination: string;
  if (out) {
    const resolved = path.resolve(out);
    const existing = await stat(resolved).catch(() => null);
    destination = existing?.isDirectory() ? path.join(resolved, fileName) : resolved;
  } else {
    destination = path.resolve(fileName);
  }

  const existingFile = await stat(destination).catch(() => null);
  if (existingFile?.isFile() && !booleanValue(values, "force")) {
    throw new CliError(
      `Refusing to overwrite ${destination}.`,
      "Pass --force, or choose another --out path.",
    );
  }
  if (existingFile?.isDirectory()) {
    throw new CliError(`"${destination}" is a directory.`, "Pass a file path to --out.");
  }

  if (!globals.json) {
    info(
      `Downloading ${appId} ${versionName}${abi ? ` [${abi}]` : ""} → ${destination}`,
    );
  }

  const showProgress = !booleanValue(values, "no-progress") && !globals.json;
  let result;
  try {
    result = await api.downloadArtifact(appId, versionName, abi, destination, {
      onProgress: (downloaded, total) => {
        progress(abi ?? defaultAbi ?? "apk", downloaded, total, {
          enabled: showProgress,
        });
      },
    });
  } finally {
    clearProgress();
  }

  if (globals.json) {
    printJson({
      appId,
      versionName,
      abi: result.abi ?? defaultAbi,
      path: result.path,
      bytes: result.bytes,
      sha256: result.sha256,
      verified: result.verified,
    });
    return 0;
  }

  line();
  success(`Saved ${result.path} (${formatBytes(result.bytes)}, sha256 ${shortSha(result.sha256)})`);
  if (result.verified) {
    info("Checksum verified against the server's X-Checksum-Sha256.");
  }
  return 0;
}
