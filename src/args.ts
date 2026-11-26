import { parseArgs } from "node:util";
import { UsageError } from "./errors.js";

export interface OptionSpec {
  type: "string" | "boolean";
  short?: string;
  multiple?: boolean;
  default?: string | boolean | string[] | boolean[];
}

export type OptionMap = Record<string, OptionSpec>;

export type ParsedValues = Record<string, string | boolean | string[] | undefined>;

export interface ParsedCommand {
  values: ParsedValues;
  positionals: string[];
}

export function parseCommandArgs(argv: string[], options: OptionMap = {}): ParsedCommand {
  try {
    const parsed = parseArgs({
      args: argv,
      options,
      allowPositionals: true,
      strict: true,
      tokens: false,
    });
    return {
      values: parsed.values as ParsedValues,
      positionals: parsed.positionals,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(
      message,
      "Run `testflight --help`, or `testflight <command> --help`, for usage.",
    );
  }
}

export function stringValue(values: ParsedValues, name: string): string | undefined {
  const value = values[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new UsageError(`--${name} expects a value.`);
  }
  return value;
}

export function booleanValue(values: ParsedValues, name: string): boolean {
  const value = values[name];
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new UsageError(`--${name} does not take a value.`);
  }
  return value;
}

export function listValue(values: ParsedValues, name: string): string[] {
  const value = values[name];
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  throw new UsageError(`--${name} expects one or more values.`);
}

/** Splits comma-separated repeats, so `--abi a,b` behaves like `--abi a --abi b`. */
export function expandCsv(values: string[]): string[] {
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export const GLOBAL_OPTIONS: OptionMap = {
  json: { type: "boolean" },
  profile: { type: "string", short: "p" },
  "base-url": { type: "string" },
  key: { type: "string" },
  verbose: { type: "boolean" },
  "no-color": { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

export function withGlobals(extra: OptionMap = {}): OptionMap {
  return { ...GLOBAL_OPTIONS, ...extra };
}

export interface Globals {
  json: boolean;
  profile: string | undefined;
  baseUrl: string | undefined;
  key: string | undefined;
  verbose: boolean;
  noColor: boolean;
  help: boolean;
}

export function readGlobals(values: ParsedValues): Globals {
  return {
    json: booleanValue(values, "json"),
    profile: stringValue(values, "profile"),
    baseUrl: stringValue(values, "base-url"),
    key: stringValue(values, "key"),
    verbose: booleanValue(values, "verbose"),
    noColor: booleanValue(values, "no-color"),
    help: booleanValue(values, "help"),
  };
}

export function requirePositionals(
  positionals: string[],
  expected: number,
  usage: string,
): string[] {
  if (positionals.length !== expected) {
    throw new UsageError(
      `Expected ${expected} argument${expected === 1 ? "" : "s"}, got ${positionals.length}.`,
      `Usage: ${usage}`,
    );
  }
  return positionals;
}
