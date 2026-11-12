#!/usr/bin/env node
/**
 * Interactive generator for a multi-tenant Keycloak realm import file. Asks for what differs per environment
 * (realm, URLs, users, organizations, M2M clients, SMTP), takes the rest from a template, writes the realm JSON
 * and a replayable answers file without secrets, and prints the values your services need.
 *
 *   node generate-realm.mjs                                  # interactive
 *   node generate-realm.mjs --answers <file>                 # interactive, defaults from an earlier run
 *   node generate-realm.mjs --answers <file> --yes           # no questions; missing passwords/secrets generated
 *   node generate-realm.mjs --preset example --out <file>    # a preset: a name in presets/ or a path; no questions
 *
 *   --template <file>  the fixed part: permissions, bundles, client scopes (default: templates/example.realm-base.json)
 *   --scopes-preset <name|file>  application scopes to start from: template (the template's own, default), a name in
 *                      scopes/ (ef-track, generic-crud), a scope file, or none (only the tenant:/platform: permissions)
 *   --scopes <file>    custom application scopes (JSON: { "scopes": [{ name, description, bundles? }] } or an array),
 *                      shown for confirmation, then combined with the predefined set
 *   --scopes-mode merge|replace  merge (default): the custom scopes are added, replacing same-named ones;
 *                      replace: only the custom scopes. tenant:* and platform:* permissions stay either way
 *   --out <file>       realm file to write (default: <out-dir>/realm-<realm>.local.json)
 *   --out-dir <dir>    where the realm and answers files go (default: the current directory); offers to create a missing one
 *   --providers <dir>  a local copy of Keycloak's providers directory: the theme question lists the JARs in it, or
 *                      warns if it has none. A check only: nothing goes into the realm, and --yes/--preset ignore it
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkbox, confirm, input, number, password, select } from '@inquirer/prompts';
import {
  applyScopes, buildRealm, CORE_PREFIXES, isCore, mergeScopes, normalizeScope, permissionNames, realmThemes, redactAnswers,
  templateScopes, TENANT_GROUPS, validateScopes,
} from './build-realm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GROUPS = Object.keys(TENANT_GROUPS);
const BUNDLES = Object.values(TENANT_GROUPS);
const SCOPES_DIR = resolve(HERE, 'scopes');

const { values: args } = parseArgs({
  options: {
    template: { type: 'string' },
    answers: { type: 'string' },
    preset: { type: 'string' },
    out: { type: 'string' },
    'out-dir': { type: 'string' },
    providers: { type: 'string' },
    scopes: { type: 'string' },
    'scopes-preset': { type: 'string' },
    'scopes-mode': { type: 'string' },
    yes: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, ''));
  process.exit(0);
}

const templateFile = args.template ? resolve(process.cwd(), args.template) : resolve(HERE, 'templates', 'example.realm-base.json');
const base = JSON.parse(readFileSync(templateFile, 'utf8'));
if (args['scopes-mode'] && !['merge', 'replace'].includes(args['scopes-mode'])) {
  console.error(`✖ --scopes-mode must be merge or replace, not "${args['scopes-mode']}"`);
  process.exit(1);
}

// ---------- helpers ----------

const secret = () => randomBytes(24).toString('base64url');
const newPassword = () => randomBytes(12).toString('base64url');
const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const req = (label) => (v) => (v.trim() ? true : `${label} is required`);
/** A path for messages: relative to the current directory when it is inside it. */
const show = (file) => (relative(process.cwd(), file).startsWith('..') ? file : relative(process.cwd(), file));
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const name = (label) => (v) => (NAME.test(v.trim()) ? true : `${label}: letters, digits, . _ - only`);
const url = (v) => {
  try {
    const u = new URL(v.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? true : 'http:// or https:// URL';
  } catch {
    return 'not a valid URL';
  }
};
const email = (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? true : 'not a valid email address');
const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
/** A path to a file, or the name of one shipped in `dir` as <name><suffix>. */
function resolveNamed(dir, suffix, value, what) {
  const asPath = resolve(process.cwd(), value);
  const file = existsSync(asPath) && !/^[\w-]+$/.test(value) ? asPath : resolve(dir, `${value}${suffix}`);
  if (!existsSync(file)) throw new Error(`Unknown ${what} "${value}": not a file, nor one of ${relative(HERE, dir)}/ (${readdirSync(dir).join(', ')})`);
  return file;
}
// Section headers and hints are for people answering questions; --yes runs stay quiet until the summary.
const section = (title, always = false) =>
  (always || !args.yes) && console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
const hint = (text) => !args.yes && console.log(`   ${text}`);

/** Every prompt goes through here, so --yes can accept the defaults without asking. */
const ask = {
  input: (o) => (args.yes ? Promise.resolve(o.default ?? '') : input(o)).then((v) => String(v).trim()),
  confirm: (o) => (args.yes ? Promise.resolve(o.default ?? false) : confirm(o)),
  select: (o) => (args.yes ? Promise.resolve(o.default ?? o.choices[0].value) : select(o)),
  checkbox: (o) =>
    args.yes ? Promise.resolve(o.choices.filter((c) => c.checked).map((c) => c.value)) : checkbox(o),
  number: (o) => (args.yes ? Promise.resolve(o.default) : number(o)),
};

/** Passwords and secrets this run generated, printed once at the end. */
const GENERATED = [];

/** A secret value: keep the known one, generate one, or type one (masked). */
async function askSecret(label, known, { allowGenerate = true } = {}) {
  const generate = () => {
    const value = /secret/i.test(label) ? secret() : newPassword();
    GENERATED.push([label, value]);
    return value;
  };
  if (args.yes) {
    if (known) return known;
    if (!allowGenerate) throw new Error(`${label} is not in the answers file (secrets never are); run without --yes to type it`);
    return generate();
  }
  const choices = [
    ...(known ? [{ name: 'keep the value from the answers file', value: 'keep' }] : []),
    ...(allowGenerate ? [{ name: 'generate a random one (shown at the end)', value: 'generate' }] : []),
    { name: 'type it', value: 'type' },
  ];
  const how = choices.length === 1 ? 'type' : await select({ message: label, choices });
  if (how === 'keep') return known;
  if (how === 'generate') return generate();
  return password({ message: `${label}:`, mask: '*', validate: req(label) });
}

/** Asks for list items: each existing one (from defaults) is edited in turn, then "add another?". */
async function askList(label, defaults, askItem, { min = 0, addFirst = false } = {}) {
  const out = [];
  for (const d of defaults) {
    if (!args.yes && !(await confirm({ message: `Keep ${label} "${d.__label}"?`, default: true }))) continue;
    out.push(await askItem(d, out));
  }
  let more = out.length < min || (addFirst && out.length === 0);
  if (!more && !args.yes) more = await confirm({ message: `Add ${out.length ? 'another' : 'a'} ${label}?`, default: false });
  while (more) {
    out.push(await askItem(undefined, out));
    more = out.length < min || (!args.yes && (await confirm({ message: `Add another ${label}?`, default: false })));
  }
  return out;
}

const DEFAULTS = {
  realm: {
    name: 'acme-org',
    displayName: 'Acme Org',
    kind: 'hosted',
    publicUrl: 'https://auth.acme.example',
    theme: '',
    resetPasswordAllowed: true,
    rememberMe: false,
    accessTokenLifespan: 300,
  },
  // Client ids and the claim prefix default to names derived from the realm (acme-org-api, acme_org_tenant, …).
  clients: { webUrls: ['https://app.acme.example'], cli: false },
  users: [],
  organizations: [],
  m2m: [],
  // smtp absent = not decided (hosted realms default to configuring it); null = no SMTP.
};

// ---------- sections ----------

const THEME_PAGES = [
  ['account', 'Account pages theme'],
  ['admin', `Admin console theme (this realm's /admin/<realm>/console only, not master's)`],
  ['email', 'Email theme'],
];

/** { account, admin, email } themes, or undefined: the email theme follows the login theme, account/admin use the defaults. */
async function askThemes(d, theme, validate) {
  // An answers file from before per-page themes replays as it did then.
  if (args.yes && !d.themes) return undefined;
  const all = (t) => Object.fromEntries(THEME_PAGES.map(([k]) => [k, t]));
  if (theme) {
    const same = d.themes ? THEME_PAGES.every(([k]) => (d.themes[k] ?? theme) === theme) : true;
    if (await ask.confirm({ message: `Use "${theme}" for the account pages, admin console and emails too?`, default: same })) return all(theme);
  } else {
    const any = THEME_PAGES.some(([k]) => d.themes?.[k]);
    if (!(await ask.confirm({ message: 'Set a theme for the account pages, admin console or emails?', default: any }))) return undefined;
  }
  hint('Empty = Keycloak\'s default theme for that page type.');
  const out = {};
  for (const [k, message] of THEME_PAGES) out[k] = await ask.input({ message, default: d.themes?.[k] ?? theme, validate });
  return out;
}

async function askRealm(d) {
  section('Realm');
  const kind = await ask.select({
    message: 'Environment',
    default: d.kind,
    choices: [
      { name: 'local (http, localhost, dev conveniences)', value: 'local' },
      { name: 'hosted server (https, behind a TLS proxy)', value: 'hosted' },
    ],
  });
  const realmName = await ask.input({ message: 'Realm name', default: d.name, validate: name('Realm name') });
  const displayName = await ask.input({ message: 'Display name (shown on the sign-in page)', default: d.displayName, validate: req('Display name') });
  const publicUrl = await ask.input({
    message: 'Public Keycloak URL (what browsers use; the token issuer is based on it)',
    default: kind === 'local' ? 'http://localhost:8180' : d.publicUrl,
    validate: url,
  });
  const providers = args.providers && resolve(process.cwd(), args.providers);
  const jars = providers && existsSync(providers) ? readdirSync(providers).filter((f) => f.endsWith('.jar')) : [];
  if (jars.length) hint(`Theme JARs in ${show(providers)}: ${jars.join(', ')}`);
  const themeName = (v) => (!v.trim() || NAME.test(v.trim()) ? true : 'letters, digits, . _ - only');
  const theme = await ask.input({
    message: "Login theme name (empty = Keycloak's default theme)",
    default: d.theme || '',
    validate: themeName,
  });
  const themes = await askThemes(d, theme, themeName);
  const named = [...new Set([theme, ...Object.values(themes ?? {})].filter(Boolean))];
  if (named.length && providers && !jars.length) {
    hint(`Keycloak needs the JAR providing ${named.map((t) => `"${t}"`).join(', ')} in its providers directory, or it falls back to its default.`);
  }
  const resetPasswordAllowed = await ask.confirm({ message: 'Allow "Forgot password" (needs SMTP)?', default: d.resetPasswordAllowed ?? true });
  const rememberMe = await ask.confirm({ message: 'Show "Remember me"?', default: d.rememberMe ?? false });
  const accessTokenLifespan = await ask.number({ message: 'Access token lifespan (seconds)', default: d.accessTokenLifespan ?? 300, min: 60 });
  return {
    name: realmName,
    displayName,
    kind,
    publicUrl: new URL(publicUrl).origin,
    sslRequired: kind === 'local' ? 'none' : 'external',
    theme,
    ...(themes ? { themes } : {}),
    resetPasswordAllowed,
    rememberMe,
    accessTokenLifespan,
  };
}

async function askClients(d, realm) {
  section('Clients');
  const webUrls = list(
    await ask.input({
      message: 'Web UI URL(s), comma-separated (sign-in redirects and CORS origins)',
      default: (realm.kind === 'local' ? ['http://localhost:5174'] : d.webUrls).join(', '),
      validate: (v) => (list(v).length ? list(v).map(url).find((r) => r !== true) ?? true : 'at least one URL'),
    }),
  );
  const n = realm.name;
  let api = d.api ?? `${n}-api`;
  let web = d.web ?? `${n}-web`;
  let admin = d.admin ?? `${n}-admin`;
  let cliId = d.cliId ?? `${n}-cli`;
  let claimPrefix = d.claimPrefix ?? n.replace(/-/g, '_');
  hint(`Identifiers: clients ${api}, ${web}, ${admin}, ${cliId}; M2M tenant claims ${claimPrefix}_tenant / ${claimPrefix}_tenant_id.`);
  if (!args.yes && (await confirm({ message: 'Change these identifiers? (Only if your services expect other names.)', default: false }))) {
    api = await input({ message: 'Resource-server (API) client ID, the token audience', default: api, validate: name('Client ID') });
    web = await input({ message: 'Web UI client ID', default: web, validate: name('Client ID') });
    admin = await input({ message: 'Admin service-account client ID (for your backend)', default: admin, validate: name('Client ID') });
    cliId = await input({ message: 'Password-grant (curl) client ID', default: cliId, validate: name('Client ID') });
    claimPrefix = await input({ message: 'Claim prefix for M2M tenant claims', default: claimPrefix, validate: (v) => (/^[a-z][a-z0-9_]*$/.test(v.trim()) ? true : 'lower-case letters, digits and _') });
  }
  const cli = await ask.confirm({
    message: `Add "${cliId}" (password grant, for curl testing)?`,
    default: d.cli ?? realm.kind === 'local',
  });
  if (cli && realm.kind === 'hosted') hint('Warning: the password grant lets anything holding a password get tokens directly. Dev only.');
  hint(`Your backend authenticates to Keycloak's admin API as "${admin}" with a client secret.`);
  const adminSecret = await askSecret('Admin client secret', d.adminSecret);
  return {
    api, web, admin, cliId, claimPrefix, adminSecret, cli,
    webUrls: webUrls.map((u) => { const x = new URL(u); return x.origin + x.pathname.replace(/\/+$/, ''); }),
    ...(d.names ? { names: d.names } : {}),
  };
}

/** Scopes from a scope file: { scopes: [..] } or a bare array, validated, bundles filled in. */
function readScopes(file) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const scopes = Array.isArray(json) ? json : json.scopes;
  if (!Array.isArray(scopes)) throw new Error(`${show(file)}: expected { "scopes": [..] } or an array of scopes`);
  try {
    validateScopes(scopes);
  } catch (err) {
    throw new Error(`${show(file)}: ${err.message}`);
  }
  return scopes.map(normalizeScope);
}

/** A predefined scope set: the template's own, none, a name in scopes/, or a scope file. */
function presetScopes(preset) {
  if (preset === 'template') return templateScopes(base);
  if (preset === 'none') return [];
  return readScopes(resolveNamed(SCOPES_DIR, '.scopes.json', preset, 'scope set'));
}

/** "a:read, b:write=Write b" → scopes (bundles from the rule). */
const typedScopes = (text) =>
  list(text).map((x) => {
    const [n, ...desc] = x.split('=');
    return normalizeScope({ name: n.trim(), description: desc.join('=').trim() });
  });

const scopeLine = (s) => `${s.name}${s.description ? ` — ${s.description}` : ''}  [${s.bundles.join(', ') || 'no bundle'}]`;

async function askScopes(d) {
  section('Application scopes');
  hint(`The API's permissions (client roles). ${CORE_PREFIXES.map((p) => `${p}*`).join(' and ')} administration permissions always come from the template.`);
  // 1. Where to start: the answers file's list, or a predefined set (an explicit --scopes-preset skips the answers file's list).
  let preset;
  let start;
  const keep = d?.list && !args['scopes-preset']
    && (await ask.confirm({ message: `Keep the ${d.list.length} scopes from the answers file (${d.list.map((s) => s.name).join(', ') || 'none'})?`, default: true }));
  if (keep) {
    validateScopes(d.list);
    preset = d.preset ?? 'template';
    start = d.list.map(normalizeScope);
  } else {
    const sets = readdirSync(SCOPES_DIR).filter((f) => f.endsWith('.scopes.json')).map((f) => f.replace(/\.scopes\.json$/, ''));
    const wanted = args['scopes-preset'] ?? d?.preset ?? 'template';
    preset = await ask.select({
      message: 'Predefined scope set',
      default: wanted,
      choices: [
        { name: `template (the scopes in ${show(templateFile)})`, value: 'template' },
        ...sets.map((n) => ({ name: `${n} (scopes/${n}.scopes.json)`, value: n })),
        ...(['template', 'none', ...sets].includes(wanted) ? [] : [{ name: wanted, value: wanted }]),
        { name: `none (only the ${CORE_PREFIXES.join(' / ')} permissions)`, value: 'none' },
      ],
    });
    start = presetScopes(preset);
  }
  // 2. Custom scopes from --scopes, confirmed, then merged into or replacing the start.
  let mode = args['scopes-mode'] ?? d?.mode ?? 'merge';
  let scopes = start;
  if (args.scopes) {
    const file = resolve(process.cwd(), args.scopes);
    const custom = readScopes(file);
    hint(`${show(file)}:`);
    for (const s of custom) hint(`  ${scopeLine(s)}`);
    if (await ask.confirm({ message: `Use these ${custom.length} scopes from ${show(file)}?`, default: true })) {
      if (start.length) {
        mode = await ask.select({
          message: `Combine them with the ${start.length} scopes of "${preset}"`,
          default: mode,
          choices: [
            { name: 'merge (add them; same-named ones are replaced)', value: 'merge' },
            { name: 'replace (only the scopes from the file)', value: 'replace' },
          ],
        });
      }
      scopes = mergeScopes(start, custom, mode);
    }
  }
  // 3. Remove and add.
  if (scopes.length) {
    const chosen = await ask.checkbox({
      message: 'Scopes (uncheck to remove)',
      choices: scopes.map((s) => ({ name: scopeLine(s), value: s.name, checked: true })),
    });
    scopes = scopes.filter((s) => chosen.includes(s.name));
  }
  for (;;) {
    const text = await ask.input({
      message: 'Add scopes, comma-separated "name" or "name=description" (empty: done)',
      default: '',
      validate: (v) => {
        try {
          validateScopes(typedScopes(v));
          return true;
        } catch (err) {
          return err.message;
        }
      },
    });
    if (!text) break;
    scopes = mergeScopes(scopes, typedScopes(text), 'merge');
  }
  // 4. Bundles.
  const inBundle = (b) => scopes.filter((s) => s.bundles.includes(b)).map((s) => s.name).join(', ') || '-';
  for (const b of BUNDLES) hint(`${b.padEnd(14)} ${inBundle(b)}`);
  if (scopes.length && (await ask.confirm({ message: 'Adjust which bundles get which scopes?', default: false }))) {
    for (const b of BUNDLES) {
      const chosen = await ask.checkbox({
        message: `Scopes in ${b}`,
        choices: scopes.map((s) => ({ name: s.name, value: s.name, checked: s.bundles.includes(b) })),
      });
      scopes = scopes.map((s) => normalizeScope({ ...s, bundles: [...s.bundles.filter((x) => x !== b), ...(chosen.includes(s.name) ? [b] : [])] }));
    }
  }
  if (!scopes.length) hint('No application scopes: only the administration permissions, and nothing to grant M2M clients.');
  return { preset, mode, list: scopes };
}

async function askUser(d, others, realm, { platformAdmin } = {}) {
  const taken = new Set(others.map((u) => u.username));
  const username = await ask.input({
    message: 'Username',
    default: d?.username,
    validate: (v) => (taken.has(v.trim()) ? 'already used' : name('Username')(v)),
  });
  const mail = await ask.input({ message: 'Email (password reset and invites go here)', default: d?.email, validate: email });
  const firstName = await ask.input({ message: 'First name', default: d?.firstName ?? '' });
  const lastName = await ask.input({ message: 'Last name', default: d?.lastName ?? '' });
  const admin = platformAdmin ?? (await ask.confirm({ message: 'Platform admin (every tenant, user and client)?', default: d?.platformAdmin ?? false }));
  const pw = await askSecret(`Password for ${username}`, d?.password);
  const temporary = await ask.confirm({ message: 'Must change the password at first sign-in?', default: d?.temporary ?? realm.kind === 'hosted' });
  return { username, email: mail, firstName, lastName, platformAdmin: admin, password: pw, temporary };
}

async function askUsers(d, realm) {
  section('Users');
  hint('At least one platform admin. Tenant users can also be added later through your app or the admin console.');
  const defaults = d.map((u) => ({ ...u, __label: u.username }));
  const users = await askList('user', defaults, (u, done) => askUser(u, done, realm, done.length === 0 && !u ? { platformAdmin: true } : {}), { min: 1 });
  if (!users.some((u) => u.platformAdmin)) {
    hint('No platform admin yet; the first user becomes one.');
    users[0].platformAdmin = true;
  }
  return users;
}

async function askOrganization(d, done, users) {
  const orgName = await ask.input({ message: 'Organization (tenant) name', default: d?.name, validate: req('Name') });
  const taken = new Set(done.map((o) => o.alias));
  const alias = await ask.input({
    message: 'Alias (short id, used in URLs and client names)',
    default: d?.alias ?? slug(orgName),
    validate: (v) => (taken.has(v.trim()) ? 'already used' : /^[a-z0-9][a-z0-9-]*$/.test(v.trim()) ? true : 'lower-case letters, digits and -'),
  });
  const domains = list(await ask.input({ message: 'Email domains, comma-separated (optional)', default: (d?.domains ?? []).join(', ') }));
  const members = [];
  const known = new Map((d?.members ?? []).map((m) => [m.username, m.group]));
  const usernames = users.map((u) => u.username);
  const chosen = await ask.checkbox({
    message: `Members of ${alias}`,
    choices: usernames.map((u) => ({ name: u, value: u, checked: known.has(u) })),
  });
  for (const username of chosen) {
    const group = await ask.select({
      message: `${username} in ${alias} is`,
      default: known.get(username) ?? 'members',
      choices: GROUPS.map((g) => ({ name: `${g} (${TENANT_GROUPS[g]})`, value: g })),
    });
    members.push({ username, group });
  }
  return {
    id: d?.id ?? randomUUID(),
    name: orgName,
    alias,
    tenantId: d?.tenantId ?? randomUUID(),
    domains,
    groupIds: d?.groupIds ?? Object.fromEntries(GROUPS.map((g) => [g, randomUUID()])),
    members,
  };
}

async function askOrganizations(d, users) {
  section('Organizations (tenants)');
  hint('Each gets the groups admins / members / viewers. More can be created later through your app or the admin console.');
  return askList('organization', d.map((o) => ({ ...o, __label: o.alias })), (o, done) => askOrganization(o, done, users));
}

async function askM2m(d, done, orgs, realm, permissions) {
  const organization = await ask.select({
    message: 'Tenant of this client',
    default: d?.organization,
    choices: orgs.map((o) => ({ name: `${o.alias} (${o.name})`, value: o.alias })),
  });
  const org = orgs.find((o) => o.alias === organization);
  const taken = new Set(done.map((m) => m.clientId));
  const clientId = await ask.input({
    message: 'Client ID',
    default: d?.clientId ?? `${realm.name}-m2m-${organization}-integration`,
    validate: (v) => (taken.has(v.trim()) ? 'already used' : name('Client ID')(v)),
  });
  const displayName = await ask.input({ message: 'Display name', default: d?.name ?? `${org.name}: integration` });
  const serviceRoles = await ask.checkbox({
    message: 'Permissions (the client gets exactly these)',
    choices: permissions.map((p) => ({ name: p, value: p, checked: (d?.serviceRoles ?? permissions).includes(p) })),
  });
  const clientSecret = await askSecret(`Client secret for ${clientId}`, d?.secret);
  return {
    clientId,
    name: displayName,
    description: d?.description ?? `Machine-to-machine client of tenant ${organization} (client_credentials)`,
    organization,
    // The token carries a role only if both the scope mapping and the service account allow it.
    scopeRoles: d?.scopeRoles ?? serviceRoles,
    serviceRoles,
    secret: clientSecret,
  };
}

/** `permissions`: what an M2M client may be granted, i.e. the application scopes (never tenant or platform administration). */
async function askM2ms(d, orgs, realm, permissions) {
  section('Machine-to-machine clients');
  if (!orgs.length) {
    hint('Skipped: an M2M client belongs to an organization, and there are none.');
    return [];
  }
  hint('client_credentials clients for integrations, each bound to one tenant.');
  const known = new Set(permissions);
  const valid = d
    .filter((m) => orgs.some((o) => o.alias === m.organization))
    .map((m) => {
      const dropped = [...new Set([...(m.serviceRoles ?? []), ...(m.scopeRoles ?? [])])].filter((r) => !known.has(r));
      // Shown with --yes too: the answers file asked for permissions this realm will not have.
      if (dropped.length) console.log(`   ! ${m.clientId}: dropped ${dropped.join(', ')} (no longer an application scope).`);
      const keep = (roles) => roles && roles.filter((r) => known.has(r));
      return { ...m, serviceRoles: keep(m.serviceRoles), scopeRoles: keep(m.scopeRoles) };
    });
  return askList('M2M client', valid.map((m) => ({ ...m, __label: m.clientId })), (m, done) => askM2m(m, done, orgs, realm, permissions));
}

async function askSmtp(d, realm) {
  section('Email (SMTP)');
  hint('Needed for "Forgot password", verify email and invites. Can also be set later in the admin console.');
  const want = await ask.confirm({
    message: 'Configure SMTP now?',
    default: d === undefined ? realm.resetPasswordAllowed && realm.kind === 'hosted' : !!d,
  });
  if (!want) return null;
  const s = d ?? {};
  const provider = await ask.select({
    message: 'Provider',
    default: s.host && s.host !== 'smtp.gmail.com' ? 'other' : 'gmail',
    choices: [
      { name: 'Gmail / Google Workspace (App Password)', value: 'gmail' },
      { name: 'Other SMTP server', value: 'other' },
    ],
  });
  if (provider === 'gmail') hint('Gmail needs 2-Step Verification and an App Password: https://myaccount.google.com/apppasswords');
  const host = await ask.input({ message: 'Host', default: s.host ?? (provider === 'gmail' ? 'smtp.gmail.com' : ''), validate: req('Host') });
  const security = await ask.select({
    message: 'Encryption',
    default: s.ssl ? 'ssl' : 'starttls',
    choices: [
      { name: 'StartTLS (port 587)', value: 'starttls' },
      { name: 'SSL/TLS (port 465)', value: 'ssl' },
      { name: 'none (port 25, local relays only)', value: 'none' },
    ],
  });
  const port = await ask.number({ message: 'Port', default: Number(s.port) || { starttls: 587, ssl: 465, none: 25 }[security] });
  const from = await ask.input({
    message: provider === 'gmail' ? 'From (the Gmail address, or a verified "Send mail as" alias)' : 'From address',
    default: s.from,
    validate: email,
  });
  const fromDisplayName = await ask.input({ message: 'From display name', default: s.fromDisplayName ?? realm.displayName });
  const replyTo = await ask.input({ message: 'Reply-to (optional)', default: s.replyTo ?? '' });
  const auth = await ask.confirm({ message: 'Server needs a login?', default: s.auth ?? true });
  let user;
  let pw;
  if (auth) {
    user = await ask.input({ message: 'SMTP username', default: s.user ?? from, validate: req('Username') });
    pw = await askSecret(provider === 'gmail' ? 'SMTP password (the 16-character App Password, no spaces)' : 'SMTP password', s.password, { allowGenerate: false });
    pw = pw.replace(/\s+/g, '');
  }
  return { host, port, starttls: security === 'starttls', ssl: security === 'ssl', from, fromDisplayName, replyTo, auth, user, password: pw };
}

// ---------- main ----------

function loadDefaults() {
  if (args.preset) {
    // A path to an answers file, or the name of one shipped in presets/.
    const file = resolveNamed(resolve(HERE, 'presets'), '.answers.json', args.preset, 'preset');
    args.yes = true;
    return JSON.parse(readFileSync(file, 'utf8'));
  }
  if (args.answers) return { ...DEFAULTS, ...JSON.parse(readFileSync(resolve(process.cwd(), args.answers), 'utf8')) };
  if (args.yes) throw new Error('--yes needs --answers <file> or --preset <name>');
  return DEFAULTS;
}

/** Checks --out-dir before any question; one that does not exist is created when the files are written, if wanted. */
async function checkOutDir(dir) {
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new Error(`--out-dir ${show(dir)} is not a directory`);
    return true;
  }
  console.log(`! --out-dir ${show(dir)} does not exist${args.yes ? '; it will be created' : ''}.`);
  return ask.confirm({ message: `Create ${show(dir)}?`, default: true });
}

function summary(a) {
  section('Summary', true);
  console.log(`   Realm        ${a.realm.name} ("${a.realm.displayName}"), ${a.realm.kind}, issuer ${a.realm.publicUrl}/realms/${a.realm.name}`);
  console.log(`   Web UI       ${a.clients.webUrls.join(', ')}${a.clients.cli ? `   + ${a.clients.cliId} (password grant)` : ''}`);
  console.log(`   Scopes       ${a.scopes.list.length} from ${a.scopes.preset}${args.scopes ? ` + ${show(resolve(process.cwd(), args.scopes))} (${a.scopes.mode})` : ''}: ${a.scopes.list.map((s) => s.name).join(', ') || 'none'}`);
  console.log(`   Users        ${a.users.map((u) => u.username + (u.platformAdmin ? ' (platform admin)' : '')).join(', ')}`);
  for (const o of a.organizations) {
    console.log(`   Tenant       ${o.alias}: ${o.members.map((m) => `${m.username}→${m.group}`).join(', ') || 'no members'}`);
  }
  for (const m of a.m2m) console.log(`   M2M client   ${m.clientId} (${m.organization}): ${m.serviceRoles.join(', ') || 'no permissions'}`);
  const t = realmThemes(a.realm);
  const themes = Object.keys(t).length
    ? ['login', 'account', 'admin', 'email'].map((k) => `${k} ${t[`${k}Theme`] ?? 'default'}`).join(', ')
    : 'Keycloak default';
  console.log(`   Themes       ${themes}`);
  console.log(`   Sign-in      Forgot password ${a.realm.resetPasswordAllowed ? 'on' : 'off'};  SMTP ${a.smtp ? `${a.smtp.host}:${a.smtp.port} from ${a.smtp.from}` : 'not set'}`);
}

function printNext(a, outFile, generated) {
  const realmUrl = `${a.realm.publicUrl}/realms/${a.realm.name}`;
  const row = (k, v) => console.log(`     ${k.padEnd(28)} ${v}`);
  section('Next steps', true);
  if (generated.length) {
    console.log('   Generated credentials (shown only now; they are in the realm file, not in the answers file):');
    for (const [what, value] of generated) row(what, value);
    console.log('');
  }
  console.log('   Keycloak:');
  console.log(`     mount ${show(outFile)} as /opt/keycloak/data/import/realm.json and start with --import-realm`);
  if (a.realm.kind === 'hosted') row('hostname (KC_HOSTNAME)', `${a.realm.publicUrl}   (behind a TLS proxy: also KC_PROXY_HEADERS=xforwarded)`);
  console.log('   Your backend (token checks and admin API):');
  row('issuer', realmUrl);
  row('JWKS URL', `${realmUrl}/protocol/openid-connect/certs`);
  row('audience', a.clients.api);
  row('admin client id', a.clients.admin);
  row('admin client secret', a.clients.adminSecret);
  row('M2M tenant claims', `${a.clients.claimPrefix}_tenant, ${a.clients.claimPrefix}_tenant_id`);
  console.log('   Your web app (OIDC, PKCE):');
  row('Keycloak URL', a.realm.publicUrl);
  row('realm', a.realm.name);
  row('client id', a.clients.web);
  console.log('');
  console.log(`   Keycloak imports the file only when realm "${a.realm.name}" does not exist yet. An existing realm`);
  console.log('   ignores it: delete the realm in the admin console first, or change it there.');
}

async function main() {
  const d = loadDefaults();
  const outDir = resolve(process.cwd(), args['out-dir'] ?? '.');
  if (args['out-dir'] && !args.out && !(await checkOutDir(outDir))) {
    console.log('Nothing written.');
    return;
  }
  const realm = await askRealm({ ...DEFAULTS.realm, ...d.realm });
  const clients = await askClients({ ...DEFAULTS.clients, ...d.clients }, realm);
  const scopes = await askScopes(d.scopes);
  const users = await askUsers(d.users ?? [], realm);
  const organizations = await askOrganizations(
    (d.organizations ?? []).map((o) => ({ ...o, members: o.members.filter((m) => users.some((u) => u.username === m.username)) })),
    users,
  );
  const permissions = permissionNames(applyScopes(base, scopes.list)).filter((p) => !isCore(p));
  const m2m = await askM2ms(d.m2m ?? [], organizations, realm, permissions);
  const smtp = await askSmtp(d.smtp, realm);
  const answers = { realm, clients, scopes, users, organizations, m2m, smtp };
  if (users.some((u) => !u.username || !u.email)) throw new Error('every user needs a username and an email address');

  const realmJson = buildRealm(answers, base);
  summary(answers);

  const outFile = args.out ? resolve(process.cwd(), args.out) : resolve(outDir, `realm-${realm.name}.local.json`);
  if (existsSync(outFile) && !args.yes && !(await confirm({ message: `${show(outFile)} exists. Overwrite?`, default: false }))) {
    console.log('Nothing written.');
    return;
  }
  if (!args.yes && !(await confirm({ message: `Write ${show(outFile)}?`, default: true }))) {
    console.log('Nothing written.');
    return;
  }
  if (!args.out) mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(realmJson, null, 2)}\n`);
  console.log(`\n✔ Wrote ${show(outFile)}`);

  if (!args.preset) {
    const answersFile = args.out ? outFile.replace(/(\.local)?\.json$/, '.answers.local.json') : resolve(outDir, `realm-${realm.name}.answers.local.json`);
    writeFileSync(answersFile, `${JSON.stringify(redactAnswers(answers), null, 2)}\n`);
    console.log(`✔ Wrote ${show(answersFile)} (no passwords or secrets; replay with --answers)`);
    if (!/\.local\.json$/.test(outFile)) console.log('  ! The realm file holds passwords and secrets: keep it out of version control.');
  }

  if (!args.preset) printNext(answers, outFile, GENERATED);
  else if (GENERATED.length) {
    section('Generated credentials (shown only now)', true);
    for (const [what, value] of GENERATED) console.log(`     ${what.padEnd(40)} ${value}`);
  }
}

main().catch((err) => {
  if (err?.name === 'ExitPromptError') {
    console.log('\nCancelled; nothing written.');
    process.exit(130);
  }
  console.error(`\n✖ ${err.message}`);
  process.exit(1);
});
