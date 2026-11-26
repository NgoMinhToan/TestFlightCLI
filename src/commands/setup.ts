import { booleanValue, parseCommandArgs, readGlobals, stringValue, withGlobals } from "../args.js";
import { TestflightApi } from "../api.js";
import {
  configFileMode,
  configPath,
  deleteConfigFile,
  readConfigFile,
  removeProfile,
  requireProfileName,
  resolveSettings,
  saveProfile,
  setDefaultProfile,
  type ResolvedSettings,
} from "../config.js";
import { CliError, UsageError } from "../errors.js";
import { printHelp } from "../help.js";
import {
  configureOutput,
  heading,
  info,
  line,
  maskKey,
  note,
  paint,
  printJson,
  printTable,
  success,
  warn,
} from "../output.js";
import { isInteractive, promptText, readStdin } from "../prompt.js";
import { normalizeBaseUrl } from "../url.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runLogin(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(
    argv,
    withGlobals({
      url: { type: "string", short: "u" },
      key: { type: "string", short: "k" },
      "key-stdin": { type: "boolean" },
      "no-verify": { type: "boolean" },
    }),
  );
  const globals = readGlobals(values);
  configureOutput({ json: globals.json, color: globals.noColor ? false : undefined });
  if (globals.help) {
    printHelp("login");
    return 0;
  }
  if (positionals.length > 1) {
    throw new UsageError(
      "Too many arguments.",
      "Usage: testflight login [url] [--url <url>] [--key <key>]",
    );
  }

  const env = process.env;
  const filePath = configPath(env);
  const config = await readConfigFile(filePath);
  const profileName = requireProfileName(
    globals.profile ?? env.TESTFLIGHT_PROFILE?.trim() ?? config.defaultProfile,
  );
  const existing = config.profiles[profileName];

  let baseUrlRaw =
    stringValue(values, "url") ??
    positionals[0] ??
    env.TESTFLIGHT_BASE_URL?.trim() ??
    existing?.baseUrl;

  if (!baseUrlRaw) {
    if (!isInteractive()) {
      throw new UsageError(
        "A server base URL is required.",
        "Pass --url <url>, or set TESTFLIGHT_BASE_URL.",
      );
    }
    baseUrlRaw = await promptText("Server base URL", {
      defaultValue: "http://127.0.0.1:8080",
    });
  }
  const baseUrl = normalizeBaseUrl(baseUrlRaw);

  let managementKey = stringValue(values, "key");
  if (managementKey === undefined && booleanValue(values, "key-stdin")) {
    managementKey = (await readStdin()).trim();
    if (managementKey.length === 0) {
      throw new UsageError("stdin did not contain a management key.");
    }
  }
  if (managementKey === undefined && isInteractive()) {
    const label = existing
      ? "Management key (leave blank to keep the saved key)"
      : "Management key";
    const answer = await promptText(label, { hidden: true });
    if (answer.length > 0) managementKey = answer;
  }
  managementKey =
    managementKey ??
    env.TESTFLIGHT_MANAGEMENT_KEY?.trim() ??
    existing?.managementKey;

  if (!managementKey) {
    throw new UsageError(
      "A management key is required.",
      "Pass --key, --key-stdin, or set TESTFLIGHT_MANAGEMENT_KEY. Find it in data/config.json on the server.",
    );
  }

  if (!booleanValue(values, "no-verify")) {
    const api = new TestflightApi({ baseUrl, managementKey });
    try {
      await api.health();
    } catch (error) {
      const message =
        error instanceof CliError
          ? error.message
          : `Cannot verify ${baseUrl}: ${errorMessage(error)}`;
      throw new CliError(message, "Pass --no-verify to save the settings anyway.");
    }
    const probe = await api.probeManagementKey();
    if (!probe.ok) {
      const hint =
        probe.code === "management_key_not_configured"
          ? "The server has no management_key yet; start it once so it creates data/config.json."
          : "Copy the management_key value from data/config.json on the server.";
      throw new CliError(
        `The management key was not accepted (${probe.status} ${probe.code ?? "error"}).`,
        hint,
      );
    }
  }

  const saved = await saveProfile({
    name: profileName,
    baseUrl,
    managementKey,
    filePath,
  });

  if (globals.json) {
    printJson({
      profile: profileName,
      baseUrl,
      configPath: filePath,
      created: saved.created,
      key: maskKey(managementKey),
    });
    return 0;
  }

  success(`${saved.created ? "Created" : "Updated"} profile "${profileName}" → ${baseUrl}`);
  info(`Config: ${filePath}`);
  info(`Key: ${maskKey(managementKey)}`);
  note("Next: testflight apps list");
  return 0;
}

export async function runLogout(argv: string[]): Promise<number> {
  const { values } = parseCommandArgs(
    argv,
    withGlobals({ all: { type: "boolean" } }),
  );
  const globals = readGlobals(values);
  configureOutput({ json: globals.json, color: globals.noColor ? false : undefined });
  if (globals.help) {
    printHelp("logout");
    return 0;
  }

  const filePath = configPath();
  if (booleanValue(values, "all")) {
    await deleteConfigFile(filePath);
    if (globals.json) {
      printJson({ removed: "all", configPath: filePath });
      return 0;
    }
    success(`Removed all saved credentials (${filePath}).`);
    return 0;
  }

  const config = await readConfigFile(filePath);
  const name =
    globals.profile ?? process.env.TESTFLIGHT_PROFILE?.trim() ?? config.defaultProfile;
  const removed = await removeProfile(name, filePath);

  if (!removed) {
    throw new CliError(
      `No saved profile "${name}".`,
      "Run `testflight whoami` to see the active profile, or `testflight logout --all`.",
    );
  }

  if (globals.json) {
    printJson({ removed: name, configPath: filePath });
    return 0;
  }
  success(`Removed profile "${name}".`);
  return 0;
}

export async function runWhoami(argv: string[]): Promise<number> {
  const { values } = parseCommandArgs(argv, withGlobals());
  const globals = readGlobals(values);
  configureOutput({ json: globals.json, color: globals.noColor ? false : undefined });
  if (globals.help) {
    printHelp("whoami");
    return 0;
  }

  const settings = await resolveSettings({
    profile: globals.profile,
    baseUrl: globals.baseUrl,
    key: globals.key,
    requireKey: false,
  });

  if (globals.json) {
    printJson({
      profile: settings.profile,
      baseUrl: settings.baseUrl,
      configPath: settings.configPath,
      key: maskKey(settings.managementKey),
      hasKey: Boolean(settings.managementKey),
      sources: settings.sources,
    });
    return 0;
  }

  heading(`Profile: ${settings.profile}`);
  line(`  Server: ${settings.baseUrl}`);
  line(`  Key:    ${maskKey(settings.managementKey)}`);
  line(`  Config: ${settings.configPath}`);
  if (settings.sources.length > 0) {
    line(`  Source: ${settings.sources.join(", ")}`);
  }
  if (!settings.managementKey) {
    warn("No management key is available; write commands will fail until you log in.");
  }
  return 0;
}

export async function runConfig(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, withGlobals());
  const globals = readGlobals(values);
  configureOutput({ json: globals.json, color: globals.noColor ? false : undefined });
  if (globals.help) {
    printHelp("config");
    return 0;
  }

  const action = positionals[0] ?? "list";
  const filePath = configPath();
  const config = await readConfigFile(filePath);

  if (action === "path") {
    if (globals.json) {
      printJson({ configPath: filePath });
    } else {
      line(filePath);
    }
    return 0;
  }

  if (action === "use") {
    const name = positionals[1];
    if (!name) {
      throw new UsageError("Missing profile name.", "Usage: testflight config use <profile>");
    }
    await setDefaultProfile(name, filePath);
    if (globals.json) {
      printJson({ defaultProfile: name, configPath: filePath });
    } else {
      success(`Default profile is now "${name}".`);
    }
    return 0;
  }

  if (action !== "list") {
    throw new UsageError(
      `Unknown config action "${action}".`,
      "Usage: testflight config [list|path|use <profile>]",
    );
  }

  const names = Object.keys(config.profiles).sort();
  const rows = names.map((name) => [
    name === config.defaultProfile ? `${name} *` : name,
    config.profiles[name]!.baseUrl,
    maskKey(config.profiles[name]!.managementKey),
  ]);

  if (globals.json) {
    printJson({
      configPath: filePath,
      defaultProfile: config.defaultProfile,
      profiles: names.map((name) => ({
        name,
        baseUrl: config.profiles[name]!.baseUrl,
        key: maskKey(config.profiles[name]!.managementKey),
        default: name === config.defaultProfile,
      })),
    });
    return 0;
  }

  heading(`Config: ${filePath}`);
  line();
  if (rows.length === 0) {
    info("No profiles saved yet. Run `testflight login`.");
    return 0;
  }
  printTable(["PROFILE", "SERVER", "KEY"], rows);
  info("* = default profile");
  return 0;
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(argv: string[]): Promise<number> {
  const { values } = parseCommandArgs(argv, withGlobals());
  const globals = readGlobals(values);
  configureOutput({ json: globals.json, color: globals.noColor ? false : undefined });
  if (globals.help) {
    printHelp("doctor");
    return 0;
  }

  const filePath = configPath();
  const checks: DoctorCheck[] = [];

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    ok: nodeMajor >= 22,
    detail: `Node.js ${process.version}${nodeMajor >= 22 ? "" : " (22+ required)"}`,
  });

  const mode = await configFileMode(filePath);

  let settings: ResolvedSettings | null = null;
  try {
    settings = await resolveSettings({
      profile: globals.profile,
      baseUrl: globals.baseUrl,
      key: globals.key,
      requireKey: false,
    });
    checks.push({
      name: "settings",
      ok: true,
      detail: `${settings.baseUrl} (profile "${settings.profile}")`,
    });
  } catch (error) {
    checks.push({ name: "settings", ok: false, detail: errorMessage(error) });
  }

  const usingEnvironment = mode === null && settings !== null;
  checks.push({
    name: "config",
    ok: mode !== null || usingEnvironment,
    detail:
      mode !== null
        ? filePath
        : usingEnvironment
          ? "environment variables (no saved config file)"
          : `${filePath} (not found; run testflight login)`,
  });
  if (mode !== null && process.platform !== "win32") {
    const isPrivate = (mode & 0o077) === 0;
    checks.push({
      name: "config-perms",
      ok: isPrivate,
      detail: isPrivate
        ? `0o${mode.toString(8)} (private)`
        : `0o${mode.toString(8)} is readable by others; run chmod 600`,
    });
  }

  if (settings) {
    const api = new TestflightApi({
      baseUrl: settings.baseUrl,
      managementKey: settings.managementKey,
    });

    try {
      const startedAt = Date.now();
      const health = await api.health();
      checks.push({
        name: "health",
        ok: health.status === "ok",
        detail: `${health.status} in ${Date.now() - startedAt} ms`,
      });
    } catch (error) {
      checks.push({ name: "health", ok: false, detail: errorMessage(error) });
    }

    if (!settings.managementKey) {
      checks.push({
        name: "management-key",
        ok: false,
        detail: "no key saved; run testflight login",
      });
    } else {
      try {
        const probe = await api.probeManagementKey();
        checks.push({
          name: "management-key",
          ok: probe.ok,
          detail: probe.ok
            ? `accepted (${maskKey(settings.managementKey)})`
            : `${probe.status} ${probe.code ?? "error"}: ${probe.message ?? "rejected"}`,
        });
      } catch (error) {
        checks.push({ name: "management-key", ok: false, detail: errorMessage(error) });
      }
    }
  }

  const ok = checks.every((check) => check.ok);

  if (globals.json) {
    printJson({
      ok,
      configPath: filePath,
      baseUrl: settings?.baseUrl ?? null,
      profile: settings?.profile ?? null,
      checks,
    });
    return ok ? 0 : 1;
  }

  heading("MyTestflight CLI doctor");
  line();
  for (const check of checks) {
    const mark = check.ok ? paint("green", "✓") : paint("red", "✗");
    line(`${mark} ${check.name.padEnd(15)} ${check.detail}`);
  }
  line();
  if (ok) {
    success("Everything looks good.");
  } else {
    info("Fix the failed checks above. `testflight login` usually solves the last two.");
  }
  return ok ? 0 : 1;
}

