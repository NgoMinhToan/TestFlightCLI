import assert from "node:assert/strict";
import test from "node:test";
import { inferAbiFromFilename, normalizeAbi, sortAbis } from "../src/abi.js";

test("normalizeAbi accepts the server's labels case-insensitively", () => {
  assert.equal(normalizeAbi("ARM64-V8A"), "arm64-v8a");
  assert.equal(normalizeAbi(" x86_64 "), "x86_64");
  assert.equal(normalizeAbi("mips"), null);
});

test("inferAbiFromFilename prefers the most specific token", () => {
  assert.equal(inferAbiFromFilename("app-armeabi-v7a.apk"), "armeabi-v7a");
  assert.equal(inferAbiFromFilename("app-armeabi.apk"), "armeabi");
  assert.equal(inferAbiFromFilename("app-x86_64.apk"), "x86_64");
  assert.equal(inferAbiFromFilename("app_x86_release.apk"), "x86");
  assert.equal(inferAbiFromFilename("app-arm64-v8a.apk"), "arm64-v8a");
  assert.equal(inferAbiFromFilename("release-universal.apk"), "universal");
  assert.equal(inferAbiFromFilename("app-release.apk"), null);
  assert.equal(inferAbiFromFilename("arm64-v8a.apk"), "arm64-v8a");
});

test("sortAbis follows the server's default-artifact priority", () => {
  assert.deepEqual(sortAbis(["x86", "universal", "arm64-v8a", "armeabi"]), [
    "universal",
    "arm64-v8a",
    "x86",
    "armeabi",
  ]);
});
