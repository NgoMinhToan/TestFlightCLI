import { existsSync } from "node:fs";
import path from "node:path";

let loaded = false;

/**
 * Loads a `.env` file from the working directory, if present. Values already
 * present in the environment are not overwritten, and a malformed file is
 * ignored so it can never break a command.
 */
export function loadDotEnv(cwd: string = process.cwd()): void {
  if (loaded) return;
  loaded = true;

  const file = path.join(cwd, ".env");
  if (!existsSync(file)) return;

  const loadEnvFile = (
    process as NodeJS.Process & { loadEnvFile?: (filePath: string) => void }
  ).loadEnvFile;
  if (typeof loadEnvFile !== "function") return;
  try {
    loadEnvFile.call(process, file);
  } catch {
    // Ignore malformed .env files; explicit flags and real env vars still work.
  }
}
