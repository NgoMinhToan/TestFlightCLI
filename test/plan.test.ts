import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildReleasePlan,
  conflictingAbis,
  detectArtifactAbi,
  metadataDifferences,
  type ReleaseInput,
} from "../src/plan.js";
import type { VersionAdmin } from "../src/api.js";
import { writeFakeApk } from "./zip-fixture.js";

function baseInput(overrides: Partial<ReleaseInput> = {}): ReleaseInput {
  return {
    appId: "crm",
    versionName: "1.4.2",
    versionCodeRaw: "142",
    apkPaths: [],
    abiFlags: [],
    createApp: false,
    force: false,
    dryRun: true,
    appMetadata: {},
    ...overrides,
  };
}

const MANIFEST = {
  packageName: "com.example.app",
  versionCode: 142,
  versionName: "1.4.2",
  minSdk: 26,
  targetSdk: 37,
};

test("buildReleasePlan detects ABIs and orders artifacts by priority", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-plan-"));
  try {
    const arm64 = await writeFakeApk(directory, "app-arm64-v8a.apk", ["arm64-v8a"], MANIFEST);
    const x86 = await writeFakeApk(directory, "app-x86_64.apk", ["x86_64"], MANIFEST);
    const universal = await writeFakeApk(directory, "app.apk", [], MANIFEST);

    const plan = await buildReleasePlan(
      baseInput({
        apkPaths: [x86, arm64, universal],
        minSdkRaw: "26",
        releaseNotes: "Fixes login timeout",
        publishedAt: "2026-11-19T08:00:00Z",
      }),
    );

    assert.deepEqual(
      plan.artifacts.map((artifact) => artifact.abi),
      ["universal", "arm64-v8a", "x86_64"],
    );
    assert.equal(plan.versionCode, 142);
    assert.deepEqual(plan.metadata, {
      versionName: "1.4.2",
      versionCode: 142,
      minSdk: 26,
      releaseNotes: "Fixes login timeout",
      publishedAt: "2026-11-19T08:00:00.000Z",
    });
    assert.equal(plan.artifacts.find((artifact) => artifact.abi === "x86_64")?.source, "contents");
    // Zero native ABIs is universal now that the manifest is authoritative.
    assert.equal(plan.artifacts.find((artifact) => artifact.abi === "universal")?.source, "contents");
    assert.equal(plan.versionNameInferred, false);
    assert.equal(plan.versionCodeInferred, false);
    assert.deepEqual(plan.allowMismatch, []);
    assert.deepEqual(plan.warnings, []);
    assert.deepEqual(plan.detected, { versionName: "1.4.2", versionCode: 142 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("buildReleasePlan infers version name and code from the first APK", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-plan-"));
  try {
    const apk = await writeFakeApk(directory, "app-arm64-v8a.apk", ["arm64-v8a"], {
      packageName: "dev.minhtoan.mytestflight",
      versionCode: 18,
      versionName: "0.2.0",
      minSdk: 26,
    });

    const plan = await buildReleasePlan(
      baseInput({ apkPaths: [apk], versionName: undefined, versionCodeRaw: undefined }),
    );

    assert.equal(plan.versionName, "0.2.0");
    assert.equal(plan.versionCode, 18);
    assert.equal(plan.versionNameInferred, true);
    assert.equal(plan.versionCodeInferred, true);
    assert.deepEqual(plan.allowMismatch, []);
    assert.deepEqual(plan.artifacts[0]?.metadata?.packageName, "dev.minhtoan.mytestflight");
    assert.equal(plan.artifacts[0]?.artifactAbi, "arm64-v8a");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("buildReleasePlan accepts flexible version names", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-plan-"));
  try {
    const apk = await writeFakeApk(directory, "app-arm64-v8a.apk", ["arm64-v8a"], MANIFEST);
    for (const versionName of ["1.0.0+42", "Bản nội bộ (beta)", "release candidate [2]"]) {
      const plan = await buildReleasePlan(
        baseInput({ apkPaths: [apk], versionName, versionCodeRaw: "142" }),
      );
      assert.equal(plan.versionName, versionName);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("buildReleasePlan falls back to String(versionCode) when versionName is a reference", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-plan-"));
  try {
    const apk = await writeFakeApk(directory, "app-arm64-v8a.apk", ["arm64-v8a"], {
      ...MANIFEST,
      versionCode: 300,
      versionNameReference: true,
    });
    const plan = await buildReleasePlan(
      baseInput({ apkPaths: [apk], versionName: undefined, versionCodeRaw: undefined }),
    );
    assert.equal(plan.versionName, "300");
    assert.equal(plan.versionNameInferred, true);
    assert.deepEqual(plan.allowMismatch, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("buildReleasePlan rejects path-unsafe version names", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-plan-"));
  try {
    const apk = await writeFakeApk(directory, "app-arm64-v8a.apk", ["arm64-v8a"], MANIFEST);
    for (const versionName of [
      "../escape",
      "a/b",
      "a\\b",
      "a\u0000b",
      " padded",
      "trailing ",
      ".hidden",
      ".",
      "..",
      "x".repeat(201),
    ]) {
      await assert.rejects(
        () => buildReleasePlan(baseInput({ apkPaths: [apk], versionName })),
        /Invalid version name/,
        `expected "${versionName}" to be rejected`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit identity values that differ from the APK add allow_mismatch", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-plan-"));
  try {
    const apk = await writeFakeApk(directory, "app-arm64-v8a.apk", ["arm64-v8a"], {
      ...MANIFEST,
      versionCode: 18,
      versionName: "0.2.0",
      minSdk: 26,
    });

    const plan = await buildReleasePlan(
      baseInput({
        apkPaths: [apk],
        versionName: "9.9.9",
        versionCodeRaw: "999",
        minSdkRaw: "27",
        abiFlags: ["x86_64"],
      }),
    );

    assert.deepEqual(plan.allowMismatch, ["version", "sdk", "abi"]);
    assert.equal(plan.artifacts[0]?.abi, "x86_64");
    assert.equal(plan.artifacts[0]?.artifactAbi, "arm64-v8a");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("buildReleasePlan maps repeated --abi flags positionally", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-plan-"));
  try {
    const first = await writeFakeApk(directory, "first.apk", ["arm64-v8a"], MANIFEST);
    const second = await writeFakeApk(directory, "second.apk", ["x86_64"], MANIFEST);

    const plan = await buildReleasePlan(
      baseInput({
        apkPaths: [first, second],
        abiFlags: ["universal", "armeabi-v7a"],
      }),
    );
    assert.deepEqual(
      plan.artifacts.map((artifact) => [artifact.fileName, artifact.abi, artifact.source]),
      [
        ["first.apk", "universal", "flag"],
        ["second.apk", "armeabi-v7a", "flag"],
      ],
    );
    assert.deepEqual(plan.allowMismatch, ["abi"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("buildReleasePlan rejects duplicate ABIs and mismatched --abi counts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-plan-"));
  try {
    const arm64a = await writeFakeApk(directory, "a.apk", ["arm64-v8a"], MANIFEST);
    const arm64b = await writeFakeApk(directory, "b.apk", ["arm64-v8a"], MANIFEST);

    await assert.rejects(
      () => buildReleasePlan(baseInput({ apkPaths: [arm64a, arm64b] })),
      /resolve to ABI "arm64-v8a"/,
    );
    await assert.rejects(
      () => buildReleasePlan(baseInput({ apkPaths: [arm64a], abiFlags: ["mips"] })),
      /Unknown ABI/,
    );
    await assert.rejects(
      () =>
        buildReleasePlan(
          baseInput({
            apkPaths: [arm64a, arm64b],
            abiFlags: ["arm64-v8a", "x86", "x86_64"],
          }),
        ),
      /Got 3 --abi values for 2 APKs/,
    );
    await assert.rejects(
      () => buildReleasePlan(baseInput({ apkPaths: [path.join(directory, "missing.apk")] })),
      /APK not found/,
    );
    await assert.rejects(
      () => buildReleasePlan(baseInput({ apkPaths: [arm64a], versionCodeRaw: "0" })),
      /positive integer/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("buildReleasePlan rejects APKs from different packages or versions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-plan-"));
  try {
    const one = await writeFakeApk(directory, "one.apk", ["arm64-v8a"], MANIFEST);
    const otherPackage = await writeFakeApk(directory, "two.apk", ["x86_64"], {
      ...MANIFEST,
      packageName: "com.example.other",
    });
    const otherCode = await writeFakeApk(directory, "three.apk", ["x86"], {
      ...MANIFEST,
      versionCode: 143,
    });

    await assert.rejects(
      () => buildReleasePlan(baseInput({ apkPaths: [one, otherPackage] })),
      /different app versions/,
    );
    await assert.rejects(
      () => buildReleasePlan(baseInput({ apkPaths: [one, otherCode] })),
      (error: unknown) => {
        assert.match((error as { hint?: string }).hint ?? "", /versionCode/);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("buildReleasePlan warns but falls back to the filename when the manifest is unreadable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-plan-"));
  try {
    const apk = await writeFakeApk(
      directory,
      "app-x86_64.apk",
      [],
      {},
      { manifest: "this is not axml" },
    );
    const plan = await buildReleasePlan(
      baseInput({ apkPaths: [apk], versionName: "2.0.0", versionCodeRaw: "200" }),
    );
    assert.equal(plan.artifacts[0]?.source, "filename");
    assert.equal(plan.artifacts[0]?.abi, "x86_64");
    assert.equal(plan.artifacts[0]?.metadata, null);
    assert.match(plan.warnings[0] ?? "", /Cannot read AndroidManifest\.xml/);
    assert.match(plan.warnings[0] ?? "", /server may reject/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("detectArtifactAbi uses the manifest, then the filename only as a fallback", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-plan-"));
  try {
    const withLib = await writeFakeApk(directory, "app.apk", ["arm64-v8a"], MANIFEST);
    const single = await detectArtifactAbi(withLib, undefined);
    assert.equal(single.abi, "arm64-v8a");
    assert.equal(single.source, "contents");
    assert.equal(single.artifactAbi, "arm64-v8a");

    // A filename token must not override a readable manifest with no libs.
    const plain = await writeFakeApk(directory, "app-x86.apk", [], MANIFEST);
    const noLibs = await detectArtifactAbi(plain, undefined);
    assert.equal(noLibs.abi, "universal");
    assert.equal(noLibs.source, "contents");

    const corrupt = await writeFakeApk(
      directory,
      "broken-x86.apk",
      [],
      {},
      { manifest: "garbage" },
    );
    const fallback = await detectArtifactAbi(corrupt, undefined);
    assert.equal(fallback.abi, "x86");
    assert.equal(fallback.source, "filename");
    assert.ok(fallback.metadataError);

    const explicit = await detectArtifactAbi(withLib, "x86");
    assert.equal(explicit.abi, "x86");
    assert.equal(explicit.source, "flag");
    assert.equal(explicit.artifactAbi, "arm64-v8a");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("metadataDifferences and conflictingAbis describe replacement needs", async () => {
  const existing = {
    versionName: "1.4.2",
    versionCode: 142,
    minSdk: 26,
    releaseNotes: "old",
    publishedAt: "2026-11-19T08:00:00.000Z",
    draft: false,
    abis: ["arm64-v8a"],
    universal: false,
    artifacts: [
      {
        abi: "arm64-v8a",
        sizeBytes: 1,
        sha256: null,
        downloadPath: "/download",
        filename: "a.apk",
      },
    ],
    defaultArtifact: null,
    sizeBytes: 1,
    sha256: null,
    downloadPath: "/download",
  } satisfies VersionAdmin;

  assert.deepEqual(metadataDifferences(existing, {
    versionName: "1.4.2",
    versionCode: 143,
    minSdk: 27,
    releaseNotes: "new",
    publishedAt: "2026-11-20T08:00:00.000Z",
  }), [
    "versionCode 142 → 143",
    "minSdk 26 → 27",
    "release notes change",
    "publishedAt 2026-11-19T08:00:00.000Z → 2026-11-20T08:00:00.000Z",
  ]);

  assert.deepEqual(
    conflictingAbis(existing, [
      {
        path: "",
        fileName: "",
        sizeBytes: 1,
        abi: "arm64-v8a",
        source: "flag",
        detectedAbis: [],
        metadata: null,
        metadataError: null,
        artifactAbi: "arm64-v8a",
      },
      {
        path: "",
        fileName: "",
        sizeBytes: 1,
        abi: "x86",
        source: "flag",
        detectedAbis: [],
        metadata: null,
        metadataError: null,
        artifactAbi: "x86",
      },
    ]),
    ["arm64-v8a"],
  );
});
