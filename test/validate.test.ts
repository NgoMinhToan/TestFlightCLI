import assert from "node:assert/strict";
import test from "node:test";
import { isValidId, isValidVersionName } from "../src/validate.js";

test("isValidVersionName accepts Play Console-style names", () => {
  for (const value of [
    "1.0.0",
    "1.0.0+42",
    "Bản nội bộ (beta)",
    "release candidate [2]",
    "2026-11-27_rc.1",
    "x".repeat(200),
  ]) {
    assert.equal(isValidVersionName(value), true, value);
  }
});

test("isValidVersionName rejects blank and path-unsafe names", () => {
  for (const value of [
    "",
    " ",
    " padded",
    "trailing ",
    ".",
    "..",
    ".hidden",
    "hidden.",
    "a/b",
    "a\\b",
    "a\u0000b",
    "a\u001fb",
    "a\u007fb",
    "a\u009fb",
    "x".repeat(201),
  ]) {
    assert.equal(isValidVersionName(value), false, JSON.stringify(value));
  }
});

test("isValidId keeps the stricter app id rule", () => {
  assert.equal(isValidId("crm"), true);
  assert.equal(isValidId("demo-app_2.0"), true);
  assert.equal(isValidId("1.0.0+42"), false);
  assert.equal(isValidId("Bản nội bộ (beta)"), false);
  assert.equal(isValidId(""), false);
});
