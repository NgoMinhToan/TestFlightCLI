import { stat } from "node:fs/promises";
import path from "node:path";
import {
  booleanValue,
  parseCommandArgs,
  readGlobals,
  stringValue,
  withGlobals,
} from "../args.js";
import type { AppDetail, TestflightApi } from "../api.js";
import { CliError, UsageError } from "../errors.js";
import { printHelp } from "../help.js";
import {
  configureOutput,
  formatBytes,
  formatDate,
  heading,
  info,
  line,
  printJson,
  printTable,
  success,
} from "../output.js";
import {
  confirmDestructive,
  createClient,
  formatAbiList,
  requireId,
} from "./common.js";

type AppAction = "list" | "get" | "create" | "update" | "delete" | "icon";

const ACTIONS: Record<string, AppAction> = {
  list: "list",
  get: "get",
  show: "get",
  create: "create",
  new: "create",
  update: "update",
  edit: "update",
  delete: "delete",
  rm: "delete",
  icon: "icon",
};

function describeApp(app: AppDetail): void {
  heading(`${app.name}  (${app.id})`);
  line(`  Package:    ${app.packageName || "-"}`);
  if (app.developer) line(`  Developer:  ${app.developer}`);
  line(`  Versions:   ${app.versionCount} published`);
  if (app.iconPath) line(`  Icon:       ${app.iconPath}`);
  if (app.description) {
    line();
    line(app.description);
  }
  line();

  if (app.versions.length === 0) {
    info("No published versions yet. Drafts are visible with `testflight versions list`.");
    return;
  }

  printTable(
    ["VERSION", "CODE", "MIN SDK", "SIZE", "ABIS", "PUBLISHED"],
    app.versions.map((version) => [
      version.versionName,
      String(version.versionCode),
      version.minSdk === null ? "-" : String(version.minSdk),
      formatBytes(version.sizeBytes),
      formatAbiList(version.abis),
      formatDate(version.publishedAt),
    ]),
  );
}

async function showApp(
  api: TestflightApi,
  appId: string,
  json: boolean,
): Promise<void> {
  const app = await api.getApp(appId);
  if (json) {
    printJson({ app });
    return;
  }
  describeApp(app);
}

async function listApps(rest: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(
    rest,
    withGlobals({
      search: { type: "string" },
      sort: { type: "string" },
    }),
  );
  const parsedGlobals = readGlobals(values);
  configureOutput({
    json: parsedGlobals.json,
    color: parsedGlobals.noColor ? false : undefined,
  });
  if (parsedGlobals.help) {
    printHelp(positionals.length === 1 ? "apps get" : "apps list");
    return 0;
  }
  if (positionals.length > 1) {
    throw new UsageError(
      "Too many arguments.",
      "Usage: testflight apps [list] [<appId>] [--search <text>]",
    );
  }

  const { api } = await createClient(parsedGlobals, { requireKey: false });

  if (positionals.length === 1) {
    await showApp(api, requireId(positionals[0], "app id", "testflight apps <appId>"), parsedGlobals.json);
    return 0;
  }

  const sortKey = stringValue(values, "sort") ?? "name";
  if (sortKey !== "name" && sortKey !== "id" && sortKey !== "latest") {
    throw new UsageError(
      `Unknown --sort value "${sortKey}".`,
      "Use --sort name, --sort id, or --sort latest.",
    );
  }

  const search = stringValue(values, "search")?.trim().toLowerCase();
  let apps = await api.listApps();
  if (search) {
    apps = apps.filter((app) =>
      [app.id, app.name, app.packageName, app.developer]
        .join("\n")
        .toLowerCase()
        .includes(search),
    );
  }

  apps = [...apps].sort((left, right) => {
    if (sortKey === "id") return left.id.localeCompare(right.id);
    if (sortKey === "latest") {
      return (right.latestVersion?.versionCode ?? -1) - (left.latestVersion?.versionCode ?? -1);
    }
    return left.name.localeCompare(right.name);
  });

  if (parsedGlobals.json) {
    printJson({ apps });
    return 0;
  }

  if (apps.length === 0) {
    info(
      search
        ? `No apps match "${search}".`
        : "No apps yet. Create one with `testflight apps create <appId>`.",
    );
    return 0;
  }

  printTable(
    ["ID", "NAME", "PACKAGE", "VERSIONS", "LATEST", "ABIS"],
    apps.map((app) => [
      app.id,
      app.name,
      app.packageName || "-",
      String(app.versionCount),
      app.latestVersion
        ? `${app.latestVersion.versionName} (${app.latestVersion.versionCode})`
        : "-",
      formatAbiList(app.latestVersion?.abis ?? []),    ]),
  );
  return 0;
}

async function getApp(rest: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(rest, withGlobals());
  const globals = readGlobals(values);
  configureOutput({ json: globals.json, color: globals.noColor ? false : undefined });
  if (globals.help) {
    printHelp("apps get");
    return 0;
  }
  const appId = requireId(positionals[0], "app id", "testflight apps get <appId>");
  const { api } = await createClient(globals, { requireKey: false });
  await showApp(api, appId, globals.json);
  return 0;
}

async function createApp(rest: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(
    rest,
    withGlobals({
      name: { type: "string" },
      package: { type: "string" },
      description: { type: "string" },
      developer: { type: "string" },
      icon: { type: "string" },
    }),
  );
  const globals = readGlobals(values);
  configureOutput({ json: globals.json, color: globals.noColor ? false : undefined });
  if (globals.help) {
    printHelp("apps create");
    return 0;
  }

  const appId = requireId(positionals[0], "app id", "testflight apps create <appId>");
  if (positionals.length > 1) {
    throw new UsageError("Too many arguments.", "Usage: testflight apps create <appId> [options]");
  }

  const iconPath = stringValue(values, "icon");
  if (iconPath) {
    const fileInfo = await stat(path.resolve(iconPath)).catch(() => null);
    if (!fileInfo?.isFile()) throw new CliError(`Icon not found: ${iconPath}`);
  }

  const { api } = await createClient(globals, { requireKey: true });
  const app = await api.createApp({
    id: appId,
    name: stringValue(values, "name"),
    packageName: stringValue(values, "package"),
    description: stringValue(values, "description"),
    developer: stringValue(values, "developer"),
  });

  let iconPathResult: string | undefined;
  if (iconPath) {
    const icon = await api.putIcon(appId, path.resolve(iconPath));
    iconPathResult = icon.iconPath;
  }

  if (globals.json) {
    printJson({ app, ...(iconPathResult ? { iconPath: iconPathResult } : {}) });
    return 0;
  }

  success(`Created app "${app.id}" (${app.name}).`);
  if (iconPathResult) success(`Uploaded icon → ${iconPathResult}`);
  info(`Next: testflight release ${app.id} <apk> --version 1.0.0 --version-code 1`);
  return 0;
}

async function updateApp(rest: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(
    rest,
    withGlobals({
      name: { type: "string" },
      package: { type: "string" },
      description: { type: "string" },
      developer: { type: "string" },
    }),
  );
  const globals = readGlobals(values);
  configureOutput({ json: globals.json, color: globals.noColor ? false : undefined });
  if (globals.help) {
    printHelp("apps update");
    return 0;
  }

  const appId = requireId(positionals[0], "app id", "testflight apps update <appId>");
  const patch = {
    name: stringValue(values, "name"),
    packageName: stringValue(values, "package"),
    description: stringValue(values, "description"),
    developer: stringValue(values, "developer"),
  };
  if (Object.values(patch).every((value) => value === undefined)) {
    throw new UsageError(
      "No fields to update.",
      "Pass at least one of --name, --package, --description or --developer.",
    );
  }

  const { api } = await createClient(globals, { requireKey: true });
  const app = await api.updateApp(appId, patch);

  if (globals.json) {
    printJson({ app });
    return 0;
  }
  success(`Updated app "${app.id}".`);
  return 0;
}

async function deleteApp(rest: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(
    rest,
    withGlobals({ yes: { type: "boolean", short: "y" } }),
  );
  const globals = readGlobals(values);
  configureOutput({ json: globals.json, color: globals.noColor ? false : undefined });
  if (globals.help) {
    printHelp("apps delete");
    return 0;
  }

  const appId = requireId(positionals[0], "app id", "testflight apps delete <appId>");
  await confirmDestructive(
    `Delete app "${appId}" and every version/APK it contains?`,
    booleanValue(values, "yes"),
  );

  const { api } = await createClient(globals, { requireKey: true });
  await api.deleteApp(appId);

  if (globals.json) {
    printJson({ deleted: true, appId });
    return 0;
  }
  success(`Deleted app "${appId}".`);
  return 0;
}

async function appIcon(rest: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(
    rest,
    withGlobals({
      file: { type: "string" },
      delete: { type: "boolean" },
    }),
  );
  const globals = readGlobals(values);
  configureOutput({ json: globals.json, color: globals.noColor ? false : undefined });
  if (globals.help) {
    printHelp("apps icon");
    return 0;
  }

  const appId = requireId(positionals[0], "app id", "testflight apps icon <appId>");
  const file = stringValue(values, "file");
  const remove = booleanValue(values, "delete");
  if (file && remove) {
    throw new UsageError("Use either --file or --delete, not both.");
  }
  if (!file && !remove) {
    throw new UsageError("Nothing to do.", "Pass --file <image> or --delete.");
  }

  const { api } = await createClient(globals, { requireKey: true });

  if (remove) {
    await api.deleteIcon(appId);
    if (globals.json) {
      printJson({ appId, iconPath: null });
    } else {
      success(`Removed the icon for "${appId}".`);
    }
    return 0;
  }

  const icon = await api.putIcon(appId, path.resolve(file!));
  if (globals.json) {
    printJson({ appId, iconPath: icon.iconPath });
  } else {
    success(`Uploaded the icon for "${appId}" → ${icon.iconPath}`);
  }
  return 0;
}

export async function runApps(argv: string[]): Promise<number> {
  const first = argv[0];
  const action = first && Object.hasOwn(ACTIONS, first) ? ACTIONS[first]! : "list";
  const rest = first && Object.hasOwn(ACTIONS, first) ? argv.slice(1) : argv;

  switch (action) {
    case "get":
      return getApp(rest);
    case "create":
      return createApp(rest);
    case "update":
      return updateApp(rest);
    case "delete":
      return deleteApp(rest);
    case "icon":
      return appIcon(rest);
    case "list":
      return listApps(rest);
  }
}
