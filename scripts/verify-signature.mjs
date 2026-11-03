/**
 * Verifies the Sigstore bundle that ships next to a release installer.
 *
 * This checks the detached signature over the exact bytes of the file, the
 * Fulcio certificate, the Rekor transparency-log entry, and that the signing
 * identity is this repository's release workflow. It proves the file was built
 * by that workflow and has not been modified since.
 *
 * It does NOT prove anything to Windows: Authenticode and SmartScreen only trust
 * certificates chained to a CA in the Microsoft Trusted Root Program, which
 * Fulcio is not. See README → "Sigstore signature, and what it does not fix".
 *
 * Usage: npm run verify:signature -- path/to/Blackbox-1.6.0-win-x64.exe
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

// The repository was renamed from locally-uncensored-ai to Blackbox. Signatures
// made before the rename carry the old identity, so both are accepted; anything
// from another repository or workflow still fails.
const IDENTITY =
  "^https://github\\.com/itriedcoding/(?:locally-uncensored-ai|Blackbox)/\\.github/workflows/windows-release\\.yml@.*$";
const ISSUER = "https://token.actions.githubusercontent.com";

const [file, bundleArg] = process.argv.slice(2);

if (!file) {
  console.error(
    [
      "Usage: npm run verify:signature -- <installer.exe> [bundle.sigstore.json]",
      "",
      "Download both files from the release page first, for example:",
      "  gh release download v1.6.0 --pattern '*win-x64*'",
    ].join("\n"),
  );
  process.exit(2);
}

const bundle = bundleArg ?? `${file}.sigstore.json`;

if (!existsSync(file)) {
  console.error(`No such file: ${file}`);
  process.exit(2);
}
if (!existsSync(bundle)) {
  console.error(
    `No Sigstore bundle at ${bundle}\nDownload the matching .sigstore.json from the same release.`,
  );
  process.exit(2);
}

const probe = spawnSync("cosign", ["version"], { stdio: "ignore" });
if (probe.error) {
  console.error(
    [
      "cosign is not installed, so the bundle cannot be checked here.",
      "Install it from https://docs.sigstore.dev/cosign/installation/ —",
      "  Windows: winget install sigstore.cosign",
      "  macOS:   brew install cosign",
      "  Linux:   download the release binary for your architecture",
    ].join("\n"),
  );
  process.exit(2);
}

const size = statSync(file).size;
console.log(`verifying ${file} (${size} bytes)`);
console.log(`bundle    ${bundle}`);
console.log(`identity  ${IDENTITY}`);
console.log(`issuer    ${ISSUER}\n`);

const run = spawnSync(
  "cosign",
  [
    "verify-blob",
    "--bundle",
    bundle,
    "--certificate-identity-regexp",
    IDENTITY,
    "--certificate-oidc-issuer",
    ISSUER,
    file,
  ],
  { stdio: "inherit" },
);

if (run.status !== 0) {
  console.error("\nVerification FAILED. Do not run this file.");
  process.exit(1);
}

console.log("\nVerified: the bundle matches this file and was signed by this repository's release workflow.");
console.log("Reminder: this is not Authenticode, so Windows SmartScreen is unaffected.");
