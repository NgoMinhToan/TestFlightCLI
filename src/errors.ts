/** Errors that map to a friendly CLI message and a process exit code. */
export class CliError extends Error {
  readonly exitCode: number;
  readonly hint: string | undefined;

  constructor(
    message: string,
    options: { exitCode?: number; hint?: string } | string = {},
  ) {
    super(message);
    const config = typeof options === "string" ? { hint: options } : options;
    this.name = "CliError";
    this.exitCode = config.exitCode ?? 1;
    this.hint = config.hint;
  }
}

/** Bad flags or arguments: exit code 2, like most Unix tools. */
export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, { exitCode: 2, hint });
    this.name = "UsageError";
  }
}

/** An error response from the server, decoded from `{ error: { code, message } }`. */
export class ApiError extends CliError {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string, hint?: string) {
    super(message, hint);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function isApiError(error: unknown, status?: number): error is ApiError {
  return error instanceof ApiError && (status === undefined || error.status === status);
}

export function apiErrorHint(error: ApiError): string | undefined {
  switch (error.code) {
    case "invalid_management_key":
      return "The management key was rejected. Run `testflight login` to save the key again.";
    case "management_key_not_configured":
      return "The server has no management_key yet. Start it once so it can create data/config.json.";
    case "app_not_found":
      return "Check the id with `testflight apps list`.";
    case "version_not_found":
      return "Check the version with `testflight versions list <appId>`.";
    case "artifact_not_found":
      return "Check the version's ABIs with `testflight versions abis <appId> <versionName>`.";
    case "icon_not_found":
      return "The app has no icon yet.";
    case "app_exists":
      return "Use `testflight apps update <appId>` to change it.";
    case "package_in_use":
      return "Another app already uses this Android package. Pick a different package, or update the other app first.";
    case "package_locked":
      return "An app that already has uploaded APKs cannot change package. Delete its versions first, or use a new app id.";
    case "version_name_invalid":
      return "Use 1-200 UTF-8 bytes with no path separators (/ or \\), control characters, or leading/trailing spaces and dots. Spaces, '+', parentheses and Unicode are allowed.";
    case "version_exists":
      return "Re-run with --force to replace the existing version, or publish a new --version.";
    case "payload_too_large":
      return "The upload is larger than the server's MAX_APK_BYTES (or 2 MiB for icons).";
    case "unsupported_media_type":
      return "The server accepts APKs and PNG/JPEG/WebP icons only.";
    case "invalid_apk":
      return "The file is not a readable APK, its AndroidManifest.xml is missing or corrupt, or it uses ZIP64.";
    case "apk_metadata_mismatch":
      return "The APK does not match the app/version it is uploaded to. Fix the build, or pass --allow-mismatch with the fields above.";
    case "invalid_request":
      return "Run the command with --help to check the arguments.";
    default:
      return undefined;
  }
}
