# Changelog

Home Hub core, newest first. One section per release; the section is the text of that release on the forge
(`node scripts/release.mjs <version> --notes` prints it). Parts, in this order, empty ones left out:
**Added**, **Changed**, **Deprecated**, **Fixed**, **Plugin contract**, **Data**, **Upgrade notes**. What the version
number promises is in `AGENTS.md` → Versioning. The top section is the release being prepared, `## Unreleased`
until the release gives it its number: a change to the public surface adds its line there in the same commit.

## 1.0.0

The first release of Home Hub core: one hub for a household's devices, services, software and work, with an HTTP
API, an MCP endpoint and a plugin contract. Everything below is new in the sense that nothing was released before it.

### Added

- **The hub.** The overview with Thermo and agent-less telemetry, the inventory map and services catalog, software
  versions and host protection, SSH keys, the router census, LLM runtimes and the LLM & Diffusion page, backup jobs,
  the Git LFS view, search, and the integrations page with a switch for everything the hub reads from outside.
- **The tracker and review.** Projects, tickets and features with comments and file attachments (up to 100 MB each,
  with a viewer for text, images, audio and video), review items and review sets linked to tickets, full-text search
  and optional meaning-based ticket search (a configured provider and an administrator's opt-in).
- **Devices and services.** The devices and services catalog (`#device-catalog`, `GET /api/device-catalog`, MCP
  `device_catalog`) and typed service registration (`POST /api/service-registrations`, MCP `service_register`,
  `scripts/setup-service.mjs`, `docs/services.md`).
- **Access.** Sign-in, users and roles, service accounts, scopes and API keys, and an audit of who did what.
- **The MCP endpoint and the HTTP API** (`docs/API.md`).
- **Plugins** (`docs/plugins.md`). A plugin source is a directory of its own with `plugins/<id>/plugin.json` and
  `index.mjs`; a plugin registers routes, scopes, MCP tools, pollers, assets, integrations and sidebar entries, states
  the core range it supports, and imports core only as `home-hub/plugin-api` and `home-hub/testing`.
- **The instance directory** (`HOME_HUB_HOME`, `docs/storage.md`): configuration (`config/site.json`,
  `software-watch.json`, `images/`), data and secrets kept apart from the code, with `instance.json` naming the
  plugin sources, the service and its health check.
- **The push agent** for macOS, Linux and Windows (`docs/agent.md`). A device reports its system and updates, the
  watched software, SSH keys and local LLM runtimes to the hub with a key of its own; the pages say whose record they
  show. `node scripts/install-host-agent.mjs --core` installs it as a launchd agent, a launchd daemon that runs from
  boot (`--service launchd-daemon`) or a systemd system service; `install-agent.ps1` installs it on Windows. The hub
  also checks every minute whether each device's address answers.
- **Versions and updates.** The version in the footer, the manifest, the MCP `serverInfo` and `<state>/run.json`; an
  update check that only tells (`HOME_HUB_UPDATE_CHECK=off` turns it off); and `node scripts/update.mjs apply <tag>`
  (`docs/updating.md`), which checks, stops, archives, switches, starts, and puts the previous version back on any
  failure.
- **Signed release packages and a hardened updater.** Operator-configured release trust and signed source packages,
  verified locally and installed from the command line (`docs/updating.md`); exclusive updater locks, verified backups
  with staged restoration, per-root recovery and a health check that waits for the exact build to stay ready.
- **Release tooling.** `node scripts/release.mjs`, the leak scan (`node scripts/leak-scan.mjs`) and the pre-push hook
  that refuses to publish a household value.

### Deprecated

All of these keep working through this major version and are removed in 2.0.

- **The in-tree overlay `local/` as the default** for the site configuration (`local/site.json`,
  `local/software-watch.json`, `local/images/`) and the plugins (`local/plugins/`). Keep them outside the code: an
  instance directory (`HOME_HUB_HOME`), or `HOME_HUB_CONFIG_DIR` and `HOME_HUB_PLUGINS_DIR`.
- **`edition.json`**, `HOME_HUB_EDITION` and `server/edition.mjs` (`readEdition`, `isPublicRelease`; `readEdition` is
  also exported by `home-hub/testing`). The file stays `{"edition":"public"}` and nothing new reads it.
- **The export**: `scripts/export-public.mjs`, `scripts/publish-public-branch.mjs`, `npm run export:public` and the
  private mode of `scripts/release.mjs`. Run by hand, the two scripts say so.
- **Git updates without independently configured trust** keep the legacy signature behavior, now with an explicit
  warning. Bare `apply` still takes the highest stable local tag. A stale updater lock needs manual maintenance after
  checking that no updater or child process is still active.
- **A plugin without `plugin.json`** still loads, with a warning; 2.0 will require the file.

### Plugin contract

- A plugin states the core range it supports in `plugin.json → core` (`>=1.0.0 <2.0.0` for this release) and imports
  core only as `home-hub/plugin-api` and `home-hub/testing`. Its own version is its own.

### Data

- Data epoch 5. It holds schema-2 update journals, backup manifests and integrity sidecars, operator trust and
  required-policy markers and package receipts; schema-1 journals and older backups stay recoverable. Restoring across
  the epoch boundary needs the archive made before the update; trust and revocations stay outside the restored paths.

### Upgrade notes

- **The update check reads GitHub releases only** (`docs/updating.md`, `README.md`). A hub whose releases live on
  another forge applies updates with `node scripts/update.mjs apply <tag>` and turns the check off
  (`HOME_HUB_UPDATE_CHECK=off`) or points `site.json → updates.repo` at a GitHub mirror.
- **The agents do not update themselves.** A newer agent reaches a device when its installer is run again from a
  newer checkout.
- **Not yet verified on a real device:** the launchd daemon on a Mac; on Windows, an install whose health check
  passes on the device itself, and the Windows Update search, which Windows refuses to `LocalService` (the update
  check then shows `unknown`); and the items each first-run checklist in `docs/agent.md` marks as not tried.
