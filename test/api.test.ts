import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { TestflightApi } from "../src/api.js";
import { ApiError } from "../src/errors.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { writeFakeApk } from "./zip-fixture.js";

let server: FakeServer;
let api: TestflightApi;

before(async () => {
  server = await startFakeServer();
  api = new TestflightApi({ baseUrl: server.url, managementKey: server.key });
});

after(async () => {
  await server.close();
});

test("probeManagementKey distinguishes a good key from a bad one", async () => {
  const good = await api.probeManagementKey();
  assert.equal(good.ok, true);
  assert.equal(good.status, 400);

  const bad = new TestflightApi({ baseUrl: server.url, managementKey: "wrong" });
  const rejected = await bad.probeManagementKey();
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 401);
  assert.equal(rejected.code, "invalid_management_key");
});

test("create, list and fetch an app", async () => {
  const created = await api.createApp({
    id: "crm",
    name: "Internal CRM",
    packageName: "com.company.crm",
    developer: "Platform Team",
  });
  assert.equal(created.id, "crm");
  assert.equal(created.name, "Internal CRM");
  assert.equal(created.versionCount, 0);

  const apps = await api.listApps();
  assert.equal(apps.length, 1);
  assert.equal(apps[0]?.id, "crm");

  const fetched = await api.getApp("crm");
  assert.equal(fetched.packageName, "com.company.crm");

  await assert.rejects(
    () => api.createApp({ id: "crm" }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "app_exists");
      return true;
    },
  );
});

test("uploads an APK as an artifact with a matching SHA-256", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-api-"));
  try {
    await api.createApp({ id: "game", name: "Game" });
    const version = await api.createVersion("game", {
      versionName: "1.0.0",
      versionCode: 10,
      minSdk: 26,
      releaseNotes: "first",
    });
    assert.equal(version.draft, true);
    assert.equal(version.artifacts.length, 0);

    const apkPath = await writeFakeApk(directory, "game-arm64-v8a.apk", ["arm64-v8a"], {
      packageName: "game",
      versionCode: 10,
      versionName: "1.0.0",
      minSdk: 26,
    });
    const expected = createHash("sha256").update(await readFile(apkPath)).digest("hex");

    const progress: number[] = [];
    const result = await api.uploadArtifact("game", "1.0.0", "arm64-v8a", apkPath, {
      onProgress: (uploaded) => progress.push(uploaded),
    });

    assert.equal(result.created, true);
    assert.equal(result.sha256, expected);
    assert.equal(result.serverSha256, expected);
    assert.equal(result.verified, true);
    assert.equal(result.detected?.versionCode, 10);
    assert.equal(result.detected?.artifactAbi, "arm64-v8a");
    assert.ok(progress.length > 0);
    assert.equal(progress.at(-1), result.sizeBytes);

    const stored = await api.getVersionAdmin("game", "1.0.0");
    assert.equal(stored.draft, false);
    assert.deepEqual(stored.abis, ["arm64-v8a"]);
    assert.equal(stored.artifacts[0]?.sha256, expected);

    const second = await api.uploadArtifact("game", "1.0.0", "arm64-v8a", apkPath);
    assert.equal(second.created, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lets the server infer the artifact ABI and records allow_mismatch", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-api-"));
  try {
    await api.createApp({ id: "auto", packageName: "com.example.auto" });
    await api.createVersion("auto", {
      versionName: "2.0.0",
      versionCode: 20,
      minSdk: 26,
    });
    // The APK declares a different versionCode on purpose.
    const apkPath = await writeFakeApk(directory, "auto.apk", ["arm64-v8a"], {
      packageName: "com.example.auto",
      versionCode: 99,
      versionName: "2.0.0",
      minSdk: 26,
    });

    const detectedOnly = await api.uploadArtifactAutoAbi("auto", "2.0.0", apkPath, {
      allowMismatch: ["version"],
    });
    assert.equal(detectedOnly.abi, "arm64-v8a");
    assert.equal(detectedOnly.detected?.versionCode, 99);
    assert.equal(detectedOnly.verified, true);

    const recorded = server.uploads.at(-1);
    assert.equal(recorded?.abi, null);
    assert.equal(recorded?.allowMismatch, "version");

    // Without the override the same upload is rejected with the server's 422.
    await assert.rejects(
      () => api.uploadArtifactAutoAbi("auto", "2.0.0", apkPath),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 422);
        assert.equal(error.code, "apk_metadata_mismatch");
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("imports APKs through POST /api/v1/import", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-api-"));
  try {
    const apkPath = await writeFakeApk(directory, "import-arm64-v8a.apk", ["arm64-v8a"], {
      packageName: "com.example.imported",
      versionCode: 7,
      versionName: "0.7.0",
      minSdk: 24,
    });

    await assert.rejects(
      () => api.importApk(apkPath, { appId: "imported" }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 404);
        assert.equal(error.code, "app_not_found");
        return true;
      },
    );

    const result = await api.importApk(apkPath, {
      appId: "imported",
      create: true,
      versionName: "0.7.0",
      versionCode: 7,
      name: "Imported App",
      releaseNotes: "first import",
    });
    assert.equal(result.createdApp, true);
    assert.equal(result.createdVersion, true);
    assert.equal(result.createdArtifact, true);
    assert.equal(result.app.packageName, "com.example.imported");
    assert.equal(result.version.versionCode, 7);
    assert.equal(result.version.releaseNotes, "first import");
    assert.equal(result.detected?.artifactAbi, "arm64-v8a");
    assert.equal(result.artifact?.abi, "arm64-v8a");
    assert.equal(result.verified, true);

    const again = await api.importApk(apkPath, {
      appId: "imported",
      versionName: "0.7.0",
      versionCode: 7,
    });
    assert.equal(again.createdApp, false);
    assert.equal(again.createdVersion, false);
    assert.equal(again.createdArtifact, false);
    assert.equal(again.status, 200);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("importApk turns a 404 into an upgrade hint for old servers", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-api-"));
  try {
    const apkPath = path.join(directory, "legacy.apk");
    await writeFile(apkPath, "some bytes");
    const legacy = new TestflightApi({
      baseUrl: "http://example.invalid",
      managementKey: "key",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ error: { code: "not_found", message: "Route not found" } }),
          { status: 404, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });
    await assert.rejects(
      () => legacy.importApk(apkPath, { appId: "legacy" }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 404);
        assert.match(error.hint ?? "", /Upgrade MyTestflightServer/);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("downloads an APK and verifies the server checksum", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-api-"));
  try {
    const apkPath = await writeFakeApk(directory, "game.apk", ["arm64-v8a"], {
      packageName: "game",
      versionCode: 10,
      versionName: "1.0.0",
      minSdk: 26,
    });
    const original = await readFile(apkPath);

    const destination = path.join(directory, "downloads", "game.apk");
    const result = await api.downloadArtifact("game", "1.0.0", null, destination);

    assert.equal(result.verified, true);
    assert.equal(result.bytes, original.length);
    assert.equal(result.sha256, createHash("sha256").update(original).digest("hex"));
    assert.deepEqual(await readFile(destination), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("API errors expose the server's status and code", async () => {
  await assert.rejects(
    () => api.getApp("missing-app"),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 404);
      assert.equal(error.code, "app_not_found");
      return true;
    },
  );

  await assert.rejects(
    () => api.deleteVersion("game", "9.9.9"),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 404);
      assert.equal(error.code, "version_not_found");
      return true;
    },
  );
});
