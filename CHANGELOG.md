# Changelog

Home Hub core, newest first. One section per release; the section is the text of that release on GitHub
(`node scripts/release.mjs <version> --notes` prints it). Parts, in this order, empty ones left out:
**Added**, **Changed**, **Deprecated**, **Fixed**, **Plugin contract**, **Data**, **Upgrade notes**. What the version
number promises is in `AGENTS.md` → Versioning. The top section is the release being prepared, `## Unreleased`
until the release gives it its number: a change to the public surface adds its line there in the same commit.

## 2.0.0

A major release: names on the public surface change, with no alias for the old ones.

### Changed

- **Breaking: device tokens are now app tokens.** The long-lived `hh_…` token of a native app keeps working, and
  everything that named it changes. A native app must be updated together with the hub:
  - Routes: `GET` and `POST /api/app-tokens` and `POST /api/app-tokens/revoke` replace `/api/devices/tokens` and
    `/api/devices/tokens/revoke`, which now answer `404`.
  - Answers: issuing returns `{token, app}` (was `{token, device}`); the list and the revoke answer carry `tokens`
    (was `devices`).
  - The error code `APP_TOKEN_LIMIT` replaces `DEVICE_LIMIT`.
  - `GET /api/me` reports `authKind: "app"` (was `"device"`) and the user name `Native app` (was `Native device`).
    Records written under the old name keep it and are still counted as a person's work.
  - The audit: `GET /api/admin/audit?kind=app` (was `kind=device`), with the events `app-token-issued` and
    `app-token-revoked` (were `device-issued`, `device-revoked`). Events recorded by 1.0 are shown under the new names.
  - A custom role can no longer be created with the id `app` (`device` is free again). A role that already has that
    id keeps working.
- **Breaking: the overview's routes are laid out again**, so that one path means one thing:
  - `GET /api/home/devices` is the list and `POST /api/home/devices` the hash-checked upsert (scope `home:write`).
    They replace `GET` and `POST /api/home/machines`, which now answer `404`.
  - `POST /api/home/devices/add` is the overview's **Add device** form (a person or an app, never an API key). It was
    `POST /api/home/devices`; a client that still posts the form there gets `400` from the upsert.
  - `POST /api/home/devices/remove` `{id, base?}` is the one removal and answers `{ok: true, id, removed: true}`
    (the overview's old route answered `{removed: <id>}`). It replaces `POST /api/home/machines/remove` and needs the
    scope `home:write`. `base` is required and checked as before; only a person signed in with a password may leave it
    out. An app token that removed with `{id}` alone must now send `base`.
- **Breaking:** `GET /api/router` names the site's own router entry `siteMachine` (was `machine`), apart from
  `devices`, the network clients the router saw.

### Plugin contract

- **Breaking:** `principal.authKind` is `app` for a native app's token (was `device`).

### Data

- **The data epoch is 2.** Going back to 1.x after 2.0 has started needs the backup made before the update
  (`node scripts/update.mjs apply` makes one), not only the older code.
- `state/device-tokens.json` (`{schemaVersion: 1, devices}`) becomes `state/app-tokens.json`
  (`{schemaVersion: 2, tokens}`) and `state/device-tokens-audit.jsonl` becomes `state/app-tokens-audit.jsonl`. Both
  are moved once, at the first start; ids and hashes are unchanged, so every issued token keeps working. A 1.x hub
  started on the migrated state finds no token file: every app token is refused until the backup is restored.

## 1.0.0

The first release of Home Hub core: one hub for a household's machines, services, software and work, with an HTTP
API, an MCP endpoint and a plugin contract. Everything below is new in the sense that nothing was released before it.

### Added

- **The hub.** The overview with Thermo and agent-less telemetry, the inventory map and services catalog, software
  versions and host protection, SSH keys, the router census, LLM runtimes and the LLM & Diffusion page, backup jobs,
  the Git LFS view, search, and the integrations page with a switch for everything the hub reads from outside.
- **The tracker and review.** Projects, tickets and features with comments and file attachments (up to 100 MB each,
  with a viewer for text, images, audio and video), and review items.
- **Access.** Sign-in, users and roles, service accounts, scopes and API keys, and an audit of who did what.
- **The MCP endpoint and the HTTP API** (`docs/API.md`).
- **Plugins** (`docs/plugins.md`). A plugin source is a directory of its own with `plugins/<id>/plugin.json` and
  `index.mjs`; a plugin registers routes, scopes, MCP tools, pollers, assets, integrations and sidebar entries, states
  the core range it supports, and imports core only as `home-hub/plugin-api` and `home-hub/testing`.
- **The instance directory** (`HOME_HUB_HOME`, `docs/storage.md`): configuration (`config/site.json`,
  `software-watch.json`, `images/`), data and secrets kept apart from the code, with `instance.json` naming the
  plugin sources, the service and its health check.
- **The push agent** for macOS, Linux and Windows (`docs/agent.md`). A machine reports its system and updates, the
  watched software, SSH keys and local LLM runtimes to the hub with a key of its own; the pages say whose record they
  show. `node scripts/install-host-agent.mjs --core` installs it as a launchd agent, a launchd daemon that runs from
  boot (`--service launchd-daemon`) or a systemd system service; `install-agent.ps1` installs it on Windows. The hub
  also checks every minute whether each machine's address answers.
- **Versions and updates.** The version in the footer, the manifest, the MCP `serverInfo` and `<state>/run.json`; an
  update check that only tells (`HOME_HUB_UPDATE_CHECK=off` turns it off); and `node scripts/update.mjs apply <tag>`
  (`docs/updating.md`), which checks, stops, archives, switches, starts, and puts the previous version back on any
  failure.
- **Release tooling.** `node scripts/release.mjs`, the leak scan (`node scripts/leak-scan.mjs`) and the pre-push hook
  that refuses to publish a household value.

### Deprecated

All of these keep working through 1.x and are removed in 2.0.

- **The in-tree overlay `local/` as the default** for the site configuration (`local/site.json`,
  `local/software-watch.json`, `local/images/`) and the plugins (`local/plugins/`). Keep them outside the code: an
  instance directory (`HOME_HUB_HOME`), or `HOME_HUB_CONFIG_DIR` and `HOME_HUB_PLUGINS_DIR`.
- **`edition.json`**, `HOME_HUB_EDITION` and `server/edition.mjs` (`readEdition`, `isPublicRelease`; `readEdition` is
  also exported by `home-hub/testing`). The file stays `{"edition":"public"}` and nothing new reads it.
- **The export**: `scripts/export-public.mjs`, `scripts/publish-public-branch.mjs`, `npm run export:public` and the
  private mode of `scripts/release.mjs`. Run by hand, the two scripts say so.
- **A plugin without `plugin.json`** still loads, with a warning; 2.0 will require the file.

### Upgrade notes

- **The agents do not update themselves.** A newer agent reaches a machine when its installer is run again from a
  newer checkout.
- **Not yet verified on a real machine:** the launchd daemon on a Mac; on Windows, an install whose health check
  passes on the machine itself, and the Windows Update search, which Windows refuses to `LocalService` (the update
  check then shows `unknown`); and the items each first-run checklist in `docs/agent.md` marks as not tried.
