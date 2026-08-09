# Releasing Agentinator

Every version tag ships a downloadable macOS build.

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

## Signing & notarization (stubbed)

Builds are currently **unsigned** — [`electron-builder.yml`](electron-builder.yml) sets
`mac.identity: null`, so the artifact runs locally (right-click → Open on first launch to bypass
Gatekeeper) but isn't notarized. When an Apple Developer ID is available:

1. Remove `mac.identity: null` (or set the identity name).
2. Add the signing cert + password as repo secrets and pass them to the release job as
   `CSC_LINK` / `CSC_KEY_PASSWORD`.
3. Add a `mac.notarize` config and the `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`
   secrets.

The Claude Agent SDK ships a CLI subprocess, so it's kept out of the asar archive
(`asarUnpack` in `electron-builder.yml`); leave that in place.
