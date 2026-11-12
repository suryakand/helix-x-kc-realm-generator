# @helix-x/kc-realm-generator: make a multi-tenant Keycloak realm file

Keycloak can create a realm (clients, roles, users, organizations) from one JSON file on its first start
(`--import-realm`). Writing that file by hand means editing ~1,200 lines of JSON per environment. This tool asks
for what differs per environment and writes the file; everything else comes from a fixed **template** that holds
your permission model (see [Templates](#templates)). The application permissions ("scopes") can come from the
template, from a predefined set, or from your own list (see [Application scopes](#application-scopes)).

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
| **Realm:** local or hosted (hosted → `sslRequired: external`, temporary passwords, no password-grant client by default), realm name (`acme-org`), display name (`Acme Org`), public Keycloak URL, themes for the login pages, account pages, admin console and emails (empty = Keycloak's default; see [Themes](#themes)), "Forgot password", "Remember me", access-token lifespan | The bundles `tenant-admin` / `tenant-member` / `tenant-viewer` (their names and descriptions) |
| **Clients:** web app URL(s) (redirect URIs, CORS origins, logout), a password-grant client for curl (dev only), the admin client's secret. Identifiers are derived from the realm name and can be changed: API client `acme-org-api` (the token audience), web client `acme-org-web`, admin client `acme-org-admin`, curl client `acme-org-cli`, M2M claim prefix `acme_org` | Realm role `platform-admin` (all `platform:*` permissions + `tenant-admin`) |
| **Application scopes:** a predefined set (the template's, `ef-track`, `generic-crud`, none), custom scopes from `--scopes` merged in or replacing it, scopes removed or added, and which bundles get each one | The `tenant:*` and `platform:*` administration permissions and their bundle memberships |
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

Both go to the current directory, or `--out-dir <dir>`; `--out <file>` names the realm file. An `--out-dir` that does
not exist is reported before any question, and the tool asks whether to create it (with `--yes` or `--preset`, it
does). Then it prints, once:

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
  falls back to its default. To check while you answer, pass `--providers <dir>` with the local directory that holds
  those JARs (such as the one you mount at `/opt/keycloak/providers`). The theme question then lists the `.jar` files
  in it, or, if you name a theme and it holds none (or does not exist), warns that Keycloak will use its default.
  It is a check only: it looks at file names, not inside the JARs, writes nothing to the realm or answers file, and
  prints nothing with `--yes` or `--preset`.

### Themes

Keycloak themes each kind of page separately, and the generator sets all four on the realm:

| Answer | Realm field | Pages |
|---|---|---|
| `realm.theme` | `loginTheme` | sign-in, registration, password reset |
| `realm.themes.account` | `accountTheme` | the account console (`/realms/<realm>/account`) |
| `realm.themes.admin` | `adminTheme` | the admin console of **this** realm (`/admin/<realm>/console`) |
| `realm.themes.email` | `emailTheme` | the emails Keycloak sends |

You are asked for the login theme first, then whether to use it for the other three too; answer no to name each one
(empty = Keycloak's default for that page type). An answers file without `themes` keeps the earlier behaviour: the
email theme follows the login theme, and the account and admin consoles use Keycloak's defaults.

- The **master realm** (and so the admin console most administrators use) is not in the realm file, and Keycloak never
  re-imports it. Theme it with Keycloak's server-wide default theme option, or the admin console / `kcadm.sh`.
- The account and admin consoles are React applications: a theme can change their logo, styles and messages, not
  their layout. Check which page types your theme JAR provides.

## Options

```bash
node generate-realm.mjs --answers realm-acme-org.answers.local.json   # questions, defaults from an earlier run
node generate-realm.mjs --answers <file> --yes      # no questions; missing passwords/secrets are generated
                                                    #   (an SMTP password cannot be: it fails, run without --yes)
node generate-realm.mjs --preset example --out /tmp/realm.json        # a preset: no questions, quiet
node generate-realm.mjs --preset path/to/answers.json --out <file>
node generate-realm.mjs --out-dir <dir> | --out <file>
node generate-realm.mjs --providers <dir>           # list the theme JARs in <dir> at the theme question (a check only)
node generate-realm.mjs --template <file>           # your template (default: templates/example.realm-base.json)
node generate-realm.mjs --scopes-preset <name|file> # application scopes to start from: template (default), ef-track,
                                                    #   generic-crud, none, or a scope file
node generate-realm.mjs --scopes <file> [--scopes-mode merge|replace]   # your own scopes, merged (default) or replacing
```

### `--answers` or `--preset`

Both read an **answers file** (the same format; see the sample below). Use `--answers` when you make or change the
realm of an environment, such as a server; use `--preset` when a script regenerates a fixed realm, such as a
project's committed development realm after a template change.

| | `--answers <file>` | `--preset <name or file>` |
|---|---|---|
| Takes | a path | a name from `presets/` (such as `example`) or a path |
| Questions | all asked, with the file's values as defaults; `--yes` skips them | none (`--yes` is implied) |
| Answers missing from the file | asked; with `--yes`, the default the question offers | the default the question offers |
| Passwords and secrets missing from the file | asked (generate or type); with `--yes`, generated, except an SMTP password: the run fails | generated, except an SMTP password: the run fails |
| Writes | the realm file **and** a complete answers file next to it | the realm file only |
| Prints | summary, generated credentials, next steps (issuer, client ids, …) | summary and generated credentials only |
| Realm file already there | asks before overwriting (with `--yes`, overwrites) | overwrites |

With both, `--preset` wins and `--answers` is ignored.

### A sample answers file

An answers file needs only what differs from the defaults. For example, `my-realm.answers.json`:

```json
{
  "realm": {
    "name": "acme-org",
    "displayName": "Acme Org",
    "kind": "hosted",
    "publicUrl": "https://auth.acme.example"
  },
  "clients": {
    "webUrls": ["https://app.acme.example"]
  },
  "users": [
    { "username": "admin", "email": "admin@acme.example", "firstName": "Acme", "lastName": "Admin", "platformAdmin": true }
  ],
  "organizations": [
    {
      "name": "Acme Logistics",
      "alias": "acme-logistics",
      "domains": ["acme.example"],
      "members": [{ "username": "admin", "group": "admins" }]
    }
  ],
  "smtp": null
}
```

```bash
node generate-realm.mjs --answers my-realm.answers.json          # every question, with these values as defaults
node generate-realm.mjs --answers my-realm.answers.json --yes    # no questions
```

Anything left out takes its default: client ids derived from the realm name (`acme-org-api`, `acme-org-web`, …),
"Forgot password" on, a 300-second token lifespan, new organization, tenant and group ids. `"smtp": null` means no
SMTP; leave `smtp` out to be asked. Either run writes `realm-acme-org.local.json` and
`realm-acme-org.answers.local.json`: every answer, including the generated ids, but no passwords or secrets. Use that
file for later runs, not your own, so the ids (and so your tenants) stay the same:

```bash
node generate-realm.mjs --answers realm-acme-org.answers.local.json   # updates that file too
```

Passwords and secrets are never saved, so each run asks for them again, or with `--yes` generates new ones.

`presets/example.answers.json` is a complete example for the fictional **Acme Org**: a local realm `acme-org`, users
`admin` / `jane` / `joe` at `acme.example`, tenant `acme-logistics` (jane admin, joe viewer) and an ERP M2M client. It
has no passwords or secrets, so they are generated. Copy it as the starting point for your own answers file: passwords
and secrets you put in one are used as given; leave them out to be asked or to have them generated.

Answers that have no question but can be set in an answers file: `clients.names` (`{ api, admin, web }` display names
of those clients; default derived from the realm's display name).

## Application scopes

The API client's permissions are of two kinds:

- **administration permissions**, `tenant:*` and `platform:*`. Your gateway and the `platform-admin` role depend on
  them, so they always come from the template, with the bundles the template puts them in;
- **application scopes**, everything else (`shipments:read`, `orders:cancel`, …). These differ per application,
  and you choose them in the "Application scopes" step.

That step works like this:

1. **Start from** the scopes saved in the answers file, or a predefined set (`--scopes-preset`):

   | Set | Scopes |
   |---|---|
   | `template` (default) | the template's own application permissions, as they are |
   | `ef-track` | container and vessel tracking: `tracking:lookup`, `shipments:*`, `vessels:*`, `carriers:*` (`scopes/ef-track.scopes.json`) |
   | `generic-crud` | `resources:read/create/update/delete`, `reports:read` (`scopes/generic-crud.scopes.json`) |
   | `none` | no application scopes, only the administration permissions |
   | a path | any scope file |

2. **Custom scopes** from `--scopes <file>` are listed for you to confirm, then **merged** with the starting set (a
   custom scope replaces a same-named one) or **replace** it (`--scopes-mode`, or asked).
3. **Remove** scopes with a checkbox, and **add** more by typing `name` or `name=description`, comma-separated.
4. **Bundles**: each scope goes into the bundles named in its `bundles`. A scope without that field gets the
   default rule: `tenant-admin` and `tenant-member` always, and `tenant-viewer` too when its name ends in `:read`,
   `:lookup` or `:list`. The resulting assignment is printed, and you can adjust each bundle with a checkbox.

M2M clients can be granted any application scope. If a permission an M2M client had in the answers file is no
longer a scope, it is dropped with a warning.

A scope file holds `{ "scopes": [...] }` or just the array:

```json
{
  "scopes": [
    { "name": "orders:read", "description": "List and read orders" },
    { "name": "orders:cancel", "description": "Cancel an order", "bundles": ["tenant-admin"] }
  ]
}
```

Scope names use letters, digits and `. _ : -`. They cannot start with `tenant:` or `platform:`, and cannot repeat.

The resolved list is saved in the answers file as `scopes: { preset, mode, list }`, so `--answers … --yes` replays
it exactly. An answers file without `scopes` uses the template's permissions unchanged.

## Templates

The template is the part of the realm that is the same in every environment: your permissions, the bundles that
group them, the `platform-admin` realm role and all client scopes. It belongs to your project, not to this package:
copy `templates/example.realm-base.json` into your repository, edit it, and pass it with `--template`. Keep it in
version control next to your services' permission checks, and test the two against each other.

What the generator expects of a template:

- `roles.client["acme-org-api"]`: the API client's roles. The API client is always called `acme-org-api` inside a
  template; the generator renames it to the chosen API client ID (`clients.api`).
  - non-composite roles are the permissions. Those starting with `tenant:` or `platform:` are administration
    permissions; every other one is an application scope (the `template` scope set; see
    [Application scopes](#application-scopes)) and can be granted to an M2M client;
  - the composite roles `tenant-admin`, `tenant-member` and `tenant-viewer` are the bundles the organization groups
    `admins`, `members` and `viewers` grant (`TENANT_GROUPS` in `build-realm.mjs`).
- `roles.realm`: realm roles, e.g. `platform-admin` (composite of the `platform:*` permissions and `tenant-admin`).
- `clientScopes`, `defaultDefaultClientScopes`, `defaultOptionalClientScopes`: copied as they are. Keep the
  customised `organization` scope: its mappers put the tenant id, groups and permissions into the token.

## Using it as a library

`build-realm.mjs` is the package's main export and is pure (no prompts, no I/O, no randomness):

```js
import { buildRealm, permissionNames, redactAnswers, TENANT_GROUPS } from '@helix-x/kc-realm-generator';
import { applyScopes, mergeScopes, templateScopes } from '@helix-x/kc-realm-generator';
```

`applyScopes(template, scopes)` returns the template with its application permissions replaced, and
`mergeScopes(preset, custom, 'merge' | 'replace')` combines two scope lists. Scope sets are importable as
`@helix-x/kc-realm-generator/scopes/<file>`.

`buildRealm(answers, template)` returns the realm JSON, with `answers.scopes` applied when present. The answers
shape is documented at the top of the file and in `presets/example.answers.json`. Templates are importable as
`@helix-x/kc-realm-generator/templates/<file>`.

## Changing the generator

| Change | Where |
|---|---|
| Administration permissions, bundles, client scopes | your template (see above); the example one is `templates/example.realm-base.json` |
| Application scopes | the "Application scopes" step, a `--scopes` file, or a new set in `scopes/<name>.scopes.json` |
| Shape of a client, user or organization | `build-realm.mjs` (pure: answers + template → realm JSON) |
| A new question | `generate-realm.mjs` (prompts), then use the answer in `build-realm.mjs`; add it to `presets/example.answers.json` |

Running Keycloaks never see template changes, because their realm already exists: apply them in the admin console.

## Development

```bash
npm install
npm test           # node --test: builder and CLI, no Keycloak needed
```

Releases are made by GitHub Actions on a push to `main`; see [RELEASING.md](RELEASING.md).

### Use a local copy without publishing

There is no build step: the package is published as written, so a checkout is already usable. Run `npm install` in
it first. Below, `../helix-x-kc-realm-generator` is the checkout as seen from your project.

**Run it directly**, without installing it in your project:

```bash
node ../helix-x-kc-realm-generator/generate-realm.mjs --template keycloak/realm-base.json
```

**Install a packed copy**: the closest to a published release, since it holds only the files a release holds
(`files` in `package.json`). Repack and reinstall after each change.

```bash
npm pack --pack-destination /tmp                                    # in the checkout: /tmp/helix-x-kc-realm-generator-<version>.tgz
npm install --save-dev /tmp/helix-x-kc-realm-generator-<version>.tgz # in your project
npx kc-realm-generator --help
```

**Install the checkout itself**: npm links your project to the folder, so changes take effect without reinstalling.

```bash
npm install --save-dev ../helix-x-kc-realm-generator                 # in your project
```

Either install also makes the library import (`@helix-x/kc-realm-generator`) use the local copy. Both write a
`file:` path into your `package.json` and `package-lock.json`: don't commit it. To go back to the published package:

```bash
npm install --save-dev @helix-x/kc-realm-generator@latest
```
