import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildRealm, permissionNames, redactAnswers, TENANT_GROUPS } from '../build-realm.mjs';

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
