import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Globals } from "../args.js";
import { TestflightApi } from "../api.js";
import { resolveSettings, type ResolvedSettings } from "../config.js";
import { CliError, UsageError } from "../errors.js";
import { confirm, isInteractive } from "../prompt.js";
import { joinUrl } from "../url.js";
import { isValidId, parsePositiveInteger } from "../validate.js";

export interface CommandClient {
  api: TestflightApi;
  settings: ResolvedSettings;
}

export async function createClient(
  globals: Globals,
  options: { requireKey?: boolean } = {},
): Promise<CommandClient> {
  const settings = await resolveSettings({
    profile: globals.profile,
    baseUrl: globals.baseUrl,
    key: globals.key,
    requireKey: options.requireKey ?? true,
  });
  return {
    api: new TestflightApi({
      baseUrl: settings.baseUrl,
      managementKey: settings.managementKey,
    }),
    settings,
  };
}

export function requireId(
  value: string | undefined,
  label: string,
  usage: string,
): string {
  if (value === undefined || value.length === 0) {
    throw new UsageError(`Missing ${label}.`, `Usage: ${usage}`);
  }
  if (!isValidId(value)) {
    throw new UsageError(
      `Invalid ${label} "${value}".`,
      "Use letters, digits, dots, dashes or underscores, starting with a letter or digit (max 64 characters).",
    );
  }
  return value;
}

export function parseVersionCode(raw: string | undefined): number {
  if (raw === undefined) throw new UsageError("Missing --version-code.");
  try {
    return parsePositiveInteger(raw, "--version-code");
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

export function parseOptionalMinSdk(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  try {
    return parsePositiveInteger(raw, "--min-sdk");
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

export async function resolveReleaseNotes(
  notes: string | undefined,
  notesFile: string | undefined,
): Promise<string | undefined> {
  if (notes !== undefined && notesFile !== undefined) {
    throw new UsageError("Use either --release-notes or --notes-file, not both.");
  }
  if (notes !== undefined) return notes;
  if (notesFile !== undefined) {
    const filePath = path.resolve(notesFile);
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      throw new CliError(
        `Cannot read the release notes file ${filePath}: ${(error as Error).message}`,
      );
    }
  }
  return undefined;
}

export function parsePublishedAt(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new UsageError(`Invalid --published-at "${raw}"; expected an ISO date.`);
  }
  return date.toISOString();
}

/** Confirms a destructive action, or requires --yes when stdin is not a TTY. */
export async function confirmDestructive(question: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (!isInteractive()) {
    throw new CliError("Confirmation required in a non-interactive session.", "Re-run with --yes.");
  }
  const accepted = await confirm(question, false);
  if (!accepted) throw new CliError("Cancelled.");
}

export function absoluteDownloadUrl(
  settings: ResolvedSettings,
  downloadPath: string | null,
): string | null {
  if (!downloadPath) return null;
  return joinUrl(settings.baseUrl, downloadPath);
}

export function formatAbiList(abis: readonly string[]): string {
  return abis.length > 0 ? abis.join(", ") : "-";
}
