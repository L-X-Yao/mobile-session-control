# Release process

Status: workflow-defined. The release workflow has not published a release from
this repository yet; its first tag-triggered run is unverified.

## Checklist

1. Update `package.json` and `CHANGELOG.md`; the changelog needs a
   `## <version> — <date>` section.
2. Run `npm test`, `npm run scenario` and `npm run e2e:web` (Playwright
   installed) locally.
3. Commit and push all changes; verify CI, CodeQL and Browser E2E are green.
   Run the soak workflow manually when the release changes runtime behavior.
4. Create a tag on the release commit. Signing is recommended but remains a
   local user action; the workflow does not create or sign tags.
5. Push the tag. `.github/workflows/release.yml` runs the offline checks,
   builds the artifacts, and publishes a GitHub release.

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

## Upgrade and rollback

The relay state snapshot has a version field; a release that changes it must
document the migration and keep the previous archive. The service is a single
writer: stop it before restoring a backup. See `docs/BACKUP.md` for restore and
re-pairing. A rollback to an older release uses the previous source archive and
the matching state backup; tokens and pairing survive only when both are
restored together.
