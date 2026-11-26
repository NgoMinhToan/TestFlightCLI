import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { CliError, UsageError } from "./errors.js";
import { normalizeBaseUrl } from "./url.js";

export interface Profile {
  baseUrl: string;
  managementKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConfigFile {
  version: 1;
  defaultProfile: string;
  profiles: Record<string, Profile>;
}

export interface ResolvedSettings {
  baseUrl: string;
  managementKey: string | undefined;
  profile: string;
  configPath: string;
  /** Which inputs supplied the base URL and key, for `whoami`/`doctor`. */
  sources: string[];
}

export interface SettingsOverrides {
  profile?: string;
  baseUrl?: string;
  key?: string;
  requireKey?: boolean;
}

export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TESTFLIGHT_CONFIG?.trim();
  if (override) return path.resolve(override);

  if (process.platform === "win32" && env.APPDATA?.trim()) {
    return path.join(env.APPDATA.trim(), "testflight", "config.json");
  }
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), ".config");
  return path.join(base, "testflight", "config.json");
}

export function emptyConfig(): ConfigFile {
  return { version: 1, defaultProfile: "default", profiles: {} };
}

export async function readConfigFile(filePath: string = configPath()): Promise<ConfigFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyConfig();
    throw new CliError(
      `Cannot read the config file at ${filePath}: ${(error as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(
      `The config file at ${filePath} is not valid JSON.`,
      `Fix or delete it, then run \`testflight login\` again.`,
    );
  }

  if (!isRecord(parsed)) return emptyConfig();

  const profiles: Record<string, Profile> = {};
  const rawProfiles = isRecord(parsed.profiles) ? parsed.profiles : {};
  for (const [name, value] of Object.entries(rawProfiles)) {
    if (!isRecord(value)) continue;
    if (typeof value.baseUrl !== "string" || typeof value.managementKey !== "string") continue;
    const createdAt =
      typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString();
    profiles[name] = {
      baseUrl: value.baseUrl,
      managementKey: value.managementKey,
      createdAt,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : createdAt,
    };
  }

  const defaultProfile =
    typeof parsed.defaultProfile === "string" && parsed.defaultProfile.length > 0
      ? parsed.defaultProfile
      : "default";

  return { version: 1, defaultProfile, profiles };
}

export async function writeConfigFile(
  filePath: string,
  config: ConfigFile,
): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const temporary = `${filePath}.tmp-${randomBytes(6).toString("hex")}`;
  const data = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(temporary, data, { mode: 0o600 });
  try {
    await chmod(temporary, 0o600);
  } catch {
    // Non-POSIX platforms: the file exists, permissions are the best we can do.
  }

  try {
    await rename(temporary, filePath);
  } catch (error) {
    // Windows cannot atomically replace an existing file with rename().
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM") {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await unlink(filePath).catch(() => undefined);
    await rename(temporary, filePath);
  }
}

export function requireProfileName(name: string): string {
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new UsageError(
      `Invalid profile name "${name}".`,
      "Use letters, digits, dots, dashes or underscores (max 64 characters).",
    );
  }
  return name;
}

export async function saveProfile(options: {
  name: string;
  baseUrl: string;
  managementKey: string;
  filePath?: string;
}): Promise<{ filePath: string; created: boolean }> {
  const filePath = options.filePath ?? configPath();
  const name = requireProfileName(options.name);
  const config = await readConfigFile(filePath);
  const now = new Date().toISOString();
  const existing = config.profiles[name];
  const wasEmpty = Object.keys(config.profiles).length === 0;

  config.profiles[name] = {
    baseUrl: options.baseUrl,
    managementKey: options.managementKey,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (wasEmpty || !config.profiles[config.defaultProfile]) {
    config.defaultProfile = name;
  }
  config.version = 1;

  await writeConfigFile(filePath, config);
  return { filePath, created: existing === undefined };
}

export async function removeProfile(
  name: string,
  filePath: string = configPath(),
): Promise<boolean> {
  const config = await readConfigFile(filePath);
  if (!config.profiles[name]) return false;
  delete config.profiles[name];

  if (config.defaultProfile === name) {
    const remaining = Object.keys(config.profiles).sort();
    config.defaultProfile = remaining[0] ?? "default";
  }
  await writeConfigFile(filePath, config);
  return true;
}

export async function setDefaultProfile(
  name: string,
  filePath: string = configPath(),
): Promise<void> {
  const config = await readConfigFile(filePath);
  if (!config.profiles[name]) {
    const known = Object.keys(config.profiles);
    throw new UsageError(
      `Unknown profile "${name}".`,
      known.length > 0
        ? `Known profiles: ${known.join(", ")}.`
        : "No profiles saved yet. Run `testflight login` first.",
    );
  }
  config.defaultProfile = name;
  await writeConfigFile(filePath, config);
}

export async function deleteConfigFile(filePath: string = configPath()): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function configFileMode(filePath: string): Promise<number | null> {
  try {
    const info = await stat(filePath);
    return info.mode & 0o777;
  } catch {
    return null;
  }
}

/**
 * Resolves the base URL and management key from (in order of precedence)
 * command-line flags, environment variables, and the saved profile.
 */
export async function resolveSettings(
  overrides: SettingsOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedSettings> {
  const filePath = configPath(env);
  const config = await readConfigFile(filePath);
  const explicitProfile = overrides.profile ?? env.TESTFLIGHT_PROFILE?.trim();
  const profileName = explicitProfile ?? config.defaultProfile;
  const profile = config.profiles[profileName];

  if (explicitProfile && !profile) {
    const known = Object.keys(config.profiles);
    throw new CliError(
      `Unknown profile "${profileName}".`,
      known.length > 0
        ? `Known profiles: ${known.join(", ")}.`
        : "No profiles saved yet. Run `testflight login` first.",
    );
  }

  const sources: string[] = [];
  let baseUrlRaw: string | undefined;
  if (overrides.baseUrl) {
    baseUrlRaw = overrides.baseUrl;
    sources.push("--base-url");
  } else if (env.TESTFLIGHT_BASE_URL?.trim()) {
    baseUrlRaw = env.TESTFLIGHT_BASE_URL.trim();
    sources.push("TESTFLIGHT_BASE_URL");
  } else if (profile) {
    baseUrlRaw = profile.baseUrl;
    sources.push(`profile "${profileName}"`);
  }

  let managementKey: string | undefined;
  if (overrides.key) {
    managementKey = overrides.key;
    sources.push("--key");
  } else if (env.TESTFLIGHT_MANAGEMENT_KEY?.trim()) {
    managementKey = env.TESTFLIGHT_MANAGEMENT_KEY.trim();
    sources.push("TESTFLIGHT_MANAGEMENT_KEY");
  } else if (profile) {
    managementKey = profile.managementKey;
  }

  if (!baseUrlRaw) {
    throw new CliError(
      "No MyTestflight server is configured.",
      "Run `testflight login`, or set TESTFLIGHT_BASE_URL and TESTFLIGHT_MANAGEMENT_KEY.",
    );
  }
  if (overrides.requireKey === true && !managementKey) {
    throw new CliError(
      `No management key is available for profile "${profileName}".`,
      "Run `testflight login`, or set TESTFLIGHT_MANAGEMENT_KEY for CI.",
    );
  }

  return {
    baseUrl: normalizeBaseUrl(baseUrlRaw),
    managementKey,
    profile: profileName,
    configPath: filePath,
    sources,
  };
}
