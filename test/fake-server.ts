import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ABI_PRIORITY } from "../src/abi.js";
import {
  inspectApkBuffer,
  type DetectedApk,
  type MismatchKind,
} from "../src/apk-manifest.js";
import { isValidVersionName } from "../src/validate.js";

interface FakeArtifact {
  abi: string;
  bytes: Buffer;
  sha256: string;
  filename: string;
}

interface FakeVersion {
  versionName: string;
  versionCode: number;
  minSdk: number | null;
  releaseNotes: string | null;
  publishedAt: string;
  artifacts: Map<string, FakeArtifact>;
}

interface FakeApp {
  id: string;
  name: string;
  packageName: string;
  description: string;
  developer: string;
  icon: { type: string; bytes: Buffer } | null;
  versions: Map<string, FakeVersion>;
}

export interface RecordedUpload {
  path: string;
  abi: string | null;
  allowMismatch: string | null;
}

export interface RecordedImport {
  searchParams: Record<string, string>;
  abi: string;
  sha256: string;
}

export interface FakeServer {
  url: string;
  key: string;
  apps: Map<string, FakeApp>;
  uploads: RecordedUpload[];
  imports: RecordedImport[];
  close: () => Promise<void>;
}

const KEY = "test-management-key";

function humanize(id: string): string {
  return id
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const abiRank = (abi: string): number => {
  const index = ABI_PRIORITY.indexOf(abi as (typeof ABI_PRIORITY)[number]);
  return index === -1 ? 99 : index;
};

function sortArtifacts(version: FakeVersion): FakeArtifact[] {
  return [...version.artifacts.values()].sort((left, right) => abiRank(left.abi) - abiRank(right.abi));
}

function artifactSummary(artifact: FakeArtifact, appId: string, versionName: string) {
  return {
    abi: artifact.abi,
    sizeBytes: artifact.bytes.length,
    sha256: artifact.sha256,
    downloadPath: `/api/v1/apps/${appId}/versions/${versionName}/download?abi=${artifact.abi}`,
  };
}

function versionAdmin(appId: string, version: FakeVersion) {
  const artifacts = sortArtifacts(version);
  const byAbi = (artifact: FakeArtifact) => ({
    ...artifactSummary(artifact, appId, version.versionName),
    filename: artifact.filename,
  });
  const shown = artifacts.map(byAbi);
  const defaultArtifact = shown[0] ?? null;

  return {
    versionName: version.versionName,
    versionCode: version.versionCode,
    minSdk: version.minSdk,
    releaseNotes: version.releaseNotes,
    publishedAt: version.publishedAt,
    draft: artifacts.length === 0,
    abis: artifacts.map((artifact) => artifact.abi),
    universal: version.artifacts.has("universal"),
    artifacts: shown,
    defaultArtifact,
    sizeBytes: defaultArtifact?.sizeBytes ?? null,
    sha256: defaultArtifact?.sha256 ?? null,
    downloadPath: defaultArtifact?.downloadPath ?? null,
  };
}

function versionSummary(appId: string, version: FakeVersion) {
  const admin = versionAdmin(appId, version);
  return {
    versionName: admin.versionName,
    versionCode: admin.versionCode,
    minSdk: admin.minSdk,
    releaseNotes: admin.releaseNotes,
    publishedAt: admin.publishedAt,
    sizeBytes: admin.sizeBytes ?? 0,
    sha256: admin.sha256,
    downloadPath: admin.downloadPath ?? "",
    abis: admin.abis,
    universal: admin.universal,
    artifacts: admin.artifacts.map(({ filename: _filename, ...summary }) => summary),
  };
}

function publishedVersions(app: FakeApp): FakeVersion[] {
  return [...app.versions.values()]
    .filter((version) => version.artifacts.size > 0)
    .sort((left, right) => right.versionCode - left.versionCode);
}

function appSummary(app: FakeApp) {
  const versions = publishedVersions(app);
  return {
    id: app.id,
    name: app.name,
    packageName: app.packageName,
    description: app.description,
    developer: app.developer,
    iconPath: app.icon ? `/api/v1/apps/${app.id}/icon` : null,
    versionCount: versions.length,
    latestVersion: versions[0] ? versionSummary(app.id, versions[0]) : null,
  };
}

function appDetail(app: FakeApp) {
  return {
    ...appSummary(app),
    versions: publishedVersions(app).map((version) => versionSummary(app.id, version)),
  };
}

function json(response: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
  });
  response.end(body);
}

function failure(
  response: http.ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  json(response, status, { error: { code, message } });
}

async function readBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const MISMATCH_KINDS: readonly MismatchKind[] = ["package", "version", "sdk", "abi"];

function parseAllowMismatch(raw: string | null): Set<MismatchKind> {
  const allowed = new Set<MismatchKind>();
  for (const value of (raw ?? "").split(",")) {
    const trimmed = value.trim().toLowerCase();
    if (MISMATCH_KINDS.includes(trimmed as MismatchKind)) {
      allowed.add(trimmed as MismatchKind);
    }
  }
  return allowed;
}

async function detectOrNull(bytes: Buffer): Promise<DetectedApk | null> {
  try {
    return await inspectApkBuffer(bytes);
  } catch {
    return null;
  }
}

interface ExpectedMetadata {
  packageName?: string | null;
  versionName?: string | null;
  versionCode?: number | null;
  minSdk?: number | null;
  abi?: string | null;
}

/** Mirrors the server's strict checks so CLI tests exercise real behavior. */
function verifyMetadata(
  detected: DetectedApk,
  expected: ExpectedMetadata,
  allow: Set<MismatchKind>,
): string[] {
  const problems: string[] = [];
  if (
    !allow.has("package") &&
    expected.packageName &&
    expected.packageName !== detected.packageName
  ) {
    problems.push(
      `packageName '${detected.packageName}' != app '${expected.packageName}'`,
    );
  }
  if (!allow.has("version")) {
    if (expected.versionCode !== undefined && expected.versionCode !== null) {
      if (detected.versionCode !== expected.versionCode) {
        problems.push(`versionCode ${detected.versionCode} != ${expected.versionCode}`);
      }
    }
    if (
      detected.versionName !== null &&
      expected.versionName !== undefined &&
      expected.versionName !== null &&
      detected.versionName !== expected.versionName
    ) {
      problems.push(`versionName '${detected.versionName}' != '${expected.versionName}'`);
    }
  }
  if (!allow.has("sdk")) {
    if (
      detected.minSdk !== null &&
      expected.minSdk !== undefined &&
      expected.minSdk !== null &&
      detected.minSdk !== expected.minSdk
    ) {
      problems.push(`minSdk ${detected.minSdk} != ${expected.minSdk}`);
    }
  }
  if (!allow.has("abi") && expected.abi && expected.abi !== detected.artifactAbi) {
    problems.push(`abi ${expected.abi} != detected ${detected.artifactAbi}`);
  }
  return problems;
}

function mismatchFailure(response: http.ServerResponse, problems: string[]): void {
  failure(response, 422, "apk_metadata_mismatch", problems.join("; "));
}

export async function startFakeServer(): Promise<FakeServer> {
  const apps = new Map<string, FakeApp>();
  const uploads: RecordedUpload[] = [];
  const imports: RecordedImport[] = [];

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = request.method ?? "GET";
    const mutating = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

    if (mutating && request.headers["x-management-key"] !== KEY) {
      failure(response, 401, "invalid_management_key", "Invalid management key");
      return;
    }

    if (mutating && parts[3] === "__testflight_cli_probe__") {
      failure(response, 400, "invalid_request", "Invalid app id");
      return;
    }

    // Test hook: reject before draining the request body, like a server that
    // authenticates and validates the URL before reading a large APK.
    if (
      method === "PUT" &&
      parts.length === 8 &&
      parts[6] === "artifacts" &&
      parts[7] === "__early_422__"
    ) {
      failure(response, 422, "apk_metadata_mismatch", "Rejected before reading the request body");
      return;
    }

    try {
      if (parts[0] !== "api" || parts[1] !== "v1") {
        failure(response, 404, "not_found", "Route not found");
        return;
      }

      if (parts[2] === "health" && method === "GET") {
        json(response, 200, { status: "ok" });
        return;
      }

      if (parts[2] === "import" && parts.length === 3 && method === "POST") {
        const bytes = await readBody(request);
        const detected = await detectOrNull(bytes);
        if (!detected) {
          failure(response, 400, "invalid_apk", "The body is not a readable APK");
          return;
        }
        if (detected.configSplit) {
          failure(response, 400, "invalid_apk", "Config splits cannot be imported");
          return;
        }

        const searchParams = Object.fromEntries(url.searchParams.entries());
        const allow = parseAllowMismatch(url.searchParams.get("allow_mismatch"));
        const createRaw = url.searchParams.get("create");
        const create = createRaw === "true" || createRaw === "1";
        const appId = url.searchParams.get("appId") ?? detected.packageName;
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(appId)) {
          failure(response, 400, "invalid_request", `Invalid app id "${appId}"`);
          return;
        }

        let app = apps.get(appId);
        let createdApp = false;
        if (!app) {
          if (!create) {
            failure(response, 404, "app_not_found", `Unknown app "${appId}"`);
            return;
          }
          const clash = [...apps.values()].find(
            (other) => other.packageName === detected.packageName,
          );
          if (clash) {
            failure(
              response,
              409,
              "package_in_use",
              `Package "${detected.packageName}" is already used by app "${clash.id}"`,
            );
            return;
          }
          const defaultName = humanize(appId.split(".").pop() ?? appId);
          app = {
            id: appId,
            name: url.searchParams.get("name") ?? defaultName,
            packageName: detected.packageName,
            description: "",
            developer: "",
            icon: null,
            versions: new Map(),
          };
          apps.set(appId, app);
          createdApp = true;
        } else if (app.packageName && app.packageName !== app.id) {
          const problems = verifyMetadata(
            detected,
            { packageName: app.packageName },
            allow,
          );
          if (problems.length > 0) {
            mismatchFailure(response, problems);
            return;
          }
        }

        const versionCodeRaw = url.searchParams.get("versionCode");
        const versionCode = versionCodeRaw
          ? Number(versionCodeRaw)
          : detected.versionCode;
        if (!Number.isSafeInteger(versionCode) || versionCode <= 0) {
          failure(response, 400, "invalid_request", "Invalid versionCode");
          return;
        }
        // The server resolves the name: query → manifest → String(versionCode).
        const versionName =
          url.searchParams.get("version") ?? detected.versionName ?? String(versionCode);
        if (!isValidVersionName(versionName)) {
          failure(response, 400, "version_name_invalid", `Invalid version name "${versionName}"`);
          return;
        }

        const existingVersion = app.versions.get(versionName);
        const versionProblems = existingVersion
          ? verifyMetadata(
              detected,
              {
                versionName,
                versionCode: existingVersion.versionCode,
                minSdk: existingVersion.minSdk,
              },
              allow,
            )
          : verifyMetadata(detected, { versionName, versionCode }, allow);
        if (versionProblems.length > 0) {
          mismatchFailure(response, versionProblems);
          return;
        }

        let createdVersion = false;
        let version = existingVersion;
        if (!version) {
          version = {
            versionName,
            versionCode,
            minSdk: detected.minSdk,
            releaseNotes: url.searchParams.get("releaseNotes"),
            publishedAt:
              url.searchParams.get("publishedAt") ?? new Date().toISOString(),
            artifacts: new Map(),
          };
          app.versions.set(versionName, version);
          createdVersion = true;
        } else if (url.searchParams.get("releaseNotes") !== null) {
          version.releaseNotes = url.searchParams.get("releaseNotes");
        }

        const abi = detected.artifactAbi;
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const existed = version.artifacts.has(abi);
        version.artifacts.set(abi, {
          abi,
          bytes,
          sha256,
          filename: `${abi}-${sha256.slice(0, 16)}.apk`,
        });
        imports.push({ searchParams, abi, sha256 });

        json(response, createdApp || createdVersion || !existed ? 201 : 200, {
          app: appDetail(app),
          version: versionAdmin(appId, version),
          detected,
          artifact: {
            abi,
            sizeBytes: bytes.length,
            sha256,
            downloadPath: `/api/v1/apps/${appId}/versions/${versionName}/download?abi=${abi}`,
          },
          createdApp,
          createdVersion,
        });
        return;
      }

      if (parts[2] !== "apps") {
        failure(response, 404, "not_found", "Route not found");
        return;
      }

      if (parts.length === 3) {
        if (method === "GET") {
          json(response, 200, { apps: [...apps.values()].map(appSummary) });
          return;
        }
        if (method === "POST") {
          const body = JSON.parse((await readBody(request)).toString("utf8") || "{}") as Record<
            string,
            unknown
          >;
          const id = typeof body.id === "string" ? body.id : "";
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
            failure(response, 400, "invalid_request", "Invalid app id");
            return;
          }
          if (apps.has(id)) {
            failure(response, 409, "app_exists", `App "${id}" already exists`);
            return;
          }
          const packageName =
            typeof body.packageName === "string" ? body.packageName : id;
          const clash = [...apps.values()].find((other) => other.packageName === packageName);
          if (clash) {
            failure(
              response,
              409,
              "package_in_use",
              `Package "${packageName}" is already used by app "${clash.id}"`,
            );
            return;
          }
          const app: FakeApp = {
            id,
            name: typeof body.name === "string" ? body.name : humanize(id),
            packageName,
            description: typeof body.description === "string" ? body.description : "",
            developer: typeof body.developer === "string" ? body.developer : "",
            icon: null,
            versions: new Map(),
          };
          apps.set(id, app);
          json(response, 201, { app: appDetail(app) });
          return;
        }
      }

      const appId = parts[3];
      if (!appId) {
        failure(response, 404, "not_found", "Route not found");
        return;
      }
      const app = apps.get(appId);

      if (parts.length === 5 && parts[4] === "icon") {
        if (!app) {
          failure(response, 404, "app_not_found", `Unknown app "${appId}"`);
          return;
        }
        if (method === "PUT") {
          app.icon = {
            type: String(request.headers["content-type"] ?? "image/png"),
            bytes: await readBody(request),
          };
          json(response, 200, { iconPath: `/api/v1/apps/${appId}/icon` });
          return;
        }
        if (method === "DELETE") {
          app.icon = null;
          response.writeHead(204);
          response.end();
          return;
        }
      }

      if (parts.length === 4) {
        if (!app) {
          failure(response, 404, "app_not_found", `Unknown app "${appId}"`);
          return;
        }
        if (method === "GET") {
          json(response, 200, { app: appDetail(app) });
          return;
        }
        if (method === "PUT") {
          const body = JSON.parse((await readBody(request)).toString("utf8") || "{}") as Record<
            string,
            unknown
          >;
          if (typeof body.name === "string") app.name = body.name;
          if (typeof body.packageName === "string" && body.packageName !== app.packageName) {
            const hasArtifacts = [...app.versions.values()].some(
              (version) => version.artifacts.size > 0,
            );
            if (hasArtifacts) {
              failure(
                response,
                409,
                "package_locked",
                `App "${appId}" already has uploaded APKs; its package cannot change`,
              );
              return;
            }
            const clash = [...apps.values()].find(
              (other) => other.id !== appId && other.packageName === body.packageName,
            );
            if (clash) {
              failure(
                response,
                409,
                "package_in_use",
                `Package "${String(body.packageName)}" is already used by app "${clash.id}"`,
              );
              return;
            }
            app.packageName = body.packageName as string;
          }
          if (typeof body.description === "string") app.description = body.description;
          if (typeof body.developer === "string") app.developer = body.developer;
          json(response, 200, { app: appDetail(app) });
          return;
        }
        if (method === "DELETE") {
          apps.delete(appId);
          response.writeHead(204);
          response.end();
          return;
        }
      }

      if (parts.length >= 5 && parts[4] === "versions") {
        if (!app) {
          failure(response, 404, "app_not_found", `Unknown app "${appId}"`);
          return;
        }

        if (parts.length === 5) {
          if (method === "GET") {
            const versions = [...app.versions.values()]
              .sort((left, right) => right.versionCode - left.versionCode)
              .map((version) => versionAdmin(appId, version));
            json(response, 200, { versions });
            return;
          }
          if (method === "POST") {
            const body = JSON.parse(
              (await readBody(request)).toString("utf8") || "{}",
            ) as Record<string, unknown>;
            const versionName = typeof body.versionName === "string" ? body.versionName : "";
            const versionCode = typeof body.versionCode === "number" ? body.versionCode : 0;
            if (!isValidVersionName(versionName)) {
              failure(
                response,
                400,
                "version_name_invalid",
                `Invalid version name "${versionName}"`,
              );
              return;
            }
            if (versionCode <= 0) {
              failure(response, 400, "invalid_request", "Invalid version");
              return;
            }
            if (app.versions.has(versionName)) {
              failure(response, 409, "version_exists", `Version "${versionName}" already exists`);
              return;
            }
            const version: FakeVersion = {
              versionName,
              versionCode,
              minSdk: typeof body.minSdk === "number" ? body.minSdk : null,
              releaseNotes: typeof body.releaseNotes === "string" ? body.releaseNotes : null,
              publishedAt:
                typeof body.publishedAt === "string"
                  ? body.publishedAt
                  : new Date().toISOString(),
              artifacts: new Map(),
            };
            app.versions.set(versionName, version);
            json(response, 201, { version: versionAdmin(appId, version) });
            return;
          }
        }

        const versionName = parts[5];
        if (!versionName) {
          failure(response, 404, "not_found", "Route not found");
          return;
        }
        const version = app.versions.get(versionName);
        if (!version) {
          failure(response, 404, "version_not_found", `Unknown version "${versionName}"`);
          return;
        }

        if (parts.length === 6) {
          if (method === "GET") {
            json(response, 200, { version: versionAdmin(appId, version) });
            return;
          }
          if (method === "PUT") {
            const body = JSON.parse(
              (await readBody(request)).toString("utf8") || "{}",
            ) as Record<string, unknown>;
            if (typeof body.versionCode === "number") version.versionCode = body.versionCode;
            if (body.minSdk === null || typeof body.minSdk === "number") {
              version.minSdk = body.minSdk;
            }
            if (body.releaseNotes === null || typeof body.releaseNotes === "string") {
              version.releaseNotes = body.releaseNotes;
            }
            if (typeof body.publishedAt === "string") version.publishedAt = body.publishedAt;
            json(response, 200, { version: versionAdmin(appId, version) });
            return;
          }
          if (method === "DELETE") {
            app.versions.delete(versionName);
            response.writeHead(204);
            response.end();
            return;
          }
        }

        if (parts.length === 7 && parts[6] === "download" && method === "GET") {
          const abi = url.searchParams.get("abi");
          const artifact = abi
            ? version.artifacts.get(abi)
            : sortArtifacts(version)[0];
          if (!artifact) {
            failure(response, 404, "abi_not_found", "No APK for that ABI");
            return;
          }
          const isDefault = sortArtifacts(version)[0] === artifact;
          const filename = isDefault
            ? `${appId}-${versionName}.apk`
            : `${appId}-${versionName}-${artifact.abi}.apk`;
          response.writeHead(200, {
            "content-type": "application/vnd.android.package-archive",
            // Version names may contain spaces/Unicode; HTTP headers must be
            // ASCII, so the test server percent-encodes the filename.
            "content-disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
            "content-length": String(artifact.bytes.length),
            "cache-control": "no-store",
            "x-checksum-sha256": artifact.sha256,
          });
          response.end(artifact.bytes);
          return;
        }

        if (parts.length === 7 && parts[6] === "artifacts" && method === "PUT") {
          const bytes = await readBody(request);
          const detected = await detectOrNull(bytes);
          if (!detected) {
            failure(response, 400, "invalid_apk", "The body is not a readable APK");
            return;
          }
          const allow = parseAllowMismatch(url.searchParams.get("allow_mismatch"));
          uploads.push({
            path: url.pathname,
            abi: null,
            allowMismatch: url.searchParams.get("allow_mismatch"),
          });
          const problems = verifyMetadata(
            detected,
            {
              packageName:
                app.packageName && app.packageName !== app.id ? app.packageName : null,
              versionName: version.versionName,
              versionCode: version.versionCode,
              minSdk: version.minSdk,
            },
            allow,
          );
          if (problems.length > 0) {
            mismatchFailure(response, problems);
            return;
          }
          const abi = detected.artifactAbi;
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          const existed = version.artifacts.has(abi);
          version.artifacts.set(abi, {
            abi,
            bytes,
            sha256,
            filename: `${abi}-${sha256.slice(0, 16)}.apk`,
          });
          json(response, existed ? 200 : 201, {
            version: versionAdmin(appId, version),
            detected,
          });
          return;
        }

        if (parts.length === 8 && parts[6] === "artifacts") {
          const abi = parts[7] ?? "";
          if (method === "PUT") {
            if (!ABI_PRIORITY.includes(abi as (typeof ABI_PRIORITY)[number])) {
              failure(response, 400, "invalid_request", `Invalid abi "${abi}"`);
              return;
            }
            const bytes = await readBody(request);
            const detected = await detectOrNull(bytes);
            const allow = parseAllowMismatch(url.searchParams.get("allow_mismatch"));
            uploads.push({
              path: url.pathname,
              abi,
              allowMismatch: url.searchParams.get("allow_mismatch"),
            });
            if (detected) {
              const problems = verifyMetadata(
                detected,
                {
                  packageName:
                    app.packageName && app.packageName !== app.id
                      ? app.packageName
                      : null,
                  versionName: version.versionName,
                  versionCode: version.versionCode,
                  minSdk: version.minSdk,
                  abi,
                },
                allow,
              );
              if (problems.length > 0) {
                mismatchFailure(response, problems);
                return;
              }
            }
            const sha256 = createHash("sha256").update(bytes).digest("hex");
            const existed = version.artifacts.has(abi);
            version.artifacts.set(abi, {
              abi,
              bytes,
              sha256,
              filename: `${abi}-${sha256.slice(0, 16)}.apk`,
            });
            json(response, existed ? 200 : 201, {
              version: versionAdmin(appId, version),
              detected,
            });
            return;
          }
          if (method === "DELETE") {
            if (!version.artifacts.delete(abi)) {
              failure(response, 404, "artifact_not_found", "Unknown artifact");
              return;
            }
            response.writeHead(204);
            response.end();
            return;
          }
        }
      }

      failure(response, 404, "not_found", "Route not found");
    } catch (error) {
      failure(response, 500, "internal_error", (error as Error).message);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    key: KEY,
    apps,
    uploads,
    imports,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
