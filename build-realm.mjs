/**
 * Pure: answers + the fixed template (a realm-base.json, see templates/) → a Keycloak realm import JSON. No prompts, no I/O, no
 * randomness (ids, passwords and secrets arrive in the answers), so a preset always produces the same file.
 *
 * Answers shape (see presets/example.answers.json):
 * {
 *   realm:   { name, displayName, sslRequired, theme, themes?, resetPasswordAllowed, rememberMe, accessTokenLifespan },
 *            // theme: the login theme ('' = Keycloak's default). themes?: { account, admin, email }, each a name or '';
 *            // absent = the email theme follows `theme` and account/admin use Keycloak's defaults.
 *   clients: { api, web, admin, adminSecret, webUrls: [..], cli,
 *              cliId?, claimPrefix?, names?: { api, admin, web } },   // optional: derived from the realm when absent
 *   users:   [{ username, email, firstName, lastName, platformAdmin, password, temporary }],
 *   organizations: [{ id, name, alias, tenantId, domains: [..], groupIds: { admins, members, viewers },
 *                     members: [{ username, group }] }],
 *   m2m:     [{ clientId, name, description, organization (alias), scopeRoles: [..], serviceRoles: [..], secret }],
 *   smtp:    null | { host, port, starttls, ssl, from, fromDisplayName, replyTo, auth, user, password },
 *   scopes?: { preset, mode: 'merge' | 'replace', list: [{ name, description, bundles: [tenant-admin|tenant-member|tenant-viewer] }] }
 *            // optional: the application permissions replacing the template's (tenant:* / platform:* always stay);
 *            // absent = the template's as they are. preset and mode only record how the list was made.
 * }
 */

/** Organization groups and the bundle (composite client role in the template) each grants. */
export const TENANT_GROUPS = { admins: 'tenant-admin', members: 'tenant-member', viewers: 'tenant-viewer' };

/** What the admin client's service account may do through Keycloak's admin REST API. */
const ADMIN_SERVICE_ROLES = [
  'manage-users', 'view-users', 'query-users', 'manage-clients', 'view-clients', 'query-clients', 'manage-realm', 'view-realm',
];

/** The api client's id inside the template; renamed to the answers' `clients.api`. */
const BASE_API_CLIENT = 'acme-org-api';

const audienceMapper = (api) => ({
  name: 'api-audience',
  protocol: 'openid-connect',
  protocolMapper: 'oidc-audience-mapper',
  config: {
    'included.client.audience': api,
    'access.token.claim': 'true',
    'id.token.claim': 'false',
    'introspection.token.claim': 'true',
  },
});

const hardcodedClaim = (name, claim, value) => ({
  name,
  protocol: 'openid-connect',
  protocolMapper: 'oidc-hardcoded-claim-mapper',
  config: {
    'claim.name': claim,
    'claim.value': value,
    'jsonType.label': 'String',
    'access.token.claim': 'true',
    'id.token.claim': 'false',
    'introspection.token.claim': 'true',
  },
});

const USER_CLIENT_SCOPES = {
  defaultClientScopes: ['web-origins', 'acr', 'profile', 'roles', 'basic', 'email'],
  optionalClientScopes: ['organization', 'offline_access'],
};

/** "https://x.com/app/" → { origin: "https://x.com", pattern: "https://x.com/app/*" } */
function webUrl(url) {
  const u = new URL(url);
  return { origin: u.origin, pattern: `${u.origin}${u.pathname.replace(/\/+$/, '')}/*` };
}

/** The template's client roles and composites, with the api client renamed. */
function roles(base, api) {
  const rename = (composites) =>
    composites?.client?.[BASE_API_CLIENT] ? { ...composites, client: { [api]: composites.client[BASE_API_CLIENT] } } : composites;
  return {
    realm: base.roles.realm.map((r) => (r.composites ? { ...r, composites: rename(r.composites) } : r)),
    client: {
      [api]: base.roles.client[BASE_API_CLIENT].map((r) => (r.composites ? { ...r, composites: rename(r.composites) } : r)),
    },
  };
}

/** All application and admin permission names the template defines (non-composite client roles). */
export function permissionNames(base) {
  return base.roles.client[BASE_API_CLIENT].filter((r) => !r.composite).map((r) => r.name);
}

// ---------- application scopes ----------
// A scope is an application permission: { name, description, bundles: [tenant-admin | tenant-member | tenant-viewer] }.
// The tenant:* and platform:* administration permissions are core: always kept from the template, never replaced.

export const CORE_PREFIXES = ['tenant:', 'platform:'];
export const isCore = (name) => CORE_PREFIXES.some((p) => name.startsWith(p));
const BUNDLES = Object.values(TENANT_GROUPS);
export const SCOPE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** The bundles a scope gets when it names none: admin and member always, viewer for read-only ones. */
export function defaultBundles(name) {
  return /:(read|lookup|list)$/.test(name) ? [...BUNDLES] : BUNDLES.filter((b) => b !== 'tenant-viewer');
}

/** A scope with every field filled in: bundles from the rule when absent, in TENANT_GROUPS order. */
export function normalizeScope(s) {
  const bundles = s.bundles ?? defaultBundles(s.name);
  return { name: s.name, description: s.description ?? '', bundles: BUNDLES.filter((b) => bundles.includes(b)) };
}

/** The template's application scopes (non-core permissions), with the bundles that include them. */
export function templateScopes(base) {
  const roles = base.roles.client[BASE_API_CLIENT];
  const bundles = roles.filter((r) => r.composite);
  return roles
    .filter((r) => !r.composite && !isCore(r.name))
    .map((r) => ({
      name: r.name,
      description: r.description ?? '',
      bundles: BUNDLES.filter((b) => bundles.find((x) => x.name === b)?.composites?.client?.[BASE_API_CLIENT]?.includes(r.name)),
    }));
}

/** preset + custom → one list. merge: custom appended, a custom scope wins on a name clash. replace: custom only. */
export function mergeScopes(preset, custom, mode = 'merge') {
  if (mode === 'replace') return custom;
  if (mode !== 'merge') throw new Error(`scopes mode must be merge or replace, not "${mode}"`);
  const byName = new Map(custom.map((s) => [s.name, s]));
  return [...preset.map((s) => byName.get(s.name) ?? s), ...custom.filter((s) => !preset.some((p) => p.name === s.name))];
}

/** Throws on a scope list the realm cannot hold. */
export function validateScopes(scopes) {
  const seen = new Set();
  for (const s of scopes) {
    if (!s?.name || !SCOPE_NAME.test(s.name)) throw new Error(`scope "${s?.name ?? ''}": letters, digits, . _ : - only`);
    if (isCore(s.name)) throw new Error(`scope "${s.name}": ${CORE_PREFIXES.join(' and ')} permissions come from the template and cannot be added`);
    if (BUNDLES.includes(s.name)) throw new Error(`scope "${s.name}": that is a bundle name`);
    if (seen.has(s.name)) throw new Error(`scope "${s.name}" appears twice`);
    seen.add(s.name);
    const unknown = (s.bundles ?? []).filter((b) => !BUNDLES.includes(b));
    if (unknown.length) throw new Error(`scope "${s.name}": unknown bundle ${unknown.join(', ')} (use ${BUNDLES.join(', ')})`);
  }
}

/** The template with its application permissions replaced by `scopes`; core permissions and bundle descriptions stay. */
export function applyScopes(base, scopes) {
  validateScopes(scopes);
  const list = scopes.map(normalizeScope);
  const roles = base.roles.client[BASE_API_CLIENT];
  const core = roles.filter((r) => !r.composite && isCore(r.name));
  const bundles = roles
    .filter((r) => r.composite)
    .map((r) => {
      const coreMembers = (r.composites?.client?.[BASE_API_CLIENT] ?? []).filter(isCore);
      const appMembers = list.filter((s) => s.bundles.includes(r.name)).map((s) => s.name);
      return { ...r, composites: { ...r.composites, client: { ...r.composites?.client, [BASE_API_CLIENT]: [...appMembers, ...coreMembers] } } };
    });
  return {
    ...base,
    roles: {
      ...base.roles,
      client: {
        ...base.roles.client,
        [BASE_API_CLIENT]: [...list.map((s) => ({ name: s.name, description: s.description, composite: false })), ...core, ...bundles],
      },
    },
  };
}

/** The realm's theme fields; empty ones are left out so Keycloak uses its default. */
export function realmThemes({ theme = '', themes } = {}) {
  const t = {
    loginTheme: theme,
    accountTheme: themes?.account ?? '',
    adminTheme: themes?.admin ?? '',
    emailTheme: themes?.email ?? theme,
  };
  return Object.fromEntries(Object.entries(t).filter(([, v]) => v));
}

export function buildRealm(a, base) {
  if (a.scopes) base = applyScopes(base, a.scopes.list ?? []);
  const permissions = new Set(permissionNames(base));
  for (const m of a.m2m) {
    const unknown = [...m.serviceRoles, ...(m.scopeRoles ?? [])].filter((r) => !permissions.has(r));
    if (unknown.length) throw new Error(`M2M client ${m.clientId}: unknown permission ${[...new Set(unknown)].join(', ')}`);
  }
  const { api, web, admin } = a.clients;
  const realmName = a.realm.name;
  const cliId = a.clients.cliId ?? `${realmName}-cli`;
  // M2M tenant binding: claims <p>_tenant / <p>_tenant_id, client attribute <p>.tenant, organization attribute <p>_tenant_id.
  const p = a.clients.claimPrefix ?? realmName.replace(/-/g, '_');
  const pDash = p.replace(/_/g, '-');
  const names = {
    api: `${a.realm.displayName} API (resource server)`,
    admin: `${a.realm.displayName}: Keycloak admin API (service account)`,
    web: `${a.realm.displayName} web UI`,
    ...a.clients.names,
  };
  const orgByAlias = new Map(a.organizations.map((o) => [o.alias, o]));

  const clients = [
    {
      clientId: api,
      name: names.api,
      description: 'Token audience. Its client roles are the permissions the gateway checks; tenant-* roles are bundles.',
      enabled: true,
      publicClient: false,
      bearerOnly: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
    },
    {
      clientId: admin,
      name: names.admin,
      description: 'Used only by the gateway to manage organizations, users and M2M clients',
      enabled: true,
      publicClient: false,
      clientAuthenticatorType: 'client-secret',
      secret: a.clients.adminSecret,
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
    },
    {
      clientId: web,
      name: names.web,
      enabled: true,
      publicClient: true,
      standardFlowEnabled: true,
      directAccessGrantsEnabled: false,
      redirectUris: a.clients.webUrls.map((u) => webUrl(u).pattern),
      webOrigins: a.clients.webUrls.map((u) => webUrl(u).origin),
      attributes: {
        'pkce.code.challenge.method': 'S256',
        'post.logout.redirect.uris': a.clients.webUrls.map((u) => webUrl(u).pattern).join('##'),
      },
      ...USER_CLIENT_SCOPES,
      protocolMappers: [audienceMapper(api)],
    },
  ];
  if (a.clients.cli) {
    clients.push({
      clientId: cliId,
      name: 'Dev only: password grant for curl testing',
      enabled: true,
      publicClient: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: true,
      ...USER_CLIENT_SCOPES,
      protocolMappers: [audienceMapper(api)],
    });
  }
  for (const m of a.m2m) {
    const org = orgByAlias.get(m.organization);
    if (!org) throw new Error(`M2M client ${m.clientId}: unknown organization "${m.organization}"`);
    clients.push({
      clientId: m.clientId,
      name: m.name,
      description: m.description,
      enabled: true,
      publicClient: false,
      clientAuthenticatorType: 'client-secret',
      secret: m.secret,
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
      fullScopeAllowed: false,
      attributes: { [`${p}.tenant`]: org.id },
      defaultClientScopes: ['acr', 'basic', 'roles'],
      optionalClientScopes: [],
      protocolMappers: [
        audienceMapper(api),
        hardcodedClaim(`${pDash}-tenant`, `${p}_tenant`, org.id),
        hardcodedClaim(`${pDash}-tenant-id`, `${p}_tenant_id`, org.tenantId),
      ],
    });
  }

  const organizations = a.organizations.map((o) => ({
    id: o.id,
    name: o.name,
    alias: o.alias,
    enabled: true,
    attributes: { [`${p}_tenant_id`]: [o.tenantId] },
    domains: o.domains.map((name) => ({ name, verified: false })),
    members: o.members.map((m) => {
      if (!o.groupIds[m.group]) throw new Error(`${o.alias}: member ${m.username} has unknown group "${m.group}"`);
      return { username: m.username, groups: [o.groupIds[m.group]] };
    }),
    groups: Object.entries(TENANT_GROUPS).map(([name, bundle]) => ({
      name,
      clientRoles: { [api]: [bundle] },
      id: o.groupIds[name],
    })),
  }));

  const users = [
    ...a.users.map((u) => ({
      username: u.username,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      enabled: true,
      emailVerified: true,
      credentials: [{ type: 'password', value: u.password, temporary: !!u.temporary }],
      realmRoles: [`default-roles-${realmName}`, ...(u.platformAdmin ? ['platform-admin'] : [])],
    })),
    {
      username: `service-account-${admin}`,
      enabled: true,
      serviceAccountClientId: admin,
      clientRoles: { 'realm-management': ADMIN_SERVICE_ROLES },
    },
    ...a.m2m.map((m) => ({
      username: `service-account-${m.clientId}`,
      enabled: true,
      serviceAccountClientId: m.clientId,
      clientRoles: { [api]: m.serviceRoles },
    })),
  ];

  const smtp = a.smtp && {
    host: a.smtp.host,
    port: String(a.smtp.port),
    starttls: String(!!a.smtp.starttls),
    ssl: String(!!a.smtp.ssl),
    from: a.smtp.from,
    fromDisplayName: a.smtp.fromDisplayName,
    ...(a.smtp.replyTo ? { replyTo: a.smtp.replyTo } : {}),
    auth: String(!!a.smtp.auth),
    ...(a.smtp.auth ? { user: a.smtp.user, password: a.smtp.password } : {}),
  };

  return {
    realm: realmName,
    displayName: a.realm.displayName,
    enabled: true,
    sslRequired: a.realm.sslRequired,
    registrationAllowed: false,
    loginWithEmailAllowed: true,
    accessTokenLifespan: a.realm.accessTokenLifespan,
    organizationsEnabled: true,
    ...realmThemes(a.realm),
    ...(a.realm.resetPasswordAllowed ? { resetPasswordAllowed: true } : {}),
    ...(a.realm.rememberMe ? { rememberMe: true } : {}),
    ...(smtp ? { smtpServer: smtp } : {}),
    roles: roles(base, api),
    clientScopes: base.clientScopes,
    defaultDefaultClientScopes: base.defaultDefaultClientScopes,
    defaultOptionalClientScopes: base.defaultOptionalClientScopes,
    clients,
    scopeMappings: [],
    clientScopeMappings: a.m2m.length ? { [api]: a.m2m.map((m) => ({ client: m.clientId, roles: m.scopeRoles })) } : {},
    organizations,
    users,
  };
}

/** Answers minus every password and secret, for the replayable `.answers.json`. */
export function redactAnswers(a) {
  return {
    ...a,
    clients: { ...a.clients, adminSecret: undefined },
    users: a.users.map((u) => ({ ...u, password: undefined })),
    m2m: a.m2m.map((m) => ({ ...m, secret: undefined })),
    smtp: a.smtp && { ...a.smtp, password: undefined },
  };
}
