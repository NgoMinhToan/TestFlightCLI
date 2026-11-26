import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  configFileMode,
  configPath,
  readConfigFile,
  removeProfile,
  resolveSettings,
  saveProfile,
  setDefaultProfile,
} from "../src/config.js";

async function workspace(): Promise<{ directory: string; filePath: string; env: NodeJS.ProcessEnv }> {
  const directory = await mkdtemp(path.join(tmpdir(), "testflight-config-"));
  const filePath = path.join(directory, "nested", "config.json");
  return { directory, filePath, env: { TESTFLIGHT_CONFIG: filePath } };
}

test("configPath honours TESTFLIGHT_CONFIG and XDG_CONFIG_HOME", () => {
  assert.equal(configPath({ TESTFLIGHT_CONFIG: "/tmp/x/config.json" }), "/tmp/x/config.json");
  assert.equal(
    configPath({ XDG_CONFIG_HOME: "/tmp/xdg" }),
    path.join("/tmp/xdg", "testflight", "config.json"),
  );
});

test("saveProfile writes a private config and can re-read it", async () => {
  const { directory, filePath, env } = await workspace();
  try {
    assert.deepEqual(await readConfigFile(filePath), {
      version: 1,
      defaultProfile: "default",
      profiles: {},
    });

    await saveProfile({
      name: "default",
      baseUrl: "http://127.0.0.1:8080",
      managementKey: "secret-key",
      filePath,
    });
    await saveProfile({
      name: "staging",
      baseUrl: "https://staging.example.com/testflight",
      managementKey: "staging-key",
      filePath,
    });

    const config = await readConfigFile(filePath);
    assert.equal(config.defaultProfile, "default");
    assert.equal(config.profiles.default?.managementKey, "secret-key");
    assert.equal(config.profiles.staging?.baseUrl, "https://staging.example.com/testflight");

    if (process.platform !== "win32") {
      assert.equal((await configFileMode(filePath))! & 0o077, 0);
    }

    await setDefaultProfile("staging", filePath);
    assert.equal((await readConfigFile(filePath)).defaultProfile, "staging");

    const settings = await resolveSettings({}, env);
    assert.equal(settings.profile, "staging");
    assert.equal(settings.baseUrl, "https://staging.example.com/testflight");
    assert.equal(settings.managementKey, "staging-key");

    assert.equal(await removeProfile("staging", filePath), true);
    const afterRemoval = await readConfigFile(filePath);
    assert.equal(afterRemoval.defaultProfile, "default");
    assert.equal(afterRemoval.profiles.staging, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("environment variables override the saved profile", async () => {
  const { directory, filePath, env } = await workspace();
  try {
    await saveProfile({
      name: "default",
      baseUrl: "http://saved:8080",
      managementKey: "saved-key",
      filePath,
    });

    const settings = await resolveSettings(
      {},
      {
        ...env,
        TESTFLIGHT_BASE_URL: "https://env.example.com/prefix/",
        TESTFLIGHT_MANAGEMENT_KEY: "env-key",
      },
    );
    assert.equal(settings.baseUrl, "https://env.example.com/prefix");
    assert.equal(settings.managementKey, "env-key");
    assert.ok(settings.sources.includes("TESTFLIGHT_BASE_URL"));

    const flagged = await resolveSettings(
      { baseUrl: "http://flag:9000", key: "flag-key" },
      env,
    );
    assert.equal(flagged.baseUrl, "http://flag:9000");
    assert.equal(flagged.managementKey, "flag-key");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resolveSettings rejects unknown profiles and missing configuration", async () => {
  const { directory, env } = await workspace();
  try {
    await assert.rejects(
      () => resolveSettings({ profile: "nope" }, env),
      /Unknown profile/,
    );
    await assert.rejects(() => resolveSettings({}, env), /No MyTestflight server/);
    await assert.rejects(
      () =>
        resolveSettings(
          { baseUrl: "http://127.0.0.1:8080", requireKey: true },
          { TESTFLIGHT_CONFIG: env.TESTFLIGHT_CONFIG },
        ),
      /No management key/,
    );
    await assert.rejects(
      () =>
        saveProfile({
          name: "bad name!",
          baseUrl: "http://127.0.0.1:8080",
          managementKey: "key",
          filePath: env.TESTFLIGHT_CONFIG!,
        }),
      /Invalid profile name/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
