import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildLatestJson, isPrerelease, isSemver, parseArgs, readVersions, updaterPublicKey, verifyUpdaterSignature } from "./release.mjs";

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

test("publishing needs a universal build", () => {
  assert.throws(() => parseArgs(["--publish"]), /--universal/);
  assert.deepEqual(parseArgs(["--publish", "--universal"]), { version: null, universal: true, publish: true });
  assert.equal(parseArgs([]).publish, false);
});

// Made with throwaway keys (`tauri signer generate`, `tauri signer sign` on the bytes "hello archive");
// the private keys were never kept. SIG_A names no version; SIG_V was signed with `--app-version 0.1.0`,
// as the bundler signs every build.
const KEY_A = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDRDRkIzNDBCM0NBRUI5QzMKUldURHVhNDhDelQ3VERKYmNMQUZ2NDQ4UEdhdFBEWEJWMXNCbXhMZzEyNUZMSEdoZXlRY2lhU0cK";
const KEY_B = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQ1RTk2NDJBN0Y1NzIwRUEKUldUcUlGZC9LbVRwUlNTbHg3ZGROOEI0VWlOVEtnb1BoMEk1SUlKaXhHaDdiUWhJSWZlYnhtSHAK";
const SIG_V = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVURHVhNDhDelQ3VE44NW82QmZ6QWRJK2xTRWhYTmlJNnEzbVcrSHE1UTFEdkdlKzVvVVhyYjFiVXpydDZxQnlwUzRyRkRNcmV3VGV3aFlNSytnRWJPa2ZTUUloaXc1Z1FrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkwNTY3OTkwCWZpbGU6di50YXIuZ3oJdmVyc2lvbjowLjEuMApmelFRVVhmbXVmSUg2SlhqZXlJVlVLUlloR1FCeXA1bGhOYkdtVllWdloySzM5b2daTzMvOCt6RXlHbXhiZUxPU1V6T2RTSThkWW5mS3luY00vNklBZz09Cg==";
const SIG_A = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVURHVhNDhDelQ3VEU1M0t2c0QzdEQwVHRQMmpIcmFGZ1JkaUdMLzlOSk54Zmt3RXpOQ0wzWWpVdmVnT2kvNjFwWGNFZHkwdmJNN3Q2NDcyRVlmbGpIMFRYYWdUQWFWanc4PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkwNTYzNjE0CWZpbGU6YS50YXIuZ3oKdEYxQTFlTUtnbkhaT0t1SUZCc3I5NFFMcWJLbmw1YzRVZ3o5OStQdmFEMXV5NzNMYi9Zb0NUUU85VW9XRXBGeG0xYXlvTHFOaGZUNnRjd3RiaTFmQXc9PQo=";
const keyConfig = (pubkey) => ({ plugins: { updater: { pubkey } } });
const archive = Buffer.from("hello archive");

test("the updater pubkey must be the .pub file's base64", () => {
  assert.equal(updaterPublicKey(keyConfig(KEY_A)).key.length, 32);
  assert.throws(() => updaterPublicKey(keyConfig("REPLACE_WITH_PUBLIC_KEY")), /placeholder/);
  // The decoded key line on its own is what Tauri can't read.
  const rawLine = Buffer.from(KEY_A, "base64").toString("utf8").split("\n")[1];
  assert.throws(() => updaterPublicKey(keyConfig(rawLine)), /\.pub file/);
});

test("an update signature is checked against the app's public key", () => {
  const keyA = updaterPublicKey(keyConfig(KEY_A));
  verifyUpdaterSignature(archive, SIG_V, keyA, "0.1.0");
  assert.throws(() => verifyUpdaterSignature(archive, SIG_V, keyA, "0.1.1"), /signed for version 0\.1\.0, not 0\.1\.1/);
  // The app requires a signed version (requireSignedVersion), so a signature without one is refused.
  assert.throws(() => verifyUpdaterSignature(archive, SIG_A, keyA, "0.1.0"), /doesn't name a version/);
  assert.throws(() => verifyUpdaterSignature(Buffer.from("hello archivf"), SIG_V, keyA, "0.1.0"), /doesn't match the archive/);
  assert.throws(() => verifyUpdaterSignature(archive, SIG_V, updaterPublicKey(keyConfig(KEY_B)), "0.1.0"), /different key \(key id 4CFB340B3CAEB9C3\)/);
  // A trusted comment edited after signing (here: a version added) fails the global signature.
  const text = Buffer.from(SIG_A, "base64").toString("utf8").replace("file:a.tar.gz", "file:a.tar.gz\tversion:0.1.0");
  assert.throws(() => verifyUpdaterSignature(archive, Buffer.from(text).toString("base64"), keyA, "0.1.0"), /trusted comment/);
});

test("release builds require a signed version", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.release.conf.json", import.meta.url), "utf8"));
  assert.equal(config.plugins.updater.requireSignedVersion, true);
});
