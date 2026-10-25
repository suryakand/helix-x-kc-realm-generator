#!/usr/bin/env node
/**
 * Publishes the package to npmjs.org, to a custom registry, or to both, from a
 * single tarball so every registry receives byte-for-byte the same version.
 * Run it from the repository root:
 *
 *   node .github/scripts/publish.mjs [--check] [--version <x>] [npm|custom|both]
 *
 * Without `--version` it packs the working tree and publishes the
 * `package.json` version. With `--version <x>` it republishes a version that
 * is already released: it downloads that exact tarball from whichever known
 * registry has it (npmjs.org, or `CUSTOM_REGISTRY_URL` when set, whether or
 * not it is a target) and publishes it unchanged to the targets that lack it.
 * Nothing is rebuilt, so the copy is byte-for-byte the original, and a version
 * on no known registry is an error. `main`, tags and `package.json` are not
 * involved, so this works for versions released before this script existed.
 *
 * `both` is the default. `--check` publishes nothing: it reports which targets
 * already hold the `package.json` version and, in Actions, writes
 * `published=true|false` (false when any target is missing it) to
 * `$GITHUB_OUTPUT`. Set `DRY_RUN=1` to pass `--dry-run` to `npm publish`.
 *
 * Environment:
 *
 * - `CUSTOM_REGISTRY_URL`  — the custom registry. There is no default: asking
 *   for `custom` or `both` without it fails before anything is published, so a
 *   missing setting can never leave the two registries on different versions.
 * - `NPM_TOKEN`            — npmjs.org automation token (`_authToken`).
 * - `CUSTOM_REGISTRY_AUTH` — base64 of `user:password` for the custom registry
 *   (`_auth`, the same value `npm run registry:login` stores).
 *
 * When a target's credential variable is unset the user's own `~/.npmrc` is
 * used, so a local run after `npm run registry:login` / `npm login` works. In
 * CI a missing credential is an error, again before anything is published.
 *
 * A target that already has the version is skipped, which makes a re-run after
 * a partial failure publish only to the registry that missed it.
 *
 * Every npm call passes `--@helix-x:registry=<url>` as well as `--registry`:
 * for a scoped package npm prefers the scope's registry (set in the project
 * `.npmrc`) over `--registry`, and would otherwise always talk to that one.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const usage = 'usage: node .github/scripts/publish.mjs [--check] [--version <x>] [npm|custom|both]';
const fail = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};

let check = false;
let copyVersion = null;
const positional = [];
for (const args = process.argv.slice(2); args.length; ) {
  const arg = args.shift();
  if (arg === '--check') check = true;
  else if (arg === '--version') copyVersion = args.shift() ?? fail(usage);
  else if (arg.startsWith('--')) fail(usage);
  else positional.push(arg);
}
const target = positional[0] ?? 'both';
const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const inCi = Boolean(process.env.CI);

if (positional.length > 1 || !['npm', 'custom', 'both'].includes(target)) fail(usage);
if (copyVersion !== null && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(copyVersion)) {
  fail(`--version must be a version like 1.2.3, got ${JSON.stringify(copyVersion)}`);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const { name } = pkg;
const version = copyVersion ?? pkg.version;
const scope = name.startsWith('@') ? name.split('/')[0] : null;

/** Normalises a registry URL to end in `/`, or fails with the variable named. */
function registryUrl(value, variable) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${variable} is not a valid URL: ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(`${variable} must be an http(s) URL`);
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

const npmRegistry = {
  label: 'npm',
  url: 'https://registry.npmjs.org/',
  authKey: '_authToken',
  authEnv: 'NPM_TOKEN',
};
const customUrl = process.env.CUSTOM_REGISTRY_URL?.trim();
const customRegistry = customUrl
  ? {
      label: 'custom',
      url: registryUrl(customUrl, 'CUSTOM_REGISTRY_URL'),
      authKey: '_auth',
      authEnv: 'CUSTOM_REGISTRY_AUTH',
    }
  : null;

const targets = [];
if (target === 'npm' || target === 'both') targets.push(npmRegistry);
if (target === 'custom' || target === 'both') {
  if (!customRegistry) fail(`target "${target}" needs CUSTOM_REGISTRY_URL; nothing was published`);
  targets.push(customRegistry);
}
// Every registry the script knows about, targeted or not: where a copy can come from.
const known = [npmRegistry, ...(customRegistry ? [customRegistry] : [])];

// Fail on a missing CI credential up front, not halfway through `both`.
if (inCi && !check) {
  const missing = targets.filter((t) => !process.env[t.authEnv]).map((t) => t.authEnv);
  if (missing.length) fail(`missing ${missing.join(', ')}; nothing was published`);
}

const work = mkdtempSync(join(tmpdir(), 'publish-'));

/**
 * Environment for npm calls against one target. With a credential variable
 * set, npm reads a throwaway userconfig that references it as `${VAR}` — npm
 * expands it, so the secret is never written to disk or put on the command
 * line.
 */
function npmEnv(t) {
  if (!process.env[t.authEnv]) return process.env;
  const u = new URL(t.url);
  const file = join(work, `${t.label}.npmrc`);
  writeFileSync(file, `//${u.host}${u.pathname}:${t.authKey}=\${${t.authEnv}}\n`);
  return { ...process.env, npm_config_userconfig: file };
}

const registryFlags = (t) => [`--registry=${t.url}`, ...(scope ? [`--${scope}:registry=${t.url}`] : [])];

/** Whether `name@version` is already on the target; any error but a 404 is fatal. */
function isPublished(t) {
  try {
    const out = execFileSync('npm', ['view', `${name}@${version}`, 'version', ...registryFlags(t)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: npmEnv(t),
    }).trim();
    // npm prints nothing (exit 0) when the package exists but the version does not.
    return out !== '';
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    if (/E404|404 Not Found|is not in this registry/i.test(output)) return false;
    throw new Error(`could not query ${t.url}:\n${output.trim()}`);
  }
}

/** The only `.tgz` npm pack wrote into the work directory. */
function packedTarball() {
  const file = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (!file) throw new Error('npm pack produced no tarball');
  return join(work, file);
}

/**
 * Downloads `name@version` from the first known registry that has it — the
 * released tarball itself, untouched — and checks it is the package asked for.
 */
function downloadRelease() {
  const source = known.find((r) => r.published);
  if (!source) throw new Error(`${name}@${version} is on no known registry; nothing was published`);
  console.log(`Copying ${name}@${version} from ${source.url}`);
  execFileSync('npm', ['pack', `${name}@${version}`, '--pack-destination', work, ...registryFlags(source)], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: npmEnv(source),
  });
  const tarball = packedTarball();
  const manifest = JSON.parse(
    execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }),
  );
  if (manifest.name !== name || manifest.version !== version) {
    throw new Error(`downloaded ${manifest.name}@${manifest.version}, expected ${name}@${version}`);
  }
  return { tarball, source };
}

const results = [];
let exitCode = 0;

try {
  for (const r of copyVersion ? known : targets) r.published = isPublished(r);
  const pending = targets.filter((t) => !t.published);

  if (check && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `published=${pending.length === 0}\n`);
  }

  if (check) {
    for (const t of targets) {
      results.push([t.label, t.url, t.published ? 'already published' : 'not published']);
    }
  } else {
    let tarball = null;
    let source = null;
    if (pending.length && copyVersion) {
      ({ tarball, source } = downloadRelease());
    } else if (pending.length) {
      // One pack (which runs `prepack`, when the package has one) for every target.
      execFileSync('npm', ['pack', '--pack-destination', work], { stdio: ['ignore', 'inherit', 'inherit'] });
      tarball = packedTarball();
    }

    for (const t of targets) {
      if (t.published) {
        results.push([t.label, t.url, 'skipped (already published)']);
        continue;
      }
      try {
        execFileSync(
          'npm',
          ['publish', tarball, ...registryFlags(t), '--access', 'public', ...(dryRun ? ['--dry-run'] : [])],
          { stdio: 'inherit', env: npmEnv(t) },
        );
        const done = dryRun ? 'dry run ok' : 'published';
        results.push([t.label, t.url, source ? `${done} (copied from ${source.label})` : done]);
      } catch {
        results.push([t.label, t.url, 'FAILED']);
        exitCode = 1;
      }
    }
  }
} catch (error) {
  console.error(`error: ${error.message}`);
  exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${name}@${version}`);
for (const [label, url, status] of results) console.log(`  ${label.padEnd(7)} ${url.padEnd(60)} ${status}`);
process.exit(exitCode);
