import { UsageError } from "./errors.js";
import { configureOutput, heading, info, line, paint } from "./output.js";
import { VERSION } from "./version.js";

interface HelpEntry {
  summary: string;
  usage: string[];
  details?: string[];
  options?: Array<[string, string]>;
  examples?: string[];
  aliases?: string[];
}

const GLOBAL_OPTIONS: Array<[string, string]> = [
  ["--json", "Machine-readable JSON on stdout"],
  ["-p, --profile <name>", "Use a saved profile instead of the default"],
  ["--base-url <url>", "Override the saved server base URL"],
  ["--key <key>", "Override the management key (or set TESTFLIGHT_MANAGEMENT_KEY)"],
  ["--verbose", "Show extra diagnostics"],
  ["--no-color", "Disable ANSI colors"],
  ["-h, --help", "Show help for this command"],
];

const HELP: Record<string, HelpEntry> = {
  login: {
    summary: "Save a server URL and management key as a profile.",
    usage: ["testflight login [url] [options]"],
    details: [
      "Verifies the server health and the management key before saving, using a",
      "harmless write request that cannot create data. Use --no-verify to skip.",
      "The key is stored with mode 0600 in the user config file.",
    ],
    options: [
      ["-u, --url <url>", "Server base URL (may include a path prefix)"],
      ["-k, --key <key>", "Management key from data/config.json"],
      ["--key-stdin", "Read the management key from stdin (for CI)"],
      ["--no-verify", "Save without contacting the server"],
      ["-p, --profile <name>", "Profile name to create or update (default: current)"],
    ],
    examples: [
      "testflight login http://127.0.0.1:8080",
      "testflight login --url https://apps.example.com --key \"$KEY\"",
      "printf '%s' \"$KEY\" | testflight login --url https://apps.example.com --key-stdin",
    ],
  },
  logout: {
    summary: "Remove saved credentials.",
    usage: ["testflight logout [options]"],
    options: [
      ["--all", "Delete the whole config file, including every profile"],
      ["-p, --profile <name>", "Profile to remove (default: current)"],
    ],
    examples: ["testflight logout", "testflight logout --all"],
  },
  whoami: {
    summary: "Show the active profile, server URL and masked key.",
    usage: ["testflight whoami [options]"],
    examples: ["testflight whoami", "testflight whoami --json"],
  },
  config: {
    summary: "Inspect profiles, print the config path, or switch the default profile.",
    usage: [
      "testflight config [list]",
      "testflight config path",
      "testflight config use <profile>",
    ],
    options: [["-p, --profile <name>", "Operate on a specific profile"]],
    examples: ["testflight config", "testflight config use staging"],
  },
  doctor: {
    summary: "Check Node, the config file, server health and the management key.",
    usage: ["testflight doctor [options]"],
    details: ["Exits with code 1 when any check fails, which makes it useful in CI."],
    examples: ["testflight doctor", "testflight doctor --json"],
  },
  apps: {
    summary: "List, inspect and manage apps in the catalog.",
    usage: [
      "testflight apps [list] [options]",
      "testflight apps <appId> [options]",
      "testflight apps get <appId> [options]",
      "testflight apps create <appId> [options]",
      "testflight apps update <appId> [options]",
      "testflight apps delete <appId> [options]",
      "testflight apps icon <appId> [options]",
    ],
    options: [
      ["--search <text>", "Filter the list by id, name, package or developer"],
      ["--sort <name|id|latest>", "Sort the list (default: name)"],
    ],
    examples: [
      "testflight apps",
      "testflight apps crm",
      "testflight apps list --search crm --json",
    ],
  },
  "apps list": {
    summary: "List every app with its latest published version.",
    usage: ["testflight apps list [options]"],
    options: [
      ["--search <text>", "Filter by id, name, package or developer"],
      ["--sort <name|id|latest>", "Sort by name (default), id, or highest versionCode"],
    ],
    examples: ["testflight apps list", "testflight apps list --search crm --json"],
  },
  "apps get": {
    summary: "Show one app and its published versions.",
    usage: ["testflight apps get <appId> [options]"],
    examples: ["testflight apps get crm", "testflight apps get crm --json"],
  },
  "apps create": {
    summary: "Create an app entry in the catalog.",
    usage: ["testflight apps create <appId> [options]"],
    details: [
      "appId and version names must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$.",
      "Without --name the server humanizes the id (demo-app → Demo App).",
    ],
    options: [
      ["--name <text>", "Display name"],
      ["--package <name>", "Android package name, e.g. com.company.crm"],
      ["--description <text>", "Description"],
      ["--developer <text>", "Developer or team label"],
      ["--icon <file>", "PNG/JPEG/WebP icon to upload after creation (≤ 2 MiB)"],
    ],
    examples: [
      'testflight apps create crm --name "Internal CRM" --package com.company.crm',
      "testflight apps create crm --icon ./icon.png",
    ],
  },
  "apps update": {
    summary: "Update app metadata.",
    usage: ["testflight apps update <appId> [options]"],
    options: [
      ["--name <text>", "Display name"],
      ["--package <name>", "Android package name"],
      ["--description <text>", "Description (empty string clears it)"],
      ["--developer <text>", "Developer or team label (empty string clears it)"],
    ],
    examples: ['testflight apps update crm --developer "Platform Team"'],
  },
  "apps delete": {
    summary: "Delete an app and all of its versions and APKs.",
    usage: ["testflight apps delete <appId> [options]"],
    options: [["-y, --yes", "Do not ask for confirmation"]],
    examples: ["testflight apps delete old-app --yes"],
  },
  "apps icon": {
    summary: "Upload or remove an app icon.",
    usage: [
      "testflight apps icon <appId> --file <image>",
      "testflight apps icon <appId> --delete",
    ],
    options: [
      ["--file <path>", "PNG, JPEG or WebP file (≤ 2 MiB)"],
      ["--delete", "Remove the current icon"],
    ],
    examples: [
      "testflight apps icon crm --file ./icon.png",
      "testflight apps icon crm --delete",
    ],
  },
  versions: {
    summary: "List versions and their architectures, and manage version metadata.",
    usage: [
      "testflight versions [list] <appId> [options]",
      "testflight versions <appId> <versionName> [options]",
      "testflight versions get <appId> <versionName> [options]",
      "testflight versions abis <appId> <versionName> [options]",
      "testflight versions create <appId> <versionName> [options]",
      "testflight versions update <appId> <versionName> [options]",
      "testflight versions delete <appId> <versionName> [options]",
    ],
    options: [["--published", "List only published versions (omit drafts)"]],
    examples: [
      "testflight versions crm",
      "testflight versions abis crm 1.4.2",
    ],
  },
  "versions list": {
    summary: "List versions, including drafts, with codes, sizes and ABIs.",
    usage: ["testflight versions list <appId> [options]"],
    options: [["--published", "Hide drafts by reading the public catalog instead"]],
    examples: ["testflight versions list crm", "testflight versions crm --json"],
  },
  "versions get": {
    summary: "Show one version, including every artifact and checksum.",
    usage: ["testflight versions get <appId> <versionName> [options]"],
    examples: ["testflight versions get crm 1.4.2"],
  },
  "versions abis": {
    summary: "List the ABIs (architectures) published in a version.",
    usage: ["testflight versions abis <appId> <versionName> [options]"],
    examples: [
      "testflight versions abis crm 1.4.2",
      "testflight versions abis crm 1.4.2 --json",
    ],
  },
  "versions create": {
    summary: "Create a draft version without uploading an APK yet.",
    usage: [
      "testflight versions create <appId> <versionName> --version-code <n> [options]",
    ],
    details: [
      "A draft is visible to the admin GET routes but not in the public catalog",
      "until its first APK is uploaded. `release` does this automatically.",
    ],
    options: [
      ["--version-code <n>", "Required positive integer"],
      ["--min-sdk <n>", "Minimum Android API level"],
      ["--release-notes <text>", "Release notes"],
      ["--notes-file <path>", "Read release notes from a UTF-8 file"],
      ["--published-at <iso>", "Publication timestamp (default: server time)"],
    ],
    examples: [
      "testflight versions create crm 1.5.0 --version-code 150 --min-sdk 26",
    ],
  },
  "versions update": {
    summary: "Update version metadata.",
    usage: ["testflight versions update <appId> <versionName> [options]"],
    options: [
      ["--version-code <n>", "New positive versionCode"],
      ["--min-sdk <n>", "Minimum Android API level"],
      ["--clear-min-sdk", "Remove minSdk"],
      ["--release-notes <text>", "Release notes"],
      ["--notes-file <path>", "Read release notes from a UTF-8 file"],
      ["--clear-notes", "Remove release notes"],
      ["--published-at <iso>", "Publication timestamp"],
    ],
    examples: [
      "testflight versions update crm 1.4.2 --release-notes \"Fixes login timeout\"",
    ],
  },
  "versions delete": {
    summary: "Delete a version and its APKs.",
    usage: ["testflight versions delete <appId> <versionName> [options]"],
    options: [["-y, --yes", "Do not ask for confirmation"]],
    examples: ["testflight versions delete crm 1.0.0 --yes"],
  },
  release: {
    summary: "Create a version and upload one APK per ABI (alias: push).",
    usage: [
      "testflight release <appId> <apk...> [--version <name>] [--version-code <n>] [options]",
    ],
    details: [
      "The version name/code come from --version/--version-code, or from the",
      "first APK's binary AndroidManifest.xml when omitted. All APKs must",
      "describe the same package and version. Each APK's ABI comes from its",
      "manifest and lib/<abi>/ entries (zero or several ⇒ universal); pass",
      "--abi to override. Existing drafts gain artifacts; a published version",
      "is only replaced with --force (or an interactive confirmation).",
    ],
    options: [
      ["--version <name>", "Version name (default: the APK's versionName)"],
      ["--version-code <n>", "Positive versionCode (default: the APK's versionCode)"],
      ["--abi <abi>", "Repeatable; one value per APK. Valid: universal, arm64-v8a, armeabi-v7a, x86_64, x86, riscv64, armeabi"],
      ["--universal", "Publish a single APK as universal"],
      ["--min-sdk <n>", "Minimum Android API level"],
      ["--release-notes <text>", "Release notes"],
      ["--notes-file <path>", "Read release notes from a UTF-8 file"],
      ["--published-at <iso>", "Publication timestamp (default: server time)"],
      ["--allow-mismatch <csv>", "Skip strict checks: package, version, sdk, abi"],
      ["--create", "Create the app if it does not exist"],
      ["--name <text>", "App name to use with --create"],
      ["--package <name>", "Package name to use with --create"],
      ["--description <text>", "Description to use with --create"],
      ["--developer <text>", "Developer to use with --create"],
      ["-f, --force", "Replace existing artifacts and metadata"],
      ["-y, --yes", "Accept replacement without prompting (also works without a TTY)"],
      ["-n, --dry-run", "Show the plan without changing the server"],
      ["--no-progress", "Hide the upload progress bar"],
    ],
    examples: [
      "testflight release crm app-arm64-v8a.apk --version 1.4.2 --version-code 142",
      "testflight release crm app-arm64-v8a.apk --version-code 142",
      "testflight release crm app-arm64.apk app-x86_64.apk --version 1.4.2 --version-code 142 --abi arm64-v8a --abi x86_64",
      "testflight push crm app-release.apk --create",
      "testflight release crm app.apk --dry-run",
    ],
  },
  apk: {
    summary: "Inspect APK files without contacting a server.",
    usage: ["testflight apk inspect <apk...> [--json]"],
    details: [
      "Reads the ZIP central directory and the binary AndroidManifest.xml;",
      "prints packageName, versionCode/versionName, minSdk/targetSdk, ABIs,",
      "debuggable/testOnly and split flags. Exits 1 when a file cannot be read.",
    ],
    examples: [
      "testflight apk inspect app-release.apk",
      "testflight apk inspect app-arm64-v8a.apk --json",
    ],
  },
  "apk inspect": {
    summary: "Print the metadata of one or more APKs.",
    usage: ["testflight apk inspect <apk...> [--json]"],
    details: [
      "Everything is computed locally; no server or management key is needed.",
      "In JSON mode a failed file becomes { \"path\": ..., \"error\": ... } and",
      "the command exits 1 after printing every result.",
    ],
    options: [],
    examples: [
      "testflight apk inspect app-arm64-v8a.apk",
      "testflight apk inspect build/*.apk --json",
    ],
  },
  publish: {
    summary: "Publish APKs in one step using the server's APK-only import route.",
    usage: ["testflight publish <apk...> [options]"],
    details: [
      "Inspects every APK first, requires one package/version per batch and",
      "stops before creating anything if they disagree. App id defaults to the",
      "APK's package name; version name/code default to the APK's manifest.",
      "The server infers the ABI. POST /api/v1/import must exist (upgrade old",
      "servers); `release` keeps using the older artifact routes.",
      "Release notes above 4 KiB are sent with a follow-up PUT instead of the",
      "import query string. --dry-run is fully offline.",
    ],
    options: [
      ["--app-id <id>", "App id (default: the APK's package name)"],
      ["--create", "Create the app if it does not exist"],
      ["--name <text>", "App display name to use with --create"],
      ["--version <name>", "Version name (default: the APK's versionName)"],
      ["--version-code <n>", "Positive versionCode (default: the APK's versionCode)"],
      ["--release-notes <text>", "Release notes"],
      ["--notes-file <path>", "Read release notes from a UTF-8 file"],
      ["--published-at <iso>", "Publication timestamp (default: server time)"],
      ["--allow-mismatch <csv>", "Skip strict checks: package, version, sdk, abi"],
      ["-n, --dry-run", "Inspect and print the plan without a server"],
      ["--no-progress", "Hide the upload progress bar"],
    ],
    examples: [
      "testflight publish app-arm64-v8a.apk --create",
      "testflight publish build/app-arm64-v8a.apk build/app-x86_64.apk --app-id crm --json",
      "testflight publish app-release.apk --version 1.4.2 --version-code 142 --dry-run",
    ],
  },
  download: {
    summary: "Download an APK for a version, optionally for a specific ABI.",
    usage: ["testflight download <appId> <versionName> [options]"],
    details: [
      "Reads are public, so no management key is required. When the server",
      "returns X-Checksum-Sha256 the file is verified before it is saved.",
    ],
    options: [
      ["--abi <abi>", "Download this ABI instead of the default artifact"],
      ["--out <path>", "File, or an existing directory (default: ./<appId>-<version>[-<abi>].apk)"],
      ["-f, --force", "Overwrite an existing file"],
      ["--no-progress", "Hide the download progress bar"],
    ],
    examples: [
      "testflight download crm 1.4.2",
      "testflight download crm 1.4.2 --abi arm64-v8a --out ./builds",
    ],
  },
  artifacts: {
    summary: "List or delete individual artifacts of a version.",
    usage: [
      "testflight artifacts list <appId> <versionName> [options]",
      "testflight artifacts delete <appId> <versionName> <abi> [options]",
    ],
    details: [
      "`versions abis` shows the same list with the version's default artifact.",
      "Deleting the last artifact returns the version to draft.",
    ],
    examples: [
      "testflight artifacts list crm 1.4.2",
      "testflight artifacts delete crm 1.4.2 x86 --yes",
    ],
  },
  "artifacts delete": {
    summary: "Delete one ABI artifact from a version.",
    usage: ["testflight artifacts delete <appId> <versionName> <abi> [options]"],
    options: [["-y, --yes", "Do not ask for confirmation"]],
    examples: ["testflight artifacts delete crm 1.4.2 x86 --yes"],
  },
};

function formatOptions(options: Array<[string, string]>): void {
  const width = Math.max(...options.map(([flag]) => flag.length));
  for (const [flag, description] of options) {
    line(`  ${paint("cyan", flag.padEnd(width))}  ${description}`);
  }
}

function printEntry(name: string, entry: HelpEntry): void {
  heading(`testflight ${name} — ${entry.summary}`);
  line();
  heading("Usage:");
  for (const usage of entry.usage) line(`  ${usage}`);

  if (entry.details && entry.details.length > 0) {
    line();
    for (const detail of entry.details) line(detail);
  }

  line();
  heading("Options:");
  formatOptions(entry.options ?? []);
  line();
  formatOptions(GLOBAL_OPTIONS);

  if (entry.examples && entry.examples.length > 0) {
    line();
    heading("Examples:");
    for (const example of entry.examples) line(`  ${paint("dim", "$")} ${example}`);
  }
}

export function printRootHelp(): void {
  heading(`my-testflight-cli ${VERSION}`);
  line("Publish Android builds to a MyTestflightServer from the terminal or CI.");
  line();
  heading("Usage:");
  line("  testflight <command> [options]");
  line();
  heading("Setup:");
  line("  login                       Save a server URL and management key");
  line("  logout                      Remove saved credentials");
  line("  whoami                      Show the active profile");
  line("  config [list|path|use]      Inspect or switch profiles");
  line("  doctor                      Check Node, config, server and key");
  line();
  heading("Catalog:");
  line("  apps [list]                 List apps");
  line("  apps get <appId>            Show one app");
  line("  apps create <appId>         Create an app");
  line("  apps update <appId>         Update app metadata");
  line("  apps delete <appId>         Delete an app");
  line("  apps icon <appId>           Upload or delete an icon");
  line("  versions <appId>            List versions (including drafts)");
  line("  versions get <appId> <v>    Show one version");
  line("  versions abis <appId> <v>   List the version's ABIs");
  line("  versions create <appId> <v> Create a draft version");
  line("  versions update <appId> <v> Update version metadata");
  line("  versions delete <appId> <v> Delete a version");
  line();
  heading("Publish:");
  line("  apk inspect <apk...>        Print package/version/SDK/ABI metadata");
  line("  publish <apk...>            Inspect and import APKs (POST /api/v1/import)");
  line("  release <appId> <apk...>    Create/update a version and upload APKs");
  line("                              (alias: push)");
  line("  download <appId> <v>        Download an APK");
  line("  artifacts delete ...        Delete one ABI artifact");
  line();
  heading("Global options:");
  formatOptions(GLOBAL_OPTIONS);
  line();
  heading("Examples:");
  line("  testflight login http://127.0.0.1:8080");
  line('  testflight apps create crm --name "Internal CRM" --package com.company.crm');
  line("  testflight apk inspect app-arm64-v8a.apk --json");
  line("  testflight publish app-arm64-v8a.apk --create");
  line("  testflight versions abis crm 1.4.2 --json");
  line();
  info("Run `testflight <command> --help` for details. Alias: tf.");
}

export function printHelp(topic?: string): void {
  // Help is always human-readable, even when the command was invoked with --json.
  configureOutput({ json: false });
  if (!topic) {
    printRootHelp();
    return;
  }
  const normalized = topic.trim().replace(/\s+/g, " ");
  const entry =
    HELP[normalized] ??
    HELP[normalized.split(" ")[0] ?? ""] ??
    (normalized.length > 0 && normalized.startsWith("push") ? HELP.release : undefined);

  if (!entry) {
    throw new UsageError(
      `No help available for "${topic}".`,
      "Run `testflight --help` for the command list.",
    );
  }
  printEntry(normalized.startsWith("push") ? "release" : normalized, entry);
}

export function hasHelpTopic(topic: string): boolean {
  return Object.hasOwn(HELP, topic.trim().replace(/\s+/g, " "));
}
