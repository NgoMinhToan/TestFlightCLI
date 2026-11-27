import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ApkInspectionError,
  artifactAbiOf,
  inspectApkBuffer,
  parseApkMetadata,
  parseAxmlManifest,
  type ApkMetadata,
} from "../src/apk-manifest.js";
import { buildAxmlManifest, buildZip } from "./zip-fixture.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "fixtures", "manifest.axml.b64");

async function realManifest(): Promise<Buffer> {
  const base64 = (await readFile(fixturePath, "utf8")).trim();
  return Buffer.from(base64, "base64");
}

function apkBuffer(manifest: Buffer, abis: string[] = [], method: 0 | 8 = 0): Buffer {
  return buildZip([
    { name: "AndroidManifest.xml", data: manifest, method },
    ...abis.map((abi) => ({
      name: `lib/${abi}/libtest.so`,
      data: `native-${abi}`,
      method,
    })),
  ]);
}

function patchFirstEntry(zip: Buffer, patch: (central: Buffer) => void): Buffer {
  const copy = Buffer.from(zip);
  const eocd = copy.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "EOCD not found");
  const centralOffset = copy.readUInt32LE(eocd + 16);
  assert.equal(copy.readUInt32LE(centralOffset), 0x02014b50);
  patch(copy.subarray(centralOffset));
  return copy;
}

async function rejectsWith(
  promise: Promise<unknown>,
  code: "invalid_apk" | "zip64",
  pattern?: RegExp,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ApkInspectionError);
    assert.equal(error.code, code);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test("parses the shared real-AXML fixture", async () => {
  const metadata = parseAxmlManifest(await realManifest());
  const expected = {
    packageName: "dev.minhtoan.mytestflight",
    versionCode: 18,
    versionName: "0.2.0",
    minSdk: 26,
    targetSdk: 37,
  };
  assert.deepEqual(
    {
      packageName: metadata.packageName,
      versionCode: metadata.versionCode,
      versionName: metadata.versionName,
      minSdk: metadata.minSdk,
      targetSdk: metadata.targetSdk,
    },
    expected,
  );
  assert.equal(metadata.debuggable, false);
  assert.equal(metadata.testOnly, false);
  assert.equal(metadata.split, null);
  assert.equal(metadata.configSplit, false);

  const detected = await inspectApkBuffer(apkBuffer(await realManifest(), ["arm64-v8a"]));
  assert.equal(detected.artifactAbi, "arm64-v8a");
  assert.deepEqual(detected.abis, ["arm64-v8a"]);
  assert.equal(detected.universal, false);
});

test("parses stored and deflated manifests, UTF-8 and UTF-16", async () => {
  for (const method of [0, 8] as const) {
    for (const utf8 of [false, true]) {
      const manifest = buildAxmlManifest(
        {
          packageName: "com.example.demo",
          versionCode: 42,
          versionName: "4.2.0",
          minSdk: 23,
          targetSdk: 35,
          debuggable: true,
          testOnly: true,
        },
        { utf8 },
      );
      const metadata = await parseApkMetadata(apkBuffer(manifest, ["x86_64"], method));
      assert.equal(metadata.packageName, "com.example.demo", `method=${method} utf8=${utf8}`);
      assert.equal(metadata.versionCode, 42);
      assert.equal(metadata.versionName, "4.2.0");
      assert.equal(metadata.minSdk, 23);
      assert.equal(metadata.targetSdk, 35);
      assert.equal(metadata.debuggable, true);
      assert.equal(metadata.testOnly, true);
      assert.deepEqual(metadata.abis, ["x86_64"]);
    }
  }
});

test("maps resource references and codenames to null", async () => {
  const manifest = buildAxmlManifest({
    packageName: "com.example.refs",
    versionCode: 5,
    versionNameReference: true,
    minSdkString: "S",
    targetSdkString: "S",
  });
  const metadata = parseAxmlManifest(manifest);
  assert.equal(metadata.versionName, null);
  assert.equal(metadata.minSdk, null);
  assert.equal(metadata.targetSdk, null);
});

test("requires a literal positive versionCode", async () => {
  const reference = buildAxmlManifest({
    packageName: "com.example.bad",
    versionCodeReference: true,
  });
  await rejectsWith(Promise.resolve().then(() => parseAxmlManifest(reference)), "invalid_apk", /versionCode/);

  const zero = buildAxmlManifest({ packageName: "com.example.bad", versionCode: 0 });
  await rejectsWith(Promise.resolve().then(() => parseAxmlManifest(zero)), "invalid_apk", /versionCode/);
});

test("detects config splits", () => {
  const byName = parseAxmlManifest(
    buildAxmlManifest({ packageName: "com.example.split", versionCode: 3, split: "config.arm64_v8a" }),
  );
  assert.equal(byName.configSplit, true);
  assert.equal(byName.split, "config.arm64_v8a");

  const byAttribute = parseAxmlManifest(
    buildAxmlManifest({ packageName: "com.example.split", versionCode: 3, configForSplit: true }),
  );
  assert.equal(byAttribute.configSplit, true);

  const feature = parseAxmlManifest(
    buildAxmlManifest({ packageName: "com.example.split", versionCode: 3, split: "feature" }),
  );
  assert.equal(feature.configSplit, false);
});

test("computes artifactAbi from the native library set", async () => {
  const manifest = buildAxmlManifest({ packageName: "com.example.abi", versionCode: 1 });
  const one = await inspectApkBuffer(apkBuffer(manifest, ["arm64-v8a"]));
  assert.equal(one.artifactAbi, "arm64-v8a");

  const many = await inspectApkBuffer(apkBuffer(manifest, ["arm64-v8a", "x86_64"]));
  assert.equal(many.artifactAbi, "universal");
  assert.equal(many.universal, true);

  const none = await inspectApkBuffer(apkBuffer(manifest));
  assert.equal(none.artifactAbi, "universal");
  assert.equal(artifactAbiOf(none), "universal");
  const asMetadata: ApkMetadata = none;
  assert.deepEqual(asMetadata.abis, []);
});

test("rejects ZIP64 archives with a typed error", async () => {
  const manifest = buildAxmlManifest({ packageName: "com.example.zip", versionCode: 1 });
  const zip = Buffer.from(apkBuffer(manifest));
  zip.writeUInt16LE(0xffff, zip.length - 22 + 10);
  await rejectsWith(inspectApkBuffer(zip), "zip64", /ZIP64/);
});

test("rejects a corrupt or missing manifest", async () => {
  await rejectsWith(
    inspectApkBuffer(apkBuffer(Buffer.from("definitely not axml bytes"))),
    "invalid_apk",
    /AXML/,
  );

  const withoutManifest = buildZip([{ name: "classes.dex", data: "dex" }]);
  await rejectsWith(inspectApkBuffer(withoutManifest), "invalid_apk", /missing/);
});

test("enforces the compressed and inflated manifest size caps", async () => {
  const manifest = buildAxmlManifest({ packageName: "com.example.cap", versionCode: 1 });
  const zip = apkBuffer(manifest);

  const tooCompressed = patchFirstEntry(zip, (central) => {
    central.writeUInt32LE(16 * 1024 * 1024 + 1, 20);
  });
  await rejectsWith(inspectApkBuffer(tooCompressed), "invalid_apk", /16 MiB/);

  const tooLarge = patchFirstEntry(zip, (central) => {
    central.writeUInt32LE(8 * 1024 * 1024 + 1, 24);
  });
  await rejectsWith(inspectApkBuffer(tooLarge), "invalid_apk", /8 MiB/);

  const unsupported = patchFirstEntry(zip, (central) => {
    central.writeUInt16LE(12, 10);
  });
  await rejectsWith(inspectApkBuffer(unsupported), "invalid_apk", /compression method/);
});

test("rejects non-ZIP input", async () => {
  await rejectsWith(
    inspectApkBuffer(Buffer.from("not a zip at all")),
    "invalid_apk",
    /too small|end-of-central-directory/,
  );
  await rejectsWith(
    inspectApkBuffer(Buffer.alloc(64, 0x41)),
    "invalid_apk",
    /end-of-central-directory/,
  );
});
