import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

function onlineEnv(directory: string): NodeJS.ProcessEnv {
  return {
    TESTFLIGHT_CONFIG: path.join(directory, "config", "config.json"),
    TESTFLIGHT_BASE_URL: server.url,
    TESTFLIGHT_MANAGEMENT_KEY: server.key,
  };
}

const SPLIT_MANIFEST = {
  packageName: "dev.example.split",
  versionCode: 20,
  versionName: "2.0.0",
  minSdk: 26,
  targetSdk: 37,
};

test("publish --dry-run works fully offline and infers identity from the APK", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-publish-"));
  try {
    const apk = await writeFakeApk(directory, "dry-arm64-v8a.apk", ["arm64-v8a"], {
      packageName: "com.example.dry",
      versionCode: 12,
      versionName: "1.2.3",
      minSdk: 24,
      targetSdk: 36,
    });
    const result = await run(
      ["publish", apk, "--dry-run", "--json"],
      { TESTFLIGHT_CONFIG: path.join(directory, "does-not-exist.json") },
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      dryRun: boolean;
      appId: string;
      create: boolean;
      versionName: string;
      versionCode: number;
      versionNameSource: string;
      versionCodeSource: string;
      allowMismatch: string[];
      files: Array<{ artifactAbi: string; metadata: { packageName: string } }>;
      imports: unknown[];
    };
    assert.equal(payload.dryRun, true);
    assert.equal(payload.appId, "com.example.dry");
    assert.equal(payload.create, false);
    assert.equal(payload.versionName, "1.2.3");
    assert.equal(payload.versionCode, 12);
    assert.equal(payload.versionNameSource, "apk");
    assert.equal(payload.versionCodeSource, "apk");
    assert.deepEqual(payload.allowMismatch, []);
    assert.equal(payload.files[0]?.artifactAbi, "arm64-v8a");
    assert.equal(payload.files[0]?.metadata.packageName, "com.example.dry");
    assert.deepEqual(payload.imports, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publish refuses a missing app unless --create is passed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-publish-"));
  try {
    const apk = await writeFakeApk(directory, "missing.apk", ["arm64-v8a"], {
      packageName: "dev.example.missing",
      versionCode: 1,
      versionName: "1.0.0",
    });
    const result = await run(
      ["publish", apk, "--app-id", "missing-app", "--json"],
      onlineEnv(directory),
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /app_not_found/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publish creates the app and groups three split APKs into one version", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-publish-"));
  try {
    const arm64 = await writeFakeApk(
      directory,
      "split-arm64-v8a.apk",
      ["arm64-v8a"],
      SPLIT_MANIFEST,
    );
    const armv7 = await writeFakeApk(
      directory,
      "split-armeabi-v7a.apk",
      ["armeabi-v7a"],
      SPLIT_MANIFEST,
    );
    const x86 = await writeFakeApk(directory, "split-x86_64.apk", ["x86_64"], SPLIT_MANIFEST);

    const first = await run(
      ["publish", arm64, armv7, x86, "--app-id", "splitapp", "--create", "--json"],
      onlineEnv(directory),
    );
    assert.equal(first.code, 0, first.stderr);
    const payload = JSON.parse(first.stdout) as {
      createdApp: boolean;
      createdVersion: boolean;
      version: { versionName: string; versionCode: number; artifacts: Array<{ abi: string }> };
      imports: Array<{ abi: string; createdArtifact: boolean }>;
      downloadUrl: string;
    };
    assert.equal(payload.createdApp, true);
    assert.equal(payload.createdVersion, true);
    assert.equal(payload.version.versionName, "2.0.0");
    assert.equal(payload.version.versionCode, 20);
    assert.ok(payload.version.artifacts.length > 0);
    assert.deepEqual(
      payload.imports.map((entry) => entry.abi).sort(),
      ["arm64-v8a", "armeabi-v7a", "x86_64"],
    );
    assert.ok(payload.imports.every((entry) => entry.createdArtifact));
    assert.match(payload.downloadUrl, /\/versions\/2\.0\.0\/download/);

    const app = server.apps.get("splitapp");
    const version = app?.versions.get("2.0.0");
    assert.equal(version?.artifacts.size, 3);
    assert.equal(version?.versionCode, 20);

    // Re-importing the same APKs replaces artifacts without new versions.
    const again = await run(
      ["publish", arm64, armv7, x86, "--app-id", "splitapp", "--json"],
      onlineEnv(directory),
    );
    assert.equal(again.code, 0, again.stderr);
    const againPayload = JSON.parse(again.stdout) as {
      createdApp: boolean;
      createdVersion: boolean;
      imports: Array<{ createdArtifact: boolean }>;
    };
    assert.equal(againPayload.createdApp, false);
    assert.equal(againPayload.createdVersion, false);
    assert.ok(againPayload.imports.every((entry) => !entry.createdArtifact));
    assert.equal(server.apps.get("splitapp")?.versions.size, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publish sends long release notes after the import", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-publish-"));
  try {
    const apk = await writeFakeApk(directory, "notes.apk", ["x86_64"], {
      packageName: "dev.example.notes",
      versionCode: 3,
      versionName: "0.3.0",
    });
    const notes = "n".repeat(5 * 1024);
    const notesFile = path.join(directory, "notes.txt");
    await writeFile(notesFile, notes);
    const importsBefore = server.imports.length;

    const result = await run(
      ["publish", apk, "--app-id", "notesapp", "--create", "--notes-file", notesFile, "--json"],
      onlineEnv(directory),
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      releaseNotesUpdated: boolean;
      imports: Array<{ abi: string }>;
    };
    assert.equal(payload.releaseNotesUpdated, true);
    assert.equal(server.imports.length, importsBefore + 1);
    const recorded = server.imports.at(-1);
    assert.equal(recorded?.searchParams.releaseNotes, undefined);
    assert.equal(
      server.apps.get("notesapp")?.versions.get("0.3.0")?.releaseNotes,
      notes,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publish omits the version query when the APK uses a versionName reference", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-publish-"));
  try {
    const apk = await writeFakeApk(directory, "reference.apk", ["arm64-v8a"], {
      packageName: "dev.example.reference",
      versionCode: 42,
      versionNameReference: true,
    });
    const importsBefore = server.imports.length;
    const result = await run(
      ["publish", apk, "--app-id", "referenceapp", "--create", "--json"],
      onlineEnv(directory),
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      versionName: string | null;
      versionNameSource: string;
      version: { versionName: string };
    };
    assert.equal(payload.versionNameSource, "server");
    assert.equal(payload.version.versionName, "42");
    assert.equal(server.imports.length, importsBefore + 1);
    const recorded = server.imports.at(-1);
    assert.equal(recorded?.searchParams.version, undefined);
    assert.equal(recorded?.searchParams.versionCode, "42");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publish rejects path-unsafe --version values before contacting the server", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-publish-"));
  try {
    const apk = await writeFakeApk(directory, "unsafe.apk", ["arm64-v8a"], {
      packageName: "dev.example.unsafe",
      versionCode: 1,
      versionName: "1.0.0",
    });
    const importsBefore = server.imports.length;
    const result = await run(
      ["publish", apk, "--app-id", "unsafeapp", "--version", "../escape", "--dry-run"],
      { TESTFLIGHT_CONFIG: path.join(directory, "does-not-exist.json") },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Invalid version name/);
    assert.match(result.stderr, /1-200 UTF-8 bytes/);
    assert.equal(server.imports.length, importsBefore);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publish rejects a path-unsafe version name from the APK", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-publish-"));
  try {
    const apk = await writeFakeApk(directory, "unsafe-apk.apk", ["arm64-v8a"], {
      packageName: "dev.example.unsafeapk",
      versionCode: 1,
      versionName: "../escape",
    });
    const importsBefore = server.imports.length;
    const result = await run(
      ["publish", apk, "--app-id", "unsafeapk", "--dry-run"],
      { TESTFLIGHT_CONFIG: path.join(directory, "does-not-exist.json") },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Invalid version name/);
    assert.equal(server.imports.length, importsBefore);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publish accepts flexible version names", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-publish-"));
  try {
    const apk = await writeFakeApk(directory, "flex.apk", ["arm64-v8a"], {
      packageName: "dev.example.flex",
      versionCode: 7,
      versionName: "1.0.0+42",
    });
    const result = await run(
      [
        "publish",
        apk,
        "--app-id",
        "flexapp",
        "--create",
        "--version",
        "Bản nội bộ (beta)",
        "--json",
      ],
      onlineEnv(directory),
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      versionName: string;
      allowMismatch: string[];
    };
    assert.equal(payload.versionName, "Bản nội bộ (beta)");
    assert.deepEqual(payload.allowMismatch, ["version"]);
    assert.equal(
      server.apps.get("flexapp")?.versions.has("Bản nội bộ (beta)"),
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publish adds allow_mismatch=version when the user overrides the APK version", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-publish-"));
  try {
    const apk = await writeFakeApk(directory, "override.apk", ["arm64-v8a"], {
      packageName: "dev.example.override",
      versionCode: 5,
      versionName: "0.5.0",
    });
    const result = await run(
      [
        "publish",
        apk,
        "--app-id",
        "overrideapp",
        "--create",
        "--version",
        "9.9.9",
        "--json",
      ],
      onlineEnv(directory),
    );
    assert.equal(result.code, 0, result.stderr);
    const recorded = server.imports.at(-1);
    assert.equal(recorded?.searchParams.allow_mismatch, "version");
    const payload = JSON.parse(result.stdout) as {
      allowMismatch: string[];
      versionName: string;
    };
    assert.deepEqual(payload.allowMismatch, ["version"]);
    assert.equal(payload.versionName, "9.9.9");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publish stops before importing when the APKs disagree", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-publish-"));
  try {
    const one = await writeFakeApk(directory, "one.apk", ["arm64-v8a"], SPLIT_MANIFEST);
    const two = await writeFakeApk(directory, "two.apk", ["x86_64"], {
      ...SPLIT_MANIFEST,
      versionCode: 21,
    });
    const importsBefore = server.imports.length;
    const result = await run(
      ["publish", one, two, "--app-id", "inconsistent", "--create", "--json"],
      onlineEnv(directory),
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /different app versions/);
    assert.equal(server.imports.length, importsBefore);
    assert.equal(server.apps.has("inconsistent"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publish rejects config splits before contacting the server", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-publish-"));
  try {
    const apk = await writeFakeApk(directory, "config.arm64_v8a.apk", ["arm64-v8a"], {
      ...SPLIT_MANIFEST,
      split: "config.arm64_v8a",
    });
    const result = await run(
      ["publish", apk, "--app-id", "split-config", "--create", "--json"],
      onlineEnv(directory),
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /configuration split/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
