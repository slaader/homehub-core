# Changelog

Home Hub core, newest first. One section per release; the section is the text of that release on the forge
(`node scripts/release.mjs <version> --notes` prints it). Parts, in this order, empty ones left out:
**Added**, **Changed**, **Deprecated**, **Fixed**, **Plugin contract**, **Data**, **Upgrade notes**. What the version
number promises is in `AGENTS.md` → Versioning. The top section is the release being prepared, `## Unreleased`
until the release gives it its number: a change to the public surface adds its line there in the same commit.

## Unreleased

### Added

- Projects support labels, the `web` type, epics, Wiki and Review opt-ins, and a guided upgrade for existing projects.
- Standalone Wiki spaces and project deletion can preserve linked Wikis and Review sets. Detached sets can be reassigned or deleted.
- HTTP and MCP clients can manage epics, filter tickets by epic, and find epic references and full-text results.

### Data

- Data epoch 12 advances hub.db to schema 7 and Wiki metadata to schema 5. Existing projects retain their revisions,
  settings and ticket counters. Wiki pages and assets retain their IDs. A rollback to epoch 11 uses the pre-update backup.

## 1.7.0

### Added

- `GET /api/tickets/search/status` and MCP `ticket_search_status` include a credential-free top-level `provider` descriptor (`{ configured, model }`).
- Non-ready `GET /api/tickets/search/hybrid` and MCP `ticket_hybrid_search` responses include top-level `extraction` alongside backward-compatible `coverage.extraction`.

### Changed

- `GET /api/ui/manifest` now reports `home_status` with `module: "home"` (owned by the `home` core module alongside `device_*`), and similarly reports the inventory, tracker/search, and review MCP tools under their owning core modules (`inventory`, `tracker`, `review`) instead of `core`.
- Users & API → Connect groups the MCP tool reference by module in exact `tools/list` order, translates titled modules cleanly, and labels read/write scopes without relying on colour alone.
- Consolidated core subsystems into deeper modules with unified interfaces: References (`server/references.mjs`), Safe-FS & Release Trust (`server/safe-fs.mjs`, `server/release-trust.mjs`), Ticket Search (`server/ticket-search.mjs`), Instance Backup & Archive Inspection (`server/update-backup.mjs`, `server/release-archive.mjs`), Release Source Adapters & thin updater CLI (`server/release-git.mjs`, `server/release-package.mjs`, `server/update-apply.mjs`, `scripts/update.mjs`), atomic Wiki authoring (`server/wiki-store.mjs`), and domain-free MCP dispatch (`server/mcp.mjs`).

### Fixed

- Hardened pre-switch package receipt, trust-policy reload, staged-tree reverification, and read-only backup assessment (including v1 directory modes, legacy macOS PAX/AppleDouble and GNU tar archives, and symlink/forbidden-root checks).
- Wiki inventory cell patches now execute atomically inside a single SQLite transaction without loading unrelated project assets.

### Plugin contract

- `mcpTools` definitions may provide an optional `subject(args, data)` hook returning a string (or `null`/`undefined`) for the write-audit log; it runs on write success and error after the scope check and is omitted on scope denial.

## 1.6.0

### Added

- Projects have settings: a named color, a board or table view, whether the project pages show releases, reviews and the wiki, and whether reference suggestions offer global sources. Every project projection returns all six with defaults. `POST /api/tickets/projects` and MCP `project_save` take a partial `settings` object under the project's `rev` and `tickets:write`; omitted fields keep their values. See [project settings](docs/project-settings.md).

### Changed

- `GET /api/references/suggest` and MCP `references_suggest` offer only the project's own sources, machines and projects when its `settings.globalReferences` is `false`. Saving, resolving and listing references are unchanged.

### Plugin contract

- Plugins can render device records and their edit form with the shared `/device-record.js` browser module. The plugin supplies edit access and saves.

### Data

- Data epoch 11 (hub.db schema 6) stores the settings on each project row. The upgrade adds the defaults to existing projects and keeps their revisions and ticket numbering. Rolling back to epoch 10 requires the pre-update backup.

## 1.5.0

### Added

- Reference native projects, wiki pages, tracker tickets and machines, documented models, and project-owned Custom records from wiki text, inventory cells, ticket descriptions and comments. Settings and the read API/MCP expose current titles, source links, descriptions and incoming uses. The new `references:write` scope manages shared documentation. Authors holding both write scopes can promote a local record without changing its ID.

### Changed

- Wiki backlinks include pages across projects when a tracker ticket is shared. Wiki and ticket saves report an unavailable reference when a newly inserted mention points to a missing target or a target outside the project's available references.

### Data

- Data epoch 10 adds revisioned reference records and native sharing annotations in SQLite, plus typed wiki runs and stable tracker Markdown tokens. The upgrade advances the database and wiki schema markers and preserves earlier documents. Rolling back to epoch 9 requires the pre-update backup.

## 1.4.0

### Added

- Enabled project wikis appear in the sidebar and the authenticated `GET /api/wiki` index. Expand a project to browse its pages while keeping the article at full width.
- Inventory cells group artwork, recordings and videos. The image gallery supports keyboard navigation and a thumbnail filmstrip.
- Wiki authors can select a display copy and an initial animation for a 3D model. Video previews can use a compatible display copy when the browser cannot play the original. With FFmpeg configured, the media endpoint can generate a WebM fallback with `?preview=webm`.
- MCP authors can discover wiki assets and approved sources, resume a batch of file uploads, read selected inventory cells and apply revision-checked changes. Review imports include the decision context for the selected media.

### Fixed

- MCP clients can continue after a request exceeds the inline body limit. Interrupted wiki saves preserve the browser draft.
- Published wiki media supports private conditional revalidation after access checks. Repeat opens can reuse the browser’s copy of an unchanged model.

### Data

- Data epoch 9 adds wiki media display references and source context. Existing pages and their media remain readable. Rolling back to an epoch-8 release requires restoring the backup from before the upgrade.

## 1.3.0

### Added

- Project wikis support child pages, subtree moves, inventory tables with ordered stats and attachments,
  and on-demand image, audio, video and 3D viewing. Authors can pin approved Git LFS and Review files
  and use the wiki MCP tools for the entire authoring flow. See [the wiki guide](docs/wiki.md)
  and [the API reference](docs/API.md#project-wiki).

- Wiki image attachments load bounded thumbnails from the authorized media endpoint when an installed
  FFmpeg is configured. Opening the gallery loads the full image.

### Fixed

- Sync wiki upload files and their directory entries before publishing them, and commit cleanup metadata
  durably before removing files. Retained staging documents count against the upload limits and must
  pass the wiki document validator.
- Wiki Git LFS imports pin paths through bounded Git object API requests on GitHub, Gitea and Forgejo
  and allow up to four imports at a time.

### Data

- Data epoch 8 upgrades `hub.db` to schema 3 and the wiki collection to schema 2. Existing pages become
  children of Home and retain their IDs, revisions and content. Wiki attachment bytes, resumable uploads
  and metadata live in the instance state directory. Restore the pre-update backup when rolling back.

## 1.2.0

### Added

- The updater streams and verifies backups with a separate size policy. `backup-diagnose` reports coverage,
  external hard-link candidates, limits and free space. `preflight --read-only` checks backup readiness without
  staging a release. Exact file coverage preserves hard-link groups across restore roots. See
  [updating.md](docs/updating.md#backup-coverage-and-budgets).
- Backups leave filesystem UNIX sockets in place. Rollback preserves listening endpoints and journals
  the durable children of their containing directories separately.
- Documented the verified separate driver for [upgrading a stock v1.0.0 checkout](docs/updating.md#upgrade-an-installed-v100-git-checkout).

### Data

- Data epoch 7 introduces journal schema 3 and backup manifest schema 2. A rollback across the epoch restores the
  pre-update backup. Use the retained updater driver with schema-3 journals, including when the installed release
  is v1.0.0 or v1.1.0 after rollback. Use it for subsequent backups and updates as well. The driver also reads older journals and archives.

### Upgrade notes

- Projects gain the optional wiki introduced in 1.1.0. Open a project and choose **Set up wiki** to enable it.
- From a stock 1.0.0 Git installation, the installed updater can apply the release when its backup checks pass.
  For large instances, linked media, or live UNIX sockets, use the separate driver described in
  [the upgrade guide](docs/updating.md#upgrade-an-installed-v100-git-checkout) so the backup uses the new format.

## 1.1.0

### Added

- **Project wiki.** Set up an editable Home page from a project. Write and rename pages with rich text, editable
  tables, static HTML blocks and links to existing project tickets. Ticket details show the pages that link to
  them. A save checks its revision and keeps the draft in the editor if another writer saved first.
  See [docs/wiki.md](docs/wiki.md) and [the HTTP API](docs/API.md#project-wiki).

### Data

- Data epoch 6 adds the wiki collection to `hub.db` using the existing SQLite tables. Database schema 2 prevents
  older releases from opening the newer state. Use the pre-update backup when rolling back to restore the previous state and remove the
  wiki collection.

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
- **Licence.** MIT (`LICENSE`, `package.json → license`).
- **Release tooling.** `node scripts/release.mjs`, the leak scan (`node scripts/leak-scan.mjs`) and the pre-push hook
  that refuses to publish a household value.

### Fixed

- Package verification follows the site's release repository and, like downloads, retains the selected operator
  trust policy for later operations. CLI discovery honors the same environment and integration disablement as the hub.

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
