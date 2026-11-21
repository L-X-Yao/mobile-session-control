# Release process

Status: `v0.1.4` was published by the workflow with four verified assets and a
build-provenance attestation; `v0.1.3` was the first attested release. Signed
tags remain a local operator action.

## Checklist

1. Update `package.json` and `CHANGELOG.md`; the changelog needs a
   `## <version> — <date>` section.
2. Run `npm test`, `npm run scenario` and `npm run e2e:web` (Playwright
   installed) locally.
3. Commit and push all changes; verify CI, CodeQL, Browser E2E and Scorecard
   are green. Run the soak workflow manually when the release changes runtime
   behavior.
4. Create a tag on the release commit. Signing is recommended but remains a
   local user action; the workflow does not create or sign tags:

   ```sh
   git tag -s vX.Y.Z -m "vX.Y.Z"   # or: git tag -a ...
   git tag -v vX.Y.Z
   ```

5. Push the tag. `.github/workflows/release.yml` runs the offline checks,
   builds the artifacts, attests their provenance, and publishes a GitHub
   release.

Do not move or reuse a published tag. Fix forward with a new patch version.

## Artifacts

`node scripts/release-artifacts.mjs --out dist` writes:

| File | Contents |
|---|---|
| `mobile-session-control-<version>.tar.gz` | `git archive` of the tagged commit |
| `SHA256SUMS` | SHA-256 of the source archive |
| `MANIFEST.sha256` | SHA-256 of every tracked file at that commit |
| `sbom.cdx.json` | CycloneDX 1.5 application record; no bundled third-party components |
| `RELEASE-NOTES.md` | Changelog section for the version plus artifact checksums |

Verify a download with `sha256sum -c SHA256SUMS` and
`sha256sum -c MANIFEST.sha256`. The SBOM states that the Claude Agent SDK and
Claude Code are external, not bundled.

When the release workflow has attestation enabled, verify provenance with:

```sh
gh attestation verify mobile-session-control-X.Y.Z.tar.gz \
  -R L-X-Yao/mobile-session-control
```

A signed tag proves who created the tag; the attestation proves which workflow
and commit built the artifact.

## Upgrade and rollback

The relay state snapshot has a version field; a release that changes it must
document the migration and keep the previous archive. The service is a single
writer: stop it before restoring a backup. See `docs/BACKUP.md` for restore and
re-pairing. A rollback to an older release uses the previous source archive and
the matching state backup; tokens and pairing survive only when both are
restored together.
