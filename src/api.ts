import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Abi } from "./abi.js";
import { ApiError, CliError } from "./errors.js";
import { joinUrl } from "./url.js";

export interface ArtifactSummary {
  abi: Abi;
  sizeBytes: number;
  sha256: string | null;
  downloadPath: string;
}

export interface VersionSummary {
  versionName: string;
  versionCode: number;
  minSdk: number | null;
  releaseNotes: string | null;
  publishedAt: string;
  sizeBytes: number;
  sha256: string | null;
  downloadPath: string;
  abis: Abi[];
  universal: boolean;
  artifacts: ArtifactSummary[];
}

export interface VersionAdmin {
  versionName: string;
  versionCode: number;
  minSdk: number | null;
  releaseNotes: string | null;
  publishedAt: string;
  draft: boolean;
  abis: Abi[];
  universal: boolean;
  artifacts: (ArtifactSummary & { filename: string })[];
  defaultArtifact: (ArtifactSummary & { filename: string }) | null;
  sizeBytes: number | null;
  sha256: string | null;
  downloadPath: string | null;
}

export interface AppSummary {
  id: string;
  name: string;
  packageName: string;
  description: string;
  developer: string;
  iconPath: string | null;
  versionCount: number;
  latestVersion: VersionSummary | null;
}

export interface AppDetail extends AppSummary {
  versions: VersionSummary[];
}

export interface CreateAppInput {
  id: string;
  name?: string;
  packageName?: string;
  description?: string;
  developer?: string;
}

export interface UpdateAppInput {
  name?: string;
  packageName?: string;
  description?: string;
  developer?: string;
}

export interface CreateVersionInput {
  versionName: string;
  versionCode: number;
  minSdk?: number | null;
  releaseNotes?: string | null;
  publishedAt?: string | null;
}

export interface UpdateVersionInput {
  versionCode?: number;
  minSdk?: number | null;
  releaseNotes?: string | null;
  publishedAt?: string | null;
}

export interface UploadResult {
  abi: Abi;
  filePath: string;
  sizeBytes: number;
  sha256: string;
  serverSha256: string | null;
  verified: boolean;
  created: boolean;
  version: VersionAdmin;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  sha256: string;
  expectedSha256: string | null;
  verified: boolean | null;
  abi: Abi | null;
}

export interface ProbeResult {
  ok: boolean;
  status: number;
  code: string | null;
  message: string | null;
}

export interface ApiClientOptions {
  baseUrl: string;
  managementKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000;

function segment(value: string): string {
  return encodeURIComponent(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TestflightApi {
  readonly baseUrl: string;
  private readonly managementKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl;
    this.managementKey = options.managementKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private url(apiPath: string): string {
    return joinUrl(this.baseUrl, apiPath);
  }

  private authHeaders(): Record<string, string> {
    if (!this.managementKey) {
      throw new CliError(
        "This command changes data and needs a management key.",
        "Run `testflight login`, or set TESTFLIGHT_MANAGEMENT_KEY.",
      );
    }
    return { "x-management-key": this.managementKey };
  }

  private networkError(error: unknown): CliError {
    if (error instanceof CliError) return error;
    const name = (error as { name?: string } | undefined)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return new CliError(
        `The request to ${this.baseUrl} timed out after ${Math.round(this.timeoutMs / 1000)}s.`,
        "Check that the server is reachable and not overloaded.",
      );
    }
    return new CliError(
      `Cannot reach ${this.baseUrl}: ${errorMessage(error)}`,
      "Check the base URL, your network, and that the server is running.",
    );
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number = this.timeoutMs,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (error) {
      throw this.networkError(error);
    }
  }

  private async toApiError(response: Response): Promise<ApiError> {
    let raw = "";
    try {
      raw = await response.text();
    } catch {
      // Body may already be consumed or the connection may have dropped.
    }

    let payload: unknown;
    if (raw.length > 0) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = undefined;
      }
    }

    const record =
      typeof payload === "object" && payload !== null
        ? (payload as { error?: { code?: unknown; message?: unknown } })
        : undefined;
    const code =
      typeof record?.error?.code === "string" ? record.error.code : `http_${response.status}`;
    const message =
      typeof record?.error?.message === "string" && record.error.message.length > 0
        ? record.error.message
        : raw.trim() || response.statusText || `HTTP ${response.status}`;

    return new ApiError(response.status, code, message);
  }

  private async requestJson<T>(
    method: string,
    apiPath: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (method !== "GET" && method !== "HEAD") {
      Object.assign(headers, this.authHeaders());
    }
    if (body !== undefined) headers["content-type"] = "application/json";

    const response = await this.fetchWithTimeout(this.url(apiPath), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) throw await this.toApiError(response);
    try {
      return (await response.json()) as T;
    } catch {
      throw new CliError(`The server returned invalid JSON for ${method} ${apiPath}.`);
    }
  }

  private async requestNoContent(method: string, apiPath: string): Promise<void> {
    const response = await this.fetchWithTimeout(this.url(apiPath), {
      method,
      headers: this.authHeaders(),
    });
    if (!response.ok) throw await this.toApiError(response);
    // Drain a possible body so the socket can be reused.
    await response.arrayBuffer().catch(() => undefined);
  }

  async health(): Promise<{ status: string }> {
    const response = await this.fetchWithTimeout(this.url("/api/v1/health"), {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw await this.toApiError(response);
    const payload = (await response.json()) as { status?: unknown };
    return { status: typeof payload.status === "string" ? payload.status : "unknown" };
  }

  /**
   * Checks the management key with a harmless write request: authentication
   * runs before body validation, so `400` means the key was accepted, `401`
   * means it was rejected. Nothing is created.
   */
  async probeManagementKey(): Promise<ProbeResult> {
    const response = await this.fetchWithTimeout(
      this.url("/api/v1/apps/__testflight_cli_probe__"),
      {
        method: "PUT",
        headers: {
          ...(this.managementKey ? { "x-management-key": this.managementKey } : {}),
          "content-type": "application/json",
          accept: "application/json",
        },
        body: "{}",
      },
    );

    if (response.ok || response.status === 400) {
      await response.arrayBuffer().catch(() => undefined);
      return { ok: true, status: response.status, code: null, message: null };
    }
    const error = await this.toApiError(response);
    return {
      ok: false,
      status: error.status,
      code: error.code,
      message: error.message,
    };
  }

  async listApps(): Promise<AppSummary[]> {
    const payload = await this.requestJson<{ apps?: AppSummary[] }>("GET", "/api/v1/apps");
    return payload.apps ?? [];
  }

  async getApp(appId: string): Promise<AppDetail> {
    const payload = await this.requestJson<{ app: AppDetail }>(
      "GET",
      `/api/v1/apps/${segment(appId)}`,
    );
    return payload.app;
  }

  async findApp(appId: string): Promise<AppDetail | null> {
    try {
      return await this.getApp(appId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }

  async createApp(input: CreateAppInput): Promise<AppDetail> {
    const payload = await this.requestJson<{ app: AppDetail }>(
      "POST",
      "/api/v1/apps",
      input,
    );
    return payload.app;
  }

  async updateApp(appId: string, patch: UpdateAppInput): Promise<AppDetail> {
    const payload = await this.requestJson<{ app: AppDetail }>(
      "PUT",
      `/api/v1/apps/${segment(appId)}`,
      patch,
    );
    return payload.app;
  }

  async deleteApp(appId: string): Promise<void> {
    await this.requestNoContent("DELETE", `/api/v1/apps/${segment(appId)}`);
  }

  async putIcon(appId: string, filePath: string): Promise<{ iconPath: string }> {
    const type =
      {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
      }[path.extname(filePath).toLowerCase()] ?? null;
    if (!type) {
      throw new CliError(
        `Unsupported icon type "${path.extname(filePath) || "(none)"}".`,
        "Use a PNG, JPEG or WebP file.",
      );
    }

    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) throw new CliError(`Icon not found: ${filePath}`);
    if (info.size > 2 * 1024 * 1024) {
      throw new CliError(`Icon is ${info.size} bytes; the server limit is 2 MiB.`);
    }

    const data = await readFile(filePath);
    const response = await this.fetchWithTimeout(
      this.url(`/api/v1/apps/${segment(appId)}/icon`),
      {
        method: "PUT",
        headers: {
          ...this.authHeaders(),
          "content-type": type,
          "content-length": String(data.byteLength),
          accept: "application/json",
        },
        body: new Uint8Array(data),
      },
    );
    if (!response.ok) throw await this.toApiError(response);
    return (await response.json()) as { iconPath: string };
  }

  async deleteIcon(appId: string): Promise<void> {
    await this.requestNoContent("DELETE", `/api/v1/apps/${segment(appId)}/icon`);
  }

  async listVersionsAdmin(appId: string): Promise<VersionAdmin[]> {
    const payload = await this.requestJson<{ versions?: VersionAdmin[] }>(
      "GET",
      `/api/v1/apps/${segment(appId)}/versions`,
    );
    return payload.versions ?? [];
  }

  async getVersionAdmin(appId: string, versionName: string): Promise<VersionAdmin> {
    const payload = await this.requestJson<{ version: VersionAdmin }>(
      "GET",
      `/api/v1/apps/${segment(appId)}/versions/${segment(versionName)}`,
    );
    return payload.version;
  }

  async findVersionAdmin(
    appId: string,
    versionName: string,
  ): Promise<VersionAdmin | null> {
    const versions = await this.listVersionsAdmin(appId);
    return versions.find((version) => version.versionName === versionName) ?? null;
  }

  async createVersion(appId: string, input: CreateVersionInput): Promise<VersionAdmin> {
    const payload = await this.requestJson<{ version: VersionAdmin }>(
      "POST",
      `/api/v1/apps/${segment(appId)}/versions`,
      input,
    );
    return payload.version;
  }

  async updateVersion(
    appId: string,
    versionName: string,
    patch: UpdateVersionInput,
  ): Promise<VersionAdmin> {
    const payload = await this.requestJson<{ version: VersionAdmin }>(
      "PUT",
      `/api/v1/apps/${segment(appId)}/versions/${segment(versionName)}`,
      patch,
    );
    return payload.version;
  }

  async deleteVersion(appId: string, versionName: string): Promise<void> {
    await this.requestNoContent(
      "DELETE",
      `/api/v1/apps/${segment(appId)}/versions/${segment(versionName)}`,
    );
  }

  async deleteArtifact(appId: string, versionName: string, abi: Abi): Promise<void> {
    await this.requestNoContent(
      "DELETE",
      `/api/v1/apps/${segment(appId)}/versions/${segment(versionName)}/artifacts/${segment(abi)}`,
    );
  }

  async uploadArtifact(
    appId: string,
    versionName: string,
    abi: Abi,
    filePath: string,
    hooks: { onProgress?: (uploaded: number, total: number) => void } = {},
  ): Promise<UploadResult> {
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) throw new CliError(`APK not found: ${filePath}`);
    if (info.size === 0) throw new CliError(`APK is empty: ${filePath}`);

    const hash = createHash("sha256");
    let uploaded = 0;

    const source = createReadStream(filePath);
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        uploaded += chunk.length;
        hooks.onProgress?.(uploaded, info.size);
        callback(null, chunk);
      },
    });

    // Resolve when the readable side has been consumed (success or failure) so
    // the SHA-256 is complete before we digest it.
    const finished = new Promise<void>((resolve) => {
      meter.once("end", resolve);
      meter.once("close", resolve);
      meter.once("error", resolve);
    });
    void finished.catch(() => undefined);

    source.once("error", (error) => meter.destroy(error));
    source.pipe(meter);

    let response: Response;
    try {
      const init = {
        method: "PUT",
        headers: {
          ...this.authHeaders(),
          "content-type": "application/vnd.android.package-archive",
          "content-length": String(info.size),
          accept: "application/json",
        },
        body: Readable.toWeb(meter) as unknown as RequestInit["body"],
        duplex: "half",
      } as RequestInit & { duplex: "half" };
      response = await this.fetchImpl(
        this.url(
          `/api/v1/apps/${segment(appId)}/versions/${segment(versionName)}/artifacts/${segment(abi)}`,
        ),
        init,
      );
    } catch (error) {
      source.destroy();
      meter.destroy();
      throw this.networkError(error);
    }

    if (!response.ok) {
      source.destroy();
      meter.destroy();
      throw await this.toApiError(response);
    }

    await finished;
    const sha256 = hash.digest("hex");

    let payload: { version?: VersionAdmin };
    try {
      payload = (await response.json()) as { version?: VersionAdmin };
    } catch {
      throw new CliError("The server accepted the APK but returned an invalid response.");
    }
    if (!payload.version) {
      throw new CliError("The server accepted the APK but returned no version details.");
    }

    const artifact = payload.version.artifacts.find((entry) => entry.abi === abi) ?? null;
    const serverSha256 = artifact?.sha256 ?? null;

    return {
      abi,
      filePath,
      sizeBytes: info.size,
      sha256,
      serverSha256,
      verified: serverSha256 === null ? true : serverSha256.toLowerCase() === sha256,
      created: response.status === 201,
      version: payload.version,
    };
  }

  async downloadArtifact(
    appId: string,
    versionName: string,
    abi: Abi | null,
    destination: string,
    hooks: { onProgress?: (downloaded: number, total: number) => void } = {},
  ): Promise<DownloadResult> {
    const query = abi ? `?abi=${segment(abi)}` : "";
    const response = await this.fetchWithTimeout(
      this.url(
        `/api/v1/apps/${segment(appId)}/versions/${segment(versionName)}/download${query}`,
      ),
      {
        headers: { accept: "application/vnd.android.package-archive" },
      },
      DOWNLOAD_TIMEOUT_MS,
    );

    if (!response.ok) throw await this.toApiError(response);
    if (!response.body) throw new CliError("The server returned an empty APK body.");

    const expectedSha256 = response.headers.get("x-checksum-sha256");
    const headerLength = Number(response.headers.get("content-length") ?? "");
    const total = Number.isFinite(headerLength) && headerLength > 0 ? headerLength : 0;

    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.part-${process.pid}-${Date.now()}`;
    const hash = createHash("sha256");
    let bytes = 0;

    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        bytes += chunk.length;
        hooks.onProgress?.(bytes, total);
        callback(null, chunk);
      },
    });

    const body = Readable.fromWeb(
      response.body as unknown as NodeReadableStream<Uint8Array>,
    );

    try {
      await pipeline(body, meter, createWriteStream(temporary));
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new CliError(
        `Download failed: ${errorMessage(error)}`,
        "Check the connection and try again; existing files were not modified.",
      );
    }

    const sha256 = hash.digest("hex");
    if (expectedSha256 && expectedSha256.toLowerCase() !== sha256) {
      await unlink(temporary).catch(() => undefined);
      throw new CliError(
        "The downloaded APK does not match the server's SHA-256 checksum.",
        "The file was discarded. Retry the download; if it keeps failing, re-upload the APK.",
      );
    }

    await rename(temporary, destination);

    return {
      path: destination,
      bytes,
      sha256,
      expectedSha256,
      verified: expectedSha256 ? true : null,
      abi,
    };
  }
}
