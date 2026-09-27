import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { arch as hostArch } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = "sayre4ux/openviewer";
const FEED_TAG = "updates";
const releaseConfigPath = join(root, "src-tauri/tauri.release.conf.json");
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isSemver(version) {
  return typeof version === "string" && semver.test(version);
}

export function isPrerelease(version) {
  return isSemver(version) && version.split("+")[0].includes("-");
}

export function buildLatestJson({ version, notes, pubDate, signature, archiveUrl, arch }) {
  if (!isSemver(version)) throw new Error(`Invalid SemVer version: ${version}`);
  if (!signature?.trim()) throw new Error("The updater signature is empty");
  if (!archiveUrl) throw new Error("The updater archive URL is empty");
  const entry = { signature: signature.trim(), url: archiveUrl };
  const platforms = arch === "universal"
    ? { "darwin-aarch64": entry, "darwin-x86_64": entry }
    : { [`darwin-${arch}`]: entry };
  return { version, notes, pub_date: pubDate, platforms };
}

function fail(message) {
  throw new Error(message);
}

function commandOutput(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    env: process.env,
  });
  if (result.error) fail(`Couldn't run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const details = options.inherit ? "" : (result.stderr || result.stdout || "").trim();
    fail(`${command} ${args.join(" ")} failed${details ? `:\n${details}` : ""}`);
  }
  return result.stdout ?? "";
}

function assertCleanTree() {
  const status = commandOutput("git", ["status", "--porcelain", "--untracked-files=all"]);
  if (status.trim()) {
    fail(`The git tree must be clean before a release. Current changes:\n${status.trim()}`);
  }
}

export function readVersions() {
  const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const tauriVersion = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8")).version;
  const cargo = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
  const packageSection = cargo.match(/^\[package\]([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
  const cargoVersion = packageSection?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!cargoVersion) fail("Couldn't read [package].version from src-tauri/Cargo.toml");
  return { package: packageVersion, cargo: cargoVersion, tauri: tauriVersion };
}

function updateCargoLock(version) {
  const path = join(root, "src-tauri/Cargo.lock");
  if (!existsSync(path)) return;
  const lock = readFileSync(path, "utf8");
  const marker = 'name = "openviewer"';
  const nameAt = lock.indexOf(marker);
  if (nameAt < 0) fail("Couldn't find the openviewer package in src-tauri/Cargo.lock");
  const start = lock.lastIndexOf("[[package]]", nameAt);
  const next = lock.indexOf("[[package]]", nameAt);
  const end = next < 0 ? lock.length : next;
  const section = lock.slice(start, end);
  const changed = section.replace(/^(version\s*=\s*")[^"]+("\s*)$/m, `$1${version}$2`);
  if (changed === section) fail("Couldn't update openviewer.version in src-tauri/Cargo.lock");
  // DECISION: Keep Cargo's locked root package version aligned with the three release version files.
  writeFileSync(path, lock.slice(0, start) + changed + lock.slice(end));
}

function setVersion(version) {
  const packagePath = join(root, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  packageJson.version = version;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const cargoPath = join(root, "src-tauri/Cargo.toml");
  const cargo = readFileSync(cargoPath, "utf8");
  const packageStart = cargo.indexOf("[package]");
  const nextSection = cargo.indexOf("\n[", packageStart + 1);
  if (packageStart < 0) fail("Couldn't find [package] in src-tauri/Cargo.toml");
  const sectionEnd = nextSection < 0 ? cargo.length : nextSection + 1;
  const section = cargo.slice(packageStart, sectionEnd);
  const changed = section.replace(/^(version\s*=\s*")[^"]+("\s*)$/m, `$1${version}$2`);
  if (changed === section) fail("Couldn't update [package].version in src-tauri/Cargo.toml");
  writeFileSync(cargoPath, cargo.slice(0, packageStart) + changed + cargo.slice(sectionEnd));

  const tauriPath = join(root, "src-tauri/tauri.conf.json");
  const tauriConfig = JSON.parse(readFileSync(tauriPath, "utf8"));
  tauriConfig.version = version;
  writeFileSync(tauriPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);
  updateCargoLock(version);

  const diff = commandOutput("git", ["diff", "--", "package.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json"]);
  if (diff.trim()) process.stdout.write(diff);
  else console.log(`All version files already contain ${version}.`);
}

function parseArgs(args) {
  const options = { version: null, universal: false, publish: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--version") {
      options.version = args[++index];
      if (!options.version) fail("--version needs a SemVer value");
    } else if (argument === "--universal") {
      options.universal = true;
    } else if (argument === "--publish") {
      options.publish = true;
    } else {
      fail(`Unknown release option: ${argument}`);
    }
  }
  if (options.version && (options.universal || options.publish)) {
    fail("--version only updates version files; run the release again after committing them");
  }
  return options;
}

function realUpdaterPublicKey(config) {
  const key = config.plugins?.updater?.pubkey?.trim();
  if (!key || key === "REPLACE_WITH_PUBLIC_KEY" || key.includes("REPLACE_WITH_PUBLIC_KEY")) {
    fail([
      "The updater public key is still a placeholder.",
      "Generate a key pair with: npx tauri signer generate -w ~/.tauri/openviewer.key",
      "Then paste the generated public key into src-tauri/tauri.release.conf.json.",
    ].join("\n"));
  }
  const keyLine = key.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith("RWQ"));
  if (!keyLine || !/^RWQ[A-Za-z0-9+/]{50,}={0,2}$/.test(keyLine)) {
    fail("The updater pubkey doesn't look like a Tauri minisign public key. Paste the public key produced by tauri signer generate.");
  }
  return key;
}

function verifySigningEnvironment() {
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY?.trim()) {
    fail([
      "TAURI_SIGNING_PRIVATE_KEY is required in the environment (a path or private-key content).",
      "Generate the key pair with: npx tauri signer generate -w ~/.tauri/openviewer.key",
      "Keep the private key private; paste only the public key into tauri.release.conf.json.",
    ].join("\n"));
  }

  const appleSigningIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim() || "";
  const appleNotarization = ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"];
  const present = appleNotarization.filter((name) => Boolean(process.env[name]?.trim()));
  // DECISION: Reject partial notarization credentials and require a Developer ID rather than attempting ad-hoc notarization.
  if (present.length > 0 && present.length !== appleNotarization.length) {
    const missing = appleNotarization.filter((name) => !process.env[name]?.trim());
    fail(`Notarization needs all three variables; missing: ${missing.join(", ")}`);
  }
  if (present.length === appleNotarization.length && (!appleSigningIdentity || appleSigningIdentity === "-")) {
    fail("Notarization requires APPLE_SIGNING_IDENTITY to name a Developer ID certificate");
  }
  if (present.length === appleNotarization.length) {
    console.log(`Signing: Developer ID (${appleSigningIdentity}); notarization enabled.`);
  } else if (appleSigningIdentity && appleSigningIdentity !== "-") {
    console.log(`Signing: Developer ID (${appleSigningIdentity}); notarization credentials not set.`);
  } else {
    console.log("Signing: ad hoc.");
  }
}

function targetInfo(universal) {
  if (process.platform !== "darwin") fail("Release builds require macOS, Xcode tools, and ditto.");
  if (universal) {
    const required = ["aarch64-apple-darwin", "x86_64-apple-darwin"];
    const installed = new Set(commandOutput("rustup", ["target", "list", "--installed"]).trim().split(/\s+/));
    const missing = required.filter((target) => !installed.has(target));
    if (missing.length) fail(`Universal builds need these Rust targets: ${missing.join(", ")}\nInstall them with: rustup target add ${missing.join(" ")}`);
    // DECISION: Use "universal" as the asset suffix for the dual-architecture bundle.
    return { target: "universal-apple-darwin", arch: "universal" };
  }
  if (hostArch() === "arm64") return { target: "aarch64-apple-darwin", arch: "aarch64" };
  if (hostArch() === "x64") return { target: "x86_64-apple-darwin", arch: "x86_64" };
  fail(`Unsupported macOS architecture: ${hostArch()}`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function ensureAvailableOutputDirectory(path) {
  if (existsSync(path)) {
    // DECISION: Preserve artifacts from a previous attempt instead of overwriting them.
    if (readdirSync(path).length) fail(`Release output already exists: ${path}\nMove it aside before rebuilding this version.`);
  } else {
    mkdirSync(path, { recursive: true });
  }
}

function publishPrerequisites() {
  commandOutput("gh", ["auth", "status"], { inherit: true });
  commandOutput("gh", ["repo", "view", repo, "--json", "nameWithOwner"], { inherit: true });
}

function assertSemverVersion(version) {
  if (!isSemver(version)) fail(`Invalid SemVer version: ${version}`);
}

function verifyApp(appPath, archiveSignaturePath) {
  if (!existsSync(appPath)) fail(`Tauri didn't produce the app bundle: ${appPath}`);
  commandOutput("codesign", ["--verify", "--deep", "--strict", appPath], { inherit: true });
  if (!existsSync(archiveSignaturePath) || !readFileSync(archiveSignaturePath, "utf8").trim()) {
    fail(`Updater signature is missing or empty: ${archiveSignaturePath}`);
  }
  const binary = join(appPath, "Contents/MacOS/openviewer");
  if (!existsSync(binary)) fail(`Couldn't find the app executable: ${binary}`);
  const strings = commandOutput("strings", [binary]);
  if (strings.includes("/Users/")) fail(`The binary still contains a /Users/ path: ${binary}`);
}

async function release(options) {
  if (options.version) {
    assertSemverVersion(options.version);
    assertCleanTree();
    setVersion(options.version);
    console.log("Review and commit these version changes, then rerun npm run release.");
    return;
  }

  assertCleanTree();
  const versions = readVersions();
  const distinct = new Set(Object.values(versions));
  if (distinct.size !== 1) {
    fail(`Version mismatch: package.json=${versions.package}, Cargo.toml=${versions.cargo}, tauri.conf.json=${versions.tauri}.\nRun npm run release -- --version <semver>, review and commit the diff, then retry.`);
  }
  const version = versions.package;
  assertSemverVersion(version);

  const releaseConfig = JSON.parse(readFileSync(releaseConfigPath, "utf8"));
  realUpdaterPublicKey(releaseConfig);
  verifySigningEnvironment();
  const { target, arch } = targetInfo(options.universal);
  const releaseDir = join(root, "release", version);
  ensureAvailableOutputDirectory(releaseDir);

  const notesPath = join(root, "release-notes", `${version}.md`);
  let notes;
  if (existsSync(notesPath)) {
    notes = readFileSync(notesPath, "utf8").trim();
  } else {
    // DECISION: Use visible placeholder text so an omitted notes file cannot create an empty release body.
    console.warn(`Warning: ${notesPath} is missing; writing placeholder release notes.`);
    notes = `OpenViewer ${version}\n\nRelease notes will be added before publication.`;
  }
  if (!notes) fail(`Release notes are empty: ${notesPath}`);
  const savedNotesPath = join(releaseDir, "release-notes.md");

  if (options.publish) publishPrerequisites();

  console.log(`Building ${version} for ${arch} (${target})…`);
  const buildArgs = [
    join(root, "scripts/build-app.mjs"),
    "--target", target,
    "--config", "src-tauri/tauri.release.conf.json",
    "--bundles", "app",
  ];
  const build = spawnSync(process.execPath, buildArgs, { cwd: root, stdio: "inherit", env: process.env });
  if (build.error) fail(`Couldn't run the app build wrapper: ${build.error.message}`);
  if (build.status !== 0) fail(`Tauri build exited with status ${build.status ?? "unknown"}`);
  writeFileSync(savedNotesPath, `${notes}\n`);

  const bundleDir = join(root, "src-tauri/target", target, "release/bundle/macos");
  const appPath = join(bundleDir, "OpenViewer.app");
  const generatedArchive = join(bundleDir, "OpenViewer.app.tar.gz");
  const generatedSignature = `${generatedArchive}.sig`;
  if (!existsSync(generatedArchive)) fail(`Tauri didn't produce the updater archive: ${generatedArchive}`);
  if (!existsSync(generatedSignature)) fail(`Tauri didn't produce the updater signature: ${generatedSignature}`);
  verifyApp(appPath, generatedSignature);

  const zipPath = join(releaseDir, `OpenViewer-${version}-${arch}.zip`);
  const archivePath = join(releaseDir, "OpenViewer.app.tar.gz");
  const signaturePath = `${archivePath}.sig`;
  const latestPath = join(releaseDir, "latest.json");
  commandOutput("ditto", ["-c", "-k", "--keepParent", appPath, zipPath], { inherit: true });
  copyFileSync(generatedArchive, archivePath);
  copyFileSync(generatedSignature, signaturePath);

  const assetUrl = `https://github.com/${repo}/releases/download/v${version}/OpenViewer.app.tar.gz`;
  const latest = buildLatestJson({
    version,
    notes,
    pubDate: new Date().toISOString(),
    signature: readFileSync(signaturePath, "utf8"),
    archiveUrl: assetUrl,
    arch,
  });
  writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`Verified app signature and updater files. Binary has no /Users/ path.`);
  console.log(`Release files are in ${releaseDir}`);

  const assets = [zipPath, archivePath, signaturePath, latestPath];
  const publishArgs = [
    "release", "create", `v${version}`, ...assets,
    "--title", `OpenViewer ${version}`,
    "--notes-file", savedNotesPath,
  ];
  if (isPrerelease(version)) publishArgs.push("--prerelease");
  // The update feed is latest.json on a fixed release tagged `updates`, replaced on every release.
  // DECISION: not /releases/latest/download/, which skips pre-releases, so beta testers would never
  // see a newer beta. Betas stay marked as pre-releases.
  const feedCreate = ["release", "create", FEED_TAG, "--title", "Update feed",
    "--notes", "OpenViewer checks this release's latest.json for updates. Don't delete it.", "--latest=false"];
  const feedUpload = ["release", "upload", FEED_TAG, latestPath, "--clobber"];
  if (options.publish) {
    commandOutput("gh", ["-R", repo, ...publishArgs], { inherit: true });
    if (spawnSync("gh", ["-R", repo, "release", "view", FEED_TAG], { stdio: "ignore" }).status !== 0) {
      commandOutput("gh", ["-R", repo, ...feedCreate], { inherit: true });
    }
    commandOutput("gh", ["-R", repo, ...feedUpload], { inherit: true });
  } else {
    console.log(`Dry run: gh -R ${repo} ${publishArgs.map(shellQuote).join(" ")}`);
    console.log(`Dry run: gh -R ${repo} ${feedUpload.map(shellQuote).join(" ")}   (creating the "${FEED_TAG}" release first if missing)`);
  }
}

async function main() {
  try {
    await release(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
