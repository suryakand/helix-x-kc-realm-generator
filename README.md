# @helix-x/kc-realm-generator: make a multi-tenant Keycloak realm file

Keycloak can create a realm (clients, roles, users, organizations) from one JSON file on its first start
(`--import-realm`). Writing that file by hand means editing ~1,200 lines of JSON per environment. This tool asks
for what differs per environment and writes the file; everything else comes from a fixed **template** that holds
your permission model (see [Templates](#templates)).

The realm it builds is **multi-tenant**: each tenant is a Keycloak **organization** with the groups `admins`,
`members` and `viewers`, mapped to permission bundles. Users get permissions through those groups, and
machine-to-machine clients are bound to one tenant through token claims.

```bash
npm install --save-dev @helix-x/kc-realm-generator
npx kc-realm-generator --template keycloak/realm-base.json      # interactive
npx kc-realm-generator --help
```

Without `--template` it uses the bundled example template (`templates/example.realm-base.json`), which is enough to
try it out: `npx kc-realm-generator --preset example --out /tmp/realm.json`. From a checkout of this repository, run
`node generate-realm.mjs` instead of `npx kc-realm-generator`.

Node 22+, ESM, one dependency (`@inquirer/prompts`). It does not need Keycloak running.

## What it asks, and what it never asks

| Asked (Enter accepts the default) | Fixed: from the template, never asked |
|---|---|
| **Realm:** local or hosted (hosted → `sslRequired: external`, temporary passwords, no password-grant client by default), realm name (`acme-org`), display name (`Acme Org`), public Keycloak URL, custom login/email theme name (empty = Keycloak's default), "Forgot password", "Remember me", access-token lifespan | The permissions (client roles of the API client) and the bundles `tenant-admin` / `tenant-member` / `tenant-viewer` |
| **Clients:** web app URL(s) (redirect URIs, CORS origins, logout), a password-grant client for curl (dev only), the admin client's secret. Identifiers are derived from the realm name and can be changed: API client `acme-org-api` (the token audience), web client `acme-org-web`, admin client `acme-org-admin`, curl client `acme-org-cli`, M2M claim prefix `acme_org` | Realm role `platform-admin` (all `platform:*` permissions + `tenant-admin`) |
| **Users:** username, email, names, platform admin or not, password, change at first sign-in. At least one platform admin | All client scopes, including the customised `organization` scope whose mappers put each tenant's id, groups and permissions into the token |
| **Organizations (tenants):** name, alias, email domains, members and their group | Groups `admins` / `members` / `viewers` in every organization, mapped to the bundles |
| **M2M clients:** tenant, client ID (`acme-org-m2m-<tenant>-…`), name, permissions, secret | Client shapes: audience mapper, PKCE for the web client, the tenant claims of M2M clients, the admin client's `realm-management` roles |
| **SMTP (optional):** provider (Gmail presets), host, encryption, port, From, display name, reply-to, login, password | Organizations enabled, self-registration off, sign-in with email on |

Passwords and secrets are either **generated** (random, shown once at the end) or **typed** (masked). Ids
(organizations, groups, tenant ids) are random UUIDs, kept across runs through the answers file.

### Tenant binding in tokens

With the claim prefix `acme_org`:

- each organization gets the attribute `acme_org_tenant_id` (your application's tenant id). The `organization` scope
  puts it, the organization id and the user's permissions there into the user's token;
- each M2M client gets the hardcoded claims `acme_org_tenant` (organization id) and `acme_org_tenant_id`, and the
  client attribute `acme_org.tenant`.

## What it writes

| File | Holds |
|---|---|
| `realm-<realm>.local.json` | The realm import, **with passwords and secrets**. Keep it out of version control (e.g. ignore `*.local.json`) |
| `realm-<realm>.answers.local.json` | Your answers **without** passwords or secrets, to rerun or tweak later |

Both go to the current directory, or `--out-dir <dir>`; `--out <file>` names the realm file. Then it prints, once:

- the generated passwords and secrets;
- how to load the file into Keycloak, and its hostname for a hosted setup;
- what your backend needs: issuer, JWKS URL, audience, admin client id and secret, the M2M tenant claim names;
- what your web app needs: Keycloak URL, realm, client id.

## Load it into Keycloak

Mount the file as the only file in Keycloak's import directory, and start with `--import-realm`:

```yaml
# docker compose
keycloak:
  image: quay.io/keycloak/keycloak:26.7.4
  command: ["start-dev", "--import-realm"]
  volumes:
    - ./realm-acme-org.local.json:/opt/keycloak/data/import/realm.json:ro
```

- Keycloak imports it **only if the realm does not exist yet**. For an existing realm, delete it in the admin
  console and restart Keycloak (this loses its users and data), or make the change in the admin console instead.
- Mount one file, not a directory holding the answers file too: Keycloak tries to import every `.json` there and
  fails on the answers file.
- A theme you name must be installed in Keycloak (a provider JAR in `/opt/keycloak/providers`); otherwise Keycloak
  falls back to its default. Pass `--providers <dir>` to have the tool list the JARs it finds there.

## Options

```bash
node generate-realm.mjs --answers realm-acme-org.answers.local.json   # defaults from an earlier run
node generate-realm.mjs --answers <file> --yes      # no questions; missing passwords/secrets are generated
                                                    #   (an SMTP password cannot be: it fails, run without --yes)
node generate-realm.mjs --preset example --out /tmp/realm.json        # a preset: no questions, quiet
node generate-realm.mjs --preset path/to/answers.json --out <file>
node generate-realm.mjs --out-dir <dir> | --out <file> | --providers <dir>
node generate-realm.mjs --template <file>           # your template (default: templates/example.realm-base.json)
```

A **preset** is an answers file run without questions: a name from `presets/` or a path. It writes no answers file
and prints only the passwords and secrets it had to generate. Use one to keep a fixed realm (such as a project's local
development realm) in step with the template: keep the preset in your project and regenerate the realm file from it.

`presets/example.answers.json` is a complete example for the fictional **Acme Org**: a local realm `acme-org`, users
`admin` / `jane` / `joe` at `acme.example`, tenant `acme-logistics` (jane admin, joe viewer) and an ERP M2M client. It
has no passwords or secrets, so they are generated. Copy it as the starting point for your own answers file: passwords
and secrets you put in one are used as given; leave them out to be asked or to have them generated.

Answers that have no question but can be set in an answers file: `clients.names` (`{ api, admin, web }` display names
of those clients; default derived from the realm's display name).

## Templates

The template is the part of the realm that is the same in every environment: your permissions, the bundles that
group them, the `platform-admin` realm role and all client scopes. It belongs to your project, not to this package:
copy `templates/example.realm-base.json` into your repository, edit it, and pass it with `--template`. Keep it in
version control next to your services' permission checks, and test the two against each other.

What the generator expects of a template:

- `roles.client["acme-org-api"]`: the API client's roles. The API client is always called `acme-org-api` inside a
  template; the generator renames it to the chosen API client ID (`clients.api`).
  - non-composite roles are the permissions. Those starting with `tenant:` or `platform:` are administration
    permissions; every other one can be granted to an M2M client;
  - the composite roles `tenant-admin`, `tenant-member` and `tenant-viewer` are the bundles the organization groups
    `admins`, `members` and `viewers` grant (`TENANT_GROUPS` in `build-realm.mjs`).
- `roles.realm`: realm roles, e.g. `platform-admin` (composite of the `platform:*` permissions and `tenant-admin`).
- `clientScopes`, `defaultDefaultClientScopes`, `defaultOptionalClientScopes`: copied as they are. Keep the
  customised `organization` scope: its mappers put the tenant id, groups and permissions into the token.

## Using it as a library

`build-realm.mjs` is the package's main export and is pure (no prompts, no I/O, no randomness):

```js
import { buildRealm, permissionNames, redactAnswers, TENANT_GROUPS } from '@helix-x/kc-realm-generator';
```

`buildRealm(answers, template)` returns the realm JSON; the answers shape is documented at the top of the file and
in `presets/example.answers.json`. Templates are importable as `@helix-x/kc-realm-generator/templates/<file>`.

## Changing the generator

| Change | Where |
|---|---|
| Permissions, bundles, client scopes | your template (see above); the example one is `templates/example.realm-base.json` |
| Shape of a client, user or organization | `build-realm.mjs` (pure: answers + template → realm JSON) |
| A new question | `generate-realm.mjs` (prompts), then use the answer in `build-realm.mjs`; add it to `presets/example.answers.json` |

Running Keycloaks never see template changes, because their realm already exists: apply them in the admin console.

## Development

```bash
npm install
npm test           # node --test: builder and CLI, no Keycloak needed
```

Releases are made by GitHub Actions on a push to `main`; see [RELEASING.md](RELEASING.md).
