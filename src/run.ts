import { runApkCommand } from "./commands/apk.js";
import { runApps } from "./commands/apps.js";
import { runArtifacts } from "./commands/artifacts.js";
import { runDownload } from "./commands/download.js";
import { runPublish } from "./commands/publish.js";
import { runRelease } from "./commands/release.js";
import { runConfig, runDoctor, runLogin, runLogout, runWhoami } from "./commands/setup.js";
import { runVersions } from "./commands/versions.js";
import { loadDotEnv } from "./env.js";
import { ApiError, CliError, UsageError, apiErrorHint } from "./errors.js";
import { printHelp } from "./help.js";
import { configureOutput, printError } from "./output.js";
import { VERSION } from "./version.js";

async function dispatch(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined) {
    printHelp();
    return 0;
  }

  switch (command) {
    case "help": {
      printHelp(rest.length > 0 ? rest.join(" ") : undefined);
      return 0;
    }
    case "-h":
    case "--help":
      printHelp();
      return 0;
    case "-v":
    case "--version":
    case "version":
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case "login":
      return runLogin(rest);
    case "logout":
      return runLogout(rest);
    case "whoami":
      return runWhoami(rest);
    case "config":
      return runConfig(rest);
    case "doctor":
      return runDoctor(rest);
    case "apps":
    case "app":
      return runApps(rest);
    case "versions":
      return runVersions(rest);
    case "release":
    case "push":
      return runRelease(rest);
    case "publish":
      return runPublish(rest);
    case "apk":
      return runApkCommand(rest);
    case "download":
      return runDownload(rest);
    case "artifacts":
      return runArtifacts(rest);
    default:
      if (command.startsWith("-")) {
        throw new UsageError(
          `Unknown option "${command}".`,
          "Run `testflight --help` for usage.",
        );
      }
      throw new UsageError(
        `Unknown command "${command}".`,
        "Run `testflight --help` for the command list.",
      );
  }
}

function reportError(error: unknown, verbose: boolean): number {
  if (error instanceof ApiError) {
    printError(
      `${error.message} (HTTP ${error.status} ${error.code})`,
      error.hint ?? apiErrorHint(error),
    );
    return error.exitCode;
  }
  if (error instanceof CliError) {
    printError(error.message, error.hint);
    return error.exitCode;
  }

  const message = error instanceof Error ? error.message : String(error);
  printError(
    `Unexpected error: ${message}`,
    verbose ? undefined : "Run again with --verbose for a stack trace.",
  );
  if (verbose && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  return 1;
}

export async function runCli(argv: string[]): Promise<number> {
  loadDotEnv();
  configureOutput({
    json: false,
    color: argv.includes("--no-color") ? false : undefined,
  });

  try {
    return await dispatch(argv);
  } catch (error) {
    return reportError(error, argv.includes("--verbose"));
  }
}
