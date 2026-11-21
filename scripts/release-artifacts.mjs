#!/usr/bin/env node
// Build release artifacts for a version tag: source archive, checksums, file
// manifest, CycloneDX SBOM and release notes. No network and no publishing.
// The release workflow publishes the files with `gh release create`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'L-X-Yao/mobile-session-control';

function fail(message) {
    process.stderr.write(`FAIL release-artifacts: ${message}\n`);
    process.exit(1);
}

function git(args, options = {}) {
    const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...options });
    if (result.status !== 0) fail(`git ${args[0]} failed\n${result.stderr || ''}`);
    return result.stdout;
}

function argValue(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

const outDir = path.resolve(argValue('--out') || path.join(ROOT, 'dist'));
const tag = argValue('--tag') || process.env.GITHUB_REF_NAME || '';
const allowDirty = process.argv.includes('--allow-dirty');
if (!/^v\d+\.\d+\.\d+$/.test(tag)) fail(`tag must look like v1.2.3, got ${tag || '(empty)'}`);
const version = tag.slice(1);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (pkg.version !== version) {
    fail(`package.json version ${pkg.version} does not match tag ${tag}`);
}
if (!allowDirty && git(['status', '--porcelain']).trim() !== '') {
    fail('working tree is dirty; release artifacts must come from a clean tree');
}

const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const heading = new RegExp(`^## ${version.replace(/\./g, '\\.')}(?:\\s+—.*)?$`, 'm');
const match = heading.exec(changelog);
if (!match) fail(`CHANGELOG.md has no section for ${version}`);
const start = match.index + match[0].length;
const next = /^## /m.exec(changelog.slice(start));
const section = changelog.slice(start, next ? start + next.index : undefined).trim();
if (!section) fail(`CHANGELOG.md section for ${version} is empty`);

fs.mkdirSync(outDir, { recursive: true, mode: 0o755 });
const tarball = path.join(outDir, `mobile-session-control-${version}.tar.gz`);
const archive = spawnSync('git', [
    'archive', '--format=tar.gz',
    `--prefix=mobile-session-control-${version}/`,
    '-o', tarball, 'HEAD',
], { cwd: ROOT, encoding: 'utf8' });
if (archive.status !== 0) fail(`git archive failed\n${archive.stderr || ''}`);

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const tarballHash = sha256(tarball);
fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${tarballHash}  ${path.basename(tarball)}\n`);

const manifest = git(['ls-files', '-z']).split('\0').filter(Boolean).map((file) => {
    const full = path.join(ROOT, file);
    const stat = fs.lstatSync(full);
    if (!stat.isFile()) fail(`manifest entry is not a regular file: ${file}`);
    return `${sha256(full)}  ${file}`;
});
fs.writeFileSync(path.join(outDir, 'MANIFEST.sha256'), `${manifest.join('\n')}\n`);

const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
        timestamp: new Date().toISOString(),
        component: {
            type: 'application',
            'bom-ref': `pkg:github/${REPOSITORY}@${tag}`,
            name: pkg.name,
            version,
            purl: `pkg:github/${REPOSITORY}@${tag}`,
            licenses: [{ license: { id: 'MIT' } }],
        },
        properties: [
            {
                name: 'msc:runtime-dependencies',
                value: 'none bundled; Claude Agent SDK and Claude Code are external',
            },
            {
                name: 'msc:source-archive-sha256',
                value: tarballHash,
            },
        ],
    },
    components: [],
};
fs.writeFileSync(
    path.join(outDir, 'sbom.cdx.json'),
    `${JSON.stringify(sbom, null, 2)}\n`,
);

const notes = [
    match[0],
    '',
    section,
    '',
    '## Artifacts',
    '',
    `- \`mobile-session-control-${version}.tar.gz\` (sha256 \`${tarballHash}\`)`,
    '- `SHA256SUMS`, `MANIFEST.sha256`, `sbom.cdx.json`',
    '',
    'Verify with `sha256sum -c SHA256SUMS` after downloading the archive.',
    '',
].join('\n');
fs.writeFileSync(path.join(outDir, 'RELEASE-NOTES.md'), notes);

process.stdout.write(`${JSON.stringify({
    ok: true,
    tag,
    version,
    outDir,
    tarball: path.basename(tarball),
    sha256: tarballHash,
    manifestFiles: manifest.length,
})}\n`);
