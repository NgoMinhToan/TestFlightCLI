import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { scanApk } from "../src/apk.js";
import { CliError } from "../src/errors.js";
import { detectArtifactAbi } from "../src/plan.js";
import { writeFakeApk } from "./zip-fixture.js";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "testflight-apk-"));
}

const MANIFEST = {
  packageName: "com.example.app",
  versionCode: 12,
  versionName: "1.2.0",
  minSdk: 24,
  targetSdk: 36,
};

test("scanApk finds native ABIs and parses the manifest", async () => {
  const directory = await tempDir();
  try {
    const single = await writeFakeApk(directory, "app-arm64-v8a.apk", ["arm64-v8a"], MANIFEST);
    const singleScan = await scanApk(single);
    assert.deepEqual(singleScan.abis, ["arm64-v8a"]);
    assert.equal(singleScan.hasNativeLibs, true);
    assert.equal(singleScan.zip64, false);
    assert.equal(singleScan.metadataError, null);
    assert.equal(singleScan.metadata?.packageName, "com.example.app");
    assert.equal(singleScan.metadata?.versionCode, 12);

    const fat = await writeFakeApk(directory, "app-universal.apk", [
      "armeabi-v7a",
      "arm64-v8a",
      "x86_64",
    ], MANIFEST);
    const fatScan = await scanApk(fat);
    assert.deepEqual(fatScan.abis, ["arm64-v8a", "armeabi-v7a", "x86_64"]);
    assert.equal(fatScan.metadata?.universal, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scanApk reports no native libs for pure-Java APKs", async () => {
  const directory = await tempDir();
  try {
    const file = await writeFakeApk(directory, "app-release.apk", [], MANIFEST);
    const scan = await scanApk(file);
    assert.deepEqual(scan.abis, []);
    assert.equal(scan.hasNativeLibs, false);
    assert.equal(scan.metadata?.universal, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scanApk keeps working when the manifest is corrupt", async () => {
  const directory = await tempDir();
  try {
    const file = await writeFakeApk(
      directory,
      "app-arm64-v8a.apk",
      ["arm64-v8a"],
      {},
      { manifest: "not a manifest" },
    );
    const scan = await scanApk(file);
    assert.deepEqual(scan.abis, ["arm64-v8a"]);
    assert.equal(scan.metadata, null);
    assert.match(scan.metadataError ?? "", /not valid AXML/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scanApk reports ZIP64 archives without failing the scan", async () => {
  const directory = await tempDir();
  try {
    const file = await writeFakeApk(directory, "app-arm64-v8a.apk", ["arm64-v8a"], MANIFEST);
    const bytes = await import("node:fs/promises").then((fs) => fs.readFile(file));
    // Turn the EOCD's entry count into the ZIP64 sentinel.
    const eocd = bytes.length - 22;
    bytes.writeUInt16LE(0xffff, eocd + 10);
    await writeFile(file, bytes);

    const scan = await scanApk(file);
    assert.equal(scan.zip64, true);
    assert.equal(scan.metadata, null);
    assert.match(scan.metadataError ?? "", /ZIP64/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scanApk rejects files that are not ZIP archives", async () => {
  const directory = await tempDir();
  try {
    const file = path.join(directory, "broken.apk");
    await writeFile(file, "definitely not a zip archive");
    await assert.rejects(() => scanApk(file), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.match(error.message, /not a readable APK/);
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("detectArtifactAbi prefers contents, then filename, then universal", async () => {
  const directory = await tempDir();
  try {
    const arm64 = await writeFakeApk(directory, "app-arm64-v8a.apk", ["arm64-v8a"], MANIFEST);
    const arm64Detection = await detectArtifactAbi(arm64, undefined);
    assert.equal(arm64Detection.abi, "arm64-v8a");
    assert.equal(arm64Detection.source, "contents");
    assert.deepEqual(arm64Detection.detectedAbis, ["arm64-v8a"]);

    const fat = await writeFakeApk(directory, "release.apk", ["arm64-v8a", "x86_64"], MANIFEST);
    assert.equal((await detectArtifactAbi(fat, undefined)).abi, "universal");

    // The manifest is readable, so its zero native libs win over the filename.
    const plain = await writeFakeApk(directory, "app-x86.apk", [], MANIFEST);
    const plainDetection = await detectArtifactAbi(plain, undefined);
    assert.equal(plainDetection.abi, "universal");
    assert.equal(plainDetection.source, "contents");

    const unnamed = await writeFakeApk(directory, "app-release.apk", [], MANIFEST);
    assert.equal((await detectArtifactAbi(unnamed, undefined)).abi, "universal");

    const explicit = await detectArtifactAbi(arm64, "x86");
    assert.equal(explicit.abi, "x86");
    assert.equal(explicit.source, "flag");
    assert.equal(explicit.artifactAbi, "arm64-v8a");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
