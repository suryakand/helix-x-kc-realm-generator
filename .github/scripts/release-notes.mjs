#!/usr/bin/env node
/**
 * Prints the GitHub release notes for the release about to be made from HEAD,
 * as Markdown, to stdout. Run it from the repository root:
 *
 *   node .github/scripts/release-notes.mjs
 *
 * The release is named `v<package.json version>`, exactly as the publish
 * workflow names its tag, and lists every commit since the previous `v*` tag.
 * It needs no tag of its own, so the workflow runs it before publishing and a
 * failure here stops the run before anything irreversible happens. Locally,
 * the same command previews the next release.
 *
 * GitHub's own generated notes are built from merged pull requests, and this
 * repository pushes to main directly, so they would contain nothing but a
 * compare link. These are built from the commits instead.
 *
 * Conventional Commit prefixes are grouped when present (`feat:`, `fix:`, a
 * `!` or a `BREAKING CHANGE:` footer); anything else is listed as it was
 * written. The version bump commits the publish workflow pushes (`[skip ci]`)
 * are left out.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = pkg.version;
const tag = `v${version}`;

// The nearest release tag strictly before HEAD; none on the first release.
let previous = '';
try {
  previous = git('describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD^');
} catch {
  previous = '';
}

// Unit and record separators, so subjects and bodies can hold anything.
const log = git(
  'log',
  '--no-merges',
  '--format=%h%x1f%s%x1f%b%x1e',
  previous ? `${previous}..HEAD` : 'HEAD'
);

const CONVENTIONAL = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;

const sections = { breaking: [], feat: [], fix: [], other: [] };

for (const record of log.split('\x1e')) {
  if (!record.trim()) continue;
  const [hash, subject, body = ''] = record.trim().split('\x1f');
  if (subject.includes('[skip ci]')) continue;

  const match = CONVENTIONAL.exec(subject);
  const type = match?.[1].toLowerCase();
  const scope = match?.[2];
  const text = match ? match[4] : subject;
  const line = `- ${scope ? `**${scope}:** ` : ''}${text} (${hash})`;

  if (match?.[3] || /^BREAKING[ -]CHANGE:/m.test(body)) sections.breaking.push(line);
  else if (type === 'feat') sections.feat.push(line);
  else if (type === 'fix') sections.fix.push(line);
  else sections.other.push(line);
}

const repoUrl =
  process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
    : pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');

const out = [];
const section = (title, lines) => {
  if (lines.length) out.push(`## ${title}`, '', ...lines, '');
};

section('⚠️ Breaking changes', sections.breaking);
section('Features', sections.feat);
section('Fixes', sections.fix);
// Only call it "other" when there is something for it to be other than.
section(
  sections.breaking.length || sections.feat.length || sections.fix.length
    ? 'Other changes'
    : 'Changes',
  sections.other
);
if (out.length === 0) out.push('No changes since the previous release.', '');

out.push(
  '## Install',
  '',
  '```bash',
  `npm install ${pkg.name}@${version}`,
  '```',
  '',
  `[npm](https://www.npmjs.com/package/${pkg.name}/v/${version}) · [API reference](${pkg.homepage})`,
  '',
  previous
    ? `**Full changelog:** ${repoUrl}/compare/${previous}...${tag}`
    : `**Commits:** ${repoUrl}/commits/${tag}`
);

console.log(out.join('\n'));
