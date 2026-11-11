import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyScopes, buildRealm, isCore, mergeScopes, permissionNames, redactAnswers, templateScopes, TENANT_GROUPS,
} from '../build-realm.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = (p) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));
const base = json('templates/example.realm-base.json');

/** The example preset with every password and secret filled in, so buildRealm gets complete answers. */
function answers() {
  const a = json('presets/example.answers.json');
  a.clients.adminSecret = 'admin-secret';
  a.users = a.users.map((u) => ({ ...u, password: `${u.username}-pw` }));
  a.m2m = a.m2m.map((m) => ({ ...m, secret: `${m.clientId}-secret` }));
  return a;
}

test('the template defines the bundles TENANT_GROUPS maps to', () => {
  const composites = base.roles.client['acme-org-api'].filter((r) => r.composite).map((r) => r.name);
  assert.deepEqual(composites.sort(), Object.values(TENANT_GROUPS).sort());
  assert.ok(permissionNames(base).length > 0);
});

test('buildRealm is deterministic', () => {
  assert.deepEqual(buildRealm(answers(), base), buildRealm(answers(), base));
});

test('the api client is renamed to the answers\' clients.api', () => {
  const a = answers();
  a.clients.api = 'other-api';
  const realm = buildRealm(a, base);
  assert.deepEqual(Object.keys(realm.roles.client), ['other-api']);
  assert.ok(!JSON.stringify(realm.roles).includes('acme-org-api'));
});

test('every organization gets the three groups, mapped to their bundles', () => {
  const realm = buildRealm(answers(), base);
  assert.ok(realm.organizations.length > 0);
  for (const org of realm.organizations) {
    const groups = Object.fromEntries(org.groups.map((g) => [g.name, g.clientRoles['acme-org-api']]));
    assert.deepEqual(groups, Object.fromEntries(Object.entries(TENANT_GROUPS).map(([g, b]) => [g, [b]])));
  }
});

test('redactAnswers drops every password and secret', () => {
  const text = JSON.stringify(redactAnswers(answers()));
  assert.ok(!/-pw"|-secret"/.test(text), text);
});

test('the CLI writes a realm from a preset and a template', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'kc-realm-')), 'realm.json');
  execFileSync(process.execPath, [resolve(ROOT, 'generate-realm.mjs'), '--preset', 'example', '--template', resolve(ROOT, 'templates/example.realm-base.json'), '--out', out], { stdio: 'pipe' });
  const realm = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(realm.realm, 'acme-org');
  assert.deepEqual(realm.clientScopes, base.clientScopes);
});

test('the CLI creates a missing --out-dir (--preset answers yes)', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'kc-realm-')), 'new', 'dir');
  const output = execFileSync(process.execPath, [resolve(ROOT, 'generate-realm.mjs'), '--preset', 'example', '--out-dir', dir], { encoding: 'utf8' });
  assert.match(output, /does not exist; it will be created/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'realm-acme-org.local.json'), 'utf8')).realm, 'acme-org');
});

test('the CLI refuses an --out-dir that is a file, before any question', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kc-realm-')), 'not-a-dir');
  writeFileSync(file, '');
  assert.throws(
    () => execFileSync(process.execPath, [resolve(ROOT, 'generate-realm.mjs'), '--preset', 'example', '--out-dir', file], { stdio: 'pipe' }),
    (err) => /is not a directory/.test(err.stderr.toString()),
  );
});

const API = 'acme-org-api';
const bundle = (b, name) => b.roles.client[API].find((r) => r.name === name).composites.client[API];
const cli = (...argv) => execFileSync(process.execPath, [resolve(ROOT, 'generate-realm.mjs'), ...argv], { encoding: 'utf8' });
const tmp = (name) => join(mkdtempSync(join(tmpdir(), 'kc-realm-')), name);

test('applyScopes with the template\'s own scopes gives the template back', () => {
  assert.deepEqual(applyScopes(base, templateScopes(base)), base);
});

test('the ef-track scope set is the bundled template\'s', () => {
  assert.deepEqual(json('scopes/ef-track.scopes.json').scopes, templateScopes(base));
});

test('replacing the scopes keeps every tenant:/platform: permission and platform-admin', () => {
  const crud = json('scopes/generic-crud.scopes.json').scopes;
  const b = applyScopes(base, crud);
  const core = permissionNames(base).filter(isCore);
  assert.deepEqual(permissionNames(b), [...crud.map((s) => s.name), ...core]);
  assert.deepEqual(b.roles.realm, base.roles.realm);
  assert.deepEqual(bundle(b, 'tenant-viewer'), ['resources:read', 'reports:read']);
  assert.ok(!bundle(b, 'tenant-member').includes('resources:delete'));
  assert.ok(bundle(b, 'tenant-admin').includes('resources:delete'));
  // core memberships are the template's
  assert.deepEqual(bundle(b, 'tenant-member').filter(isCore), bundle(base, 'tenant-member').filter(isCore));
});

test('mergeScopes: merge appends and the custom scope wins a name clash; replace keeps only custom', () => {
  const preset = [{ name: 'a:read', description: 'old' }, { name: 'b:write' }];
  const custom = [{ name: 'a:read', description: 'new' }, { name: 'c:read' }];
  assert.deepEqual(mergeScopes(preset, custom, 'merge').map((s) => [s.name, s.description]), [['a:read', 'new'], ['b:write', undefined], ['c:read', undefined]]);
  assert.deepEqual(mergeScopes(preset, custom, 'replace'), custom);
});

test('applyScopes rejects core-prefixed, duplicate, malformed scopes and unknown bundles', () => {
  assert.throws(() => applyScopes(base, [{ name: 'tenant:x' }]), /cannot be added/);
  assert.throws(() => applyScopes(base, [{ name: 'a:read' }, { name: 'a:read' }]), /twice/);
  assert.throws(() => applyScopes(base, [{ name: 'a b' }]), /letters, digits/);
  assert.throws(() => applyScopes(base, [{ name: 'a:read', bundles: ['tenant-boss'] }]), /unknown bundle/);
});

test('buildRealm applies answers.scopes and rejects M2M roles that are not scopes', () => {
  const a = answers();
  a.scopes = { preset: 'none', mode: 'replace', list: [{ name: 'orders:read' }] };
  a.m2m = a.m2m.map((m) => ({ ...m, serviceRoles: ['orders:read'], scopeRoles: ['orders:read'] }));
  assert.ok(buildRealm(a, base).roles.client[API].some((r) => r.name === 'orders:read'));
  a.m2m[0].serviceRoles = ['shipments:read'];
  assert.throws(() => buildRealm(a, base), /unknown permission shipments:read/);
});

test('the CLI replaces the scopes with a --scopes file and saves them in the answers file', () => {
  const scopes = tmp('my.scopes.json');
  writeFileSync(scopes, JSON.stringify([{ name: 'orders:read', description: 'Read orders' }, { name: 'orders:write' }]));
  const answersIn = tmp('in.json');
  writeFileSync(answersIn, JSON.stringify({ ...json('presets/example.answers.json'), m2m: [] }));
  const out = tmp('realm.local.json');
  cli('--answers', answersIn, '--yes', '--scopes', scopes, '--scopes-mode', 'replace', '--out', out);
  const realm = JSON.parse(readFileSync(out, 'utf8'));
  const names = realm.roles.client[API].filter((r) => !r.composite).map((r) => r.name);
  assert.deepEqual(names, ['orders:read', 'orders:write', ...permissionNames(base).filter(isCore)]);
  const saved = JSON.parse(readFileSync(out.replace(/\.local\.json$/, '.answers.local.json'), 'utf8'));
  assert.deepEqual(saved.scopes.list.map((s) => s.name), ['orders:read', 'orders:write']);
  // Replaying the saved answers gives the same realm.
  const again = tmp('again.json');
  cli('--answers', out.replace(/\.local\.json$/, '.answers.local.json'), '--yes', '--out', again);
  const replayed = JSON.parse(readFileSync(again, 'utf8'));
  assert.deepEqual(replayed.roles, realm.roles);
});

test('the CLI with --scopes-preset ef-track writes the bundled template\'s roles', () => {
  const out = tmp('realm.json');
  cli('--preset', 'example', '--scopes-preset', 'ef-track', '--out', out);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).roles.client[API], base.roles.client[API]);
});

test('the CLI drops M2M permissions that are no longer scopes', () => {
  const out = tmp('realm.json');
  cli('--preset', 'example', '--scopes-preset', 'generic-crud', '--out', out);
  const realm = JSON.parse(readFileSync(out, 'utf8'));
  for (const u of realm.users.filter((x) => x.username.startsWith('service-account-acme-org-m2m'))) assert.deepEqual(u.clientRoles[API], []);
});
