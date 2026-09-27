import test from "node:test";
import assert from "node:assert/strict";
import { buildLatestJson, isPrerelease, isSemver, readVersions } from "./release.mjs";

test("latest feed keeps beta versions as SemVer", () => {
  const latest = buildLatestJson({
    version: "0.1.0-beta.2",
    notes: "Beta fixes",
    pubDate: "2026-09-28T00:00:00.000Z",
    signature: "  signature-value\n",
    archiveUrl: "https://github.com/sayre4ux/openviewer/releases/download/v0.1.0-beta.2/OpenViewer.app.tar.gz",
    arch: "aarch64",
  });
  assert.equal(latest.version, "0.1.0-beta.2");
  assert.equal(latest.platforms["darwin-aarch64"].signature, "signature-value");
  assert.equal(latest.platforms["darwin-aarch64"].url, "https://github.com/sayre4ux/openviewer/releases/download/v0.1.0-beta.2/OpenViewer.app.tar.gz");
  assert.deepEqual(Object.keys(latest.platforms), ["darwin-aarch64"]);
});

test("universal builds advertise both macOS architectures", () => {
  const latest = buildLatestJson({
    version: "0.1.0",
    notes: "First release",
    pubDate: "2026-09-28T00:00:00.000Z",
    signature: "signature-value",
    archiveUrl: "https://example.invalid/OpenViewer.app.tar.gz",
    arch: "universal",
  });
  assert.deepEqual(Object.keys(latest.platforms), ["darwin-aarch64", "darwin-x86_64"]);
  assert.equal(latest.platforms["darwin-aarch64"].url, latest.platforms["darwin-x86_64"].url);
});

test("pre-release detection validates SemVer first", () => {
  assert.equal(isSemver("0.1.0-beta.2"), true);
  assert.equal(isPrerelease("0.1.0-beta.2"), true);
  assert.equal(isPrerelease("0.1.0"), false);
  assert.equal(isPrerelease("0.1.0-beta.01"), false);
});

test("release script reads the three app versions", () => {
  const versions = readVersions();
  assert.deepEqual(Object.keys(versions), ["package", "cargo", "tauri"]);
  assert.equal(new Set(Object.values(versions)).size, 1);
});
