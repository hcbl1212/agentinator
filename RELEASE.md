# Releasing Agentinator

Every version tag ships a downloadable macOS build.

## Before you tag: the smoke gate

CI proves the harness against the deterministic mock/e2e provider, but that
provider is only a **mirror** of the real Claude adapter (kept honest by the
parity contract in `src/main/providers/contract.ts`). The one thing CI can't do
is talk to real Claude — so anything that depends on the live SDK (a real edit
becoming a `file.diffed`, tool calls, the model badge, resume, plan usage, the
preview capture tool) is only guarded by the **live smoke suite**, which needs
this machine's Claude login and is skipped everywhere else.

Run it before cutting a release (a real edit → `file.diffed` regression is
exactly what shipped once and what `smoke:diff` now catches):

```sh
npm run smoke:all     # all live smokes against real Claude (needs `claude` login)
```

These can't run in CI (no Claude credentials there), so this is a manual gate —
don't tag on red smokes.

## Cut a release

```sh
npm version patch     # or minor / major — bumps package.json and creates a v0.x.y tag
git push --follow-tags
```

Pushing the `v*` tag triggers [`.github/workflows/release.yml`](.github/workflows/release.yml) on a
macOS runner, which:

1. installs deps and **builds + packages** the app with electron-builder (`npm run package`),
   producing a `.dmg` and `.zip`;
2. runs the **Playwright e2e suite against the packaged `.app`** as the release gate
   (`AGENTINATOR_E2E_BINARY` points the same tests at the shipped binary);
3. publishes a **GitHub Release** with the artifacts and auto-generated notes.

If the e2e gate fails, nothing is published.

## Local packaging

```sh
npm run package        # full build → dist/*.dmg + dist/*.zip
npm run package:dir    # faster: unpacked dist/mac-*/Agentinator.app only
```

Drive the packaged build through the e2e locally:

```sh
AGENTINATOR_E2E_BINARY="$PWD/dist/mac-arm64/Agentinator.app/Contents/MacOS/Agentinator" \
  npx playwright test
```

## Opening an unsigned build ("…is damaged")

Builds are currently **unsigned** ([`electron-builder.yml`](electron-builder.yml) sets
`mac.identity: null`). On Apple Silicon a _downloaded_ unsigned app is quarantined and Gatekeeper
reports it as **"damaged and can't be opened."** Clear the quarantine to run it:

```sh
# after dragging Agentinator to /Applications
xattr -cr /Applications/Agentinator.app
open /Applications/Agentinator.app
```

(That's it — macOS ad-hoc-signs it on first run once the quarantine flag is gone.)

## Making downloads open with no warning — sign + notarize

To ship a build that opens with a normal double-click, you need an **Apple Developer Program**
membership ($99/yr) and a **Developer ID Application** certificate, then sign _and_ notarize:

1. **Get the cert.** In Xcode or the Apple Developer portal, create a _Developer ID Application_
   certificate; export it as a `.p12` with a password.
2. **Add repo secrets** (Settings → Secrets → Actions):
   - `CSC_LINK` — base64 of the `.p12` (`base64 -i cert.p12 | pbcopy`)
   - `CSC_KEY_PASSWORD` — the `.p12` password
   - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (an app-specific password from appleid.apple.com),
     `APPLE_TEAM_ID` — for notarization
3. **Config:** in `electron-builder.yml`, remove `mac.identity: null`, re-enable
   `mac.hardenedRuntime: true` (required for notarization), add an entitlements plist, and set
   `mac.notarize: true`.
4. **Workflow:** pass those secrets to the _Build + package_ step of
   [`release.yml`](.github/workflows/release.yml) as env — electron-builder picks up `CSC_LINK` /
   `CSC_KEY_PASSWORD` automatically for signing and the `APPLE_*` vars for notarization.

electron-builder then signs with the Developer ID and submits to Apple's notary service, stapling
the ticket so the download opens cleanly. Ad-hoc signing (`identity: '-'`) is **not** a shortcut
here — it fails to launch alongside the unpacked SDK binary.

The Claude Agent SDK ships a CLI subprocess, so it's kept out of the asar archive
(`asarUnpack`); leave that in place.
