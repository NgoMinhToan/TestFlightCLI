import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { writeFakeApk } from "./zip-fixture.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(projectRoot, "src", "cli.ts");

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function run(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", cliPath, ...args],
      {
        cwd: projectRoot,
        env: { ...process.env, NO_COLOR: "1", ...env },
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message: string;
    };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
      code: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}

let server: FakeServer;

before(async () => {
  server = await startFakeServer();
});

after(async () => {
  await server.close();
});

test("--version and --help work without configuration", async () => {
  const version = await run(["--version"], { TESTFLIGHT_CONFIG: "/nonexistent/config.json" });
  assert.equal(version.code, 0, version.stderr);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);

  const help = await run(["--help"], {});
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /testflight <command> \[options\]/);
  assert.match(help.stdout, /release <appId>/);
  assert.match(help.stdout, /versions abis/);
});

test("a full login → create → release → inspect → download flow", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-cli-"));
  const env = {
    TESTFLIGHT_CONFIG: path.join(directory, "config", "config.json"),
  } satisfies NodeJS.ProcessEnv;

  try {
    const apk = await writeFakeApk(directory, "crm-arm64-v8a.apk", ["arm64-v8a"], {
      packageName: "com.company.crm",
      versionCode: 142,
      versionName: "1.4.2",
      minSdk: 26,
      targetSdk: 37,
    });

    const login = await run(
      ["login", "--url", server.url, "--key", server.key, "--json"],
      env,
    );
    assert.equal(login.code, 0, login.stderr);
    const loginJson = JSON.parse(login.stdout) as { profile: string; baseUrl: string };
    assert.equal(loginJson.profile, "default");
    assert.equal(loginJson.baseUrl, server.url);

    const whoami = await run(["whoami", "--json"], env);
    assert.equal(whoami.code, 0, whoami.stderr);
    assert.equal((JSON.parse(whoami.stdout) as { baseUrl: string }).baseUrl, server.url);

    const created = await run(
      ["apps", "create", "crm", "--name", "Internal CRM", "--package", "com.company.crm", "--json"],
      env,
    );
    assert.equal(created.code, 0, created.stderr);
    assert.equal((JSON.parse(created.stdout) as { app: { id: string } }).app.id, "crm");

    const release = await run(
      [
        "release",
        "crm",
        apk,
        "--version",
        "1.4.2",
        "--version-code",
        "142",
        "--min-sdk",
        "26",
        "--release-notes",
        "Initial build",
        "--json",
      ],
      env,
    );
    assert.equal(release.code, 0, release.stderr);
    const released = JSON.parse(release.stdout) as {
      createdVersion: boolean;
      version: { draft: boolean; abis: string[]; versionName: string };
      uploads: Array<{ abi: string; sha256: string }>;
      downloadUrl: string;
    };
    assert.equal(released.createdVersion, true);
    assert.equal(released.version.draft, false);
    assert.deepEqual(released.version.abis, ["arm64-v8a"]);
    assert.equal(released.uploads[0]?.abi, "arm64-v8a");
    assert.match(released.uploads[0]?.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.match(released.downloadUrl, /\/versions\/1\.4\.2\/download/);

    const abis = await run(["versions", "abis", "crm", "1.4.2", "--json"], env);
    assert.equal(abis.code, 0, abis.stderr);
    const abisJson = JSON.parse(abis.stdout) as {
      abis: string[];
      defaultAbi: string | null;
      artifacts: Array<{ abi: string }>;
    };
    assert.deepEqual(abisJson.abis, ["arm64-v8a"]);
    assert.equal(abisJson.defaultAbi, "arm64-v8a");
    assert.equal(abisJson.artifacts.length, 1);

    const versionList = await run(["versions", "crm", "--json"], env);
    assert.equal(versionList.code, 0, versionList.stderr);
    const versionsJson = JSON.parse(versionList.stdout) as {
      versions: Array<{ versionName: string; draft: boolean }>;
    };
    assert.equal(versionsJson.versions[0]?.versionName, "1.4.2");
    assert.equal(versionsJson.versions[0]?.draft, false);

    const appList = await run(["apps", "list", "--json"], env);
    assert.equal(appList.code, 0, appList.stderr);
    const appsJson = JSON.parse(appList.stdout) as {
      apps: Array<{ id: string; versionCount: number }>;
    };
    assert.deepEqual(appsJson.apps.map((app) => app.id), ["crm"]);
    assert.equal(appsJson.apps[0]?.versionCount, 1);

    const downloadDirectory = path.join(directory, "downloads");
    await mkdir(downloadDirectory, { recursive: true });
    const downloaded = await run(
      ["download", "crm", "1.4.2", "--out", downloadDirectory, "--json"],
      env,
    );
    assert.equal(downloaded.code, 0, downloaded.stderr);
    const downloadJson = JSON.parse(downloaded.stdout) as {
      path: string;
      verified: boolean;
      sha256: string;
    };
    assert.equal(downloadJson.verified, true);
    assert.deepEqual(await readFile(downloadJson.path), await readFile(apk));

    const again = await run(
      ["release", "crm", apk, "--version", "1.4.2", "--version-code", "142"],
      env,
    );
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already exists/);
    assert.match(again.stderr, /--force/);

    const forced = await run(
      ["push", "crm", apk, "--version", "1.4.2", "--version-code", "143", "--force", "--json"],
      env,
    );
    assert.equal(forced.code, 0, forced.stderr);
    const forcedJson = JSON.parse(forced.stdout) as {
      updatedVersion: boolean;
      forced: boolean;
      version: { versionCode: number };
    };
    assert.equal(forcedJson.updatedVersion, true);
    assert.equal(forcedJson.forced, true);
    assert.equal(forcedJson.version.versionCode, 143);
    // The APK itself declares 142, so the override must carry allow_mismatch.
    assert.equal(server.uploads.at(-1)?.allowMismatch, "version");

    const dryRun = await run(
      ["release", "crm", apk, "--version", "2.0.0", "--version-code", "200", "--dry-run", "--json"],
      env,
    );
    assert.equal(dryRun.code, 0, dryRun.stderr);
    const dryRunJson = JSON.parse(dryRun.stdout) as {
      dryRun: boolean;
      versionExists: boolean;
      artifacts: Array<{ abi: string }>;
    };
    assert.equal(dryRunJson.dryRun, true);
    assert.equal(dryRunJson.versionExists, false);
    assert.deepEqual(dryRunJson.artifacts.map((artifact) => artifact.abi), ["arm64-v8a"]);

    // Without --version/--version-code the identity comes from the APK.
    const inferred = await run(["release", "crm", apk, "--dry-run", "--json"], env);
    assert.equal(inferred.code, 0, inferred.stderr);
    const inferredJson = JSON.parse(inferred.stdout) as {
      versionName: string;
      versionCode: number;
      versionNameInferred: boolean;
      versionCodeInferred: boolean;
      detected: { versionName: string; versionCode: number };
      allowMismatch: string[];
    };
    assert.equal(inferredJson.versionName, "1.4.2");
    assert.equal(inferredJson.versionCode, 142);
    assert.equal(inferredJson.versionNameInferred, true);
    assert.equal(inferredJson.versionCodeInferred, true);
    assert.deepEqual(inferredJson.detected, { versionName: "1.4.2", versionCode: 142 });
    assert.deepEqual(inferredJson.allowMismatch, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("releases, reads and downloads a version name with spaces, '+', parentheses and Unicode", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-cli-"));
  try {
    const env = {
      TESTFLIGHT_CONFIG: path.join(directory, "config", "config.json"),
    } satisfies NodeJS.ProcessEnv;
    const login = await run(
      ["login", "--url", server.url, "--key", server.key, "--json"],
      env,
    );
    assert.equal(login.code, 0, login.stderr);

    const versionName = "Bản nội bộ (beta)";
    const apk = await writeFakeApk(directory, "flex-arm64-v8a.apk", ["arm64-v8a"], {
      packageName: "com.example.flex",
      versionCode: 42,
      versionName: "1.0.0+42",
      minSdk: 26,
    });
    const created = await run(
      ["apps", "create", "flex", "--package", "com.example.flex", "--json"],
      env,
    );
    assert.equal(created.code, 0, created.stderr);

    const release = await run(
      ["release", "flex", apk, "--version", versionName, "--version-code", "42", "--json"],
      env,
    );
    assert.equal(release.code, 0, release.stderr);
    const released = JSON.parse(release.stdout) as {
      allowMismatch: string[];
      version: { versionName: string };
    };
    assert.deepEqual(released.allowMismatch, ["version"]);
    assert.equal(released.version.versionName, versionName);

    const fetched = await run(["versions", "get", "flex", versionName, "--json"], env);
    assert.equal(fetched.code, 0, fetched.stderr);
    assert.equal(
      (JSON.parse(fetched.stdout) as { version: { versionName: string } }).version.versionName,
      versionName,
    );

    const downloadDirectory = path.join(directory, "downloads");
    await mkdir(downloadDirectory, { recursive: true });
    const downloaded = await run(
      ["download", "flex", versionName, "--out", downloadDirectory, "--json"],
      env,
    );
    assert.equal(downloaded.code, 0, downloaded.stderr);
    const downloadJson = JSON.parse(downloaded.stdout) as { path: string; verified: boolean };
    assert.equal(downloadJson.verified, true);
    assert.deepEqual(await readFile(downloadJson.path), await readFile(apk));

    const rejected = await run(
      ["versions", "create", "flex", "../escape", "--version-code", "1"],
      env,
    );
    assert.equal(rejected.code, 2);
    assert.match(rejected.stderr, /Invalid version name/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("apk inspect prints metadata offline and reports unreadable files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-cli-"));
  const env = { TESTFLIGHT_CONFIG: path.join(directory, "config.json") };
  try {
    const apk = await writeFakeApk(directory, "inspect-arm64-v8a.apk", ["arm64-v8a"], {
      packageName: "dev.example.inspect",
      versionCode: 18,
      versionName: "0.2.0",
      minSdk: 26,
      targetSdk: 37,
    });
    const result = await run(["apk", "inspect", apk, "--json"], env);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      files: Array<{
        path: string;
        fileName: string;
        sizeBytes: number;
        artifactAbi: string;
        metadata: { packageName: string; versionCode: number; versionName: string };
        error?: string;
      }>;
    };
    assert.equal(payload.files[0]?.metadata.packageName, "dev.example.inspect");
    assert.equal(payload.files[0]?.metadata.versionCode, 18);
    assert.equal(payload.files[0]?.artifactAbi, "arm64-v8a");
    assert.ok((payload.files[0]?.sizeBytes ?? 0) > 0);

    const broken = path.join(directory, "broken.apk");
    await import("node:fs/promises").then((fs) => fs.writeFile(broken, "not a zip"));
    const failed = await run(["apk", "inspect", apk, broken, "--json"], env);
    assert.equal(failed.code, 1);
    const failedPayload = JSON.parse(failed.stdout) as {
      files: Array<{ path: string; error?: string }>;
    };
    assert.equal(failedPayload.files.length, 2);
    assert.match(failedPayload.files[1]?.error ?? "", /not a readable APK/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release --allow-mismatch package overrides an app package change", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-cli-"));
  const env = { TESTFLIGHT_CONFIG: path.join(directory, "config.json") };
  try {
    const apk = await writeFakeApk(directory, "package.apk", ["arm64-v8a"], {
      packageName: "dev.example.package",
      versionCode: 1,
      versionName: "1.0.0",
      minSdk: 24,
    });

    const login = await run(
      ["login", "--url", server.url, "--key", server.key, "--json"],
      env,
    );
    assert.equal(login.code, 0, login.stderr);
    const created = await run(
      ["apps", "create", "packaged", "--package", "com.other", "--json"],
      env,
    );
    assert.equal(created.code, 0, created.stderr);

    const denied = await run(
      ["release", "packaged", apk, "--version", "1.0.0", "--version-code", "1", "--json"],
      env,
    );
    assert.equal(denied.code, 1, denied.stderr);
    assert.match(denied.stderr, /apk_metadata_mismatch/);

    const allowed = await run(
      [
        "release",
        "packaged",
        apk,
        "--version",
        "1.0.0",
        "--version-code",
        "1",
        "--allow-mismatch",
        "package",
        "--json",
      ],
      env,
    );
    assert.equal(allowed.code, 0, allowed.stderr);
    const payload = JSON.parse(allowed.stdout) as {
      allowMismatch: string[];
      uploads: Array<{ abi: string }>;
    };
    assert.deepEqual(payload.allowMismatch, ["package"]);
    assert.equal(payload.uploads[0]?.abi, "arm64-v8a");
    assert.equal(server.uploads.at(-1)?.allowMismatch, "package");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a rejected management key fails with a useful message", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-cli-"));
  try {
    const env = {
      TESTFLIGHT_CONFIG: path.join(directory, "config.json"),
      TESTFLIGHT_BASE_URL: server.url,
      TESTFLIGHT_MANAGEMENT_KEY: "wrong-key",
    };
    const result = await run(["apps", "create", "x"], env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /invalid_management_key/);
    assert.match(result.stderr, /testflight login/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
