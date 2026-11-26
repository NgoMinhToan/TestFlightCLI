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

test("scanApk finds native ABIs in lib/<abi>/", async () => {
  const directory = await tempDir();
  try {
    const single = await writeFakeApk(directory, "app-arm64-v8a.apk", ["arm64-v8a"]);
    const singleScan = await scanApk(single);
    assert.deepEqual(singleScan.abis, ["arm64-v8a"]);
    assert.equal(singleScan.hasNativeLibs, true);
    assert.equal(singleScan.zip64, false);

    const fat = await writeFakeApk(directory, "app-universal.apk", [
      "armeabi-v7a",
      "arm64-v8a",
      "x86_64",
    ]);
    const fatScan = await scanApk(fat);
    assert.deepEqual(fatScan.abis, ["arm64-v8a", "armeabi-v7a", "x86_64"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scanApk reports no native libs for pure-Java APKs", async () => {
  const directory = await tempDir();
  try {
    const file = await writeFakeApk(directory, "app-release.apk", []);
    const scan = await scanApk(file);
    assert.deepEqual(scan.abis, []);
    assert.equal(scan.hasNativeLibs, false);
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
    const arm64 = await writeFakeApk(directory, "app-arm64-v8a.apk", ["arm64-v8a"]);
    assert.deepEqual(await detectArtifactAbi(arm64, undefined), {
      abi: "arm64-v8a",
      source: "contents",
      detectedAbis: ["arm64-v8a"],
    });

    const fat = await writeFakeApk(directory, "release.apk", ["arm64-v8a", "x86_64"]);
    assert.equal((await detectArtifactAbi(fat, undefined)).abi, "universal");

    const plain = await writeFakeApk(directory, "app-x86.apk", []);
    assert.deepEqual(await detectArtifactAbi(plain, undefined), {
      abi: "x86",
      source: "filename",
      detectedAbis: [],
    });

    const unnamed = await writeFakeApk(directory, "app-release.apk", []);
    assert.deepEqual(await detectArtifactAbi(unnamed, undefined), {
      abi: "universal",
      source: "default",
      detectedAbis: [],
    });

    assert.equal((await detectArtifactAbi(arm64, "x86")).abi, "x86");
    assert.equal((await detectArtifactAbi(arm64, "x86")).source, "flag");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
