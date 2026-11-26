import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildReleasePlan,
  conflictingAbis,
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

test("buildReleasePlan detects ABIs and orders artifacts by priority", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-plan-"));
  try {
    const arm64 = await writeFakeApk(directory, "app-arm64-v8a.apk", ["arm64-v8a"]);
    const x86 = await writeFakeApk(directory, "app-x86_64.apk", ["x86_64"]);
    const universal = await writeFakeApk(directory, "app.apk", []);

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
    assert.equal(plan.artifacts.find((artifact) => artifact.abi === "universal")?.source, "default");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("buildReleasePlan maps repeated --abi flags positionally", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-plan-"));
  try {
    const first = await writeFakeApk(directory, "first.apk", ["arm64-v8a"]);
    const second = await writeFakeApk(directory, "second.apk", ["x86_64"]);

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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("buildReleasePlan rejects duplicate ABIs and mismatched --abi counts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-plan-"));
  try {
    const arm64a = await writeFakeApk(directory, "a.apk", ["arm64-v8a"]);
    const arm64b = await writeFakeApk(directory, "b.apk", ["arm64-v8a"]);

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
      { path: "", fileName: "", sizeBytes: 1, abi: "arm64-v8a", source: "flag", detectedAbis: [] },
      { path: "", fileName: "", sizeBytes: 1, abi: "x86", source: "flag", detectedAbis: [] },
    ]),
    ["arm64-v8a"],
  );
});
