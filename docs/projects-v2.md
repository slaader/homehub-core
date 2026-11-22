# Projects v2: epics, standalone wikis, deletion and upgrade

**Feature specification (proposed).** This document defines the product and technical design for extending Home Hub's Project Tracker with epics, standalone wiki spaces, project labels and the `web` type, controlled project deletion, Review overview refinements, and a guided `v1 → v2` project upgrade flow.

Related documents: [project-settings.md](project-settings.md), [wiki.md](wiki.md), [review.md](review.md), [storage.md](storage.md), [updating.md](updating.md), and [API.md](API.md).

## 1. Projects

### Data model

Every project row in `hub.db` (`kind='tickets'`, `coll='projects'`) keeps its permanent `id` and `key`, revision counter `rev`, and `settings` ([project-settings.md](project-settings.md)), and gains:

| Field | Values | Default (new project) | Notes |
|---|---|---|---|
| `type` | `web`, `app`, `game`, `other`, `null` | `null` | Extends `PROJECT_TYPES` with `web`. In Review, `web` opens HTML mockups first (same as `app`). |
| `labels` | array of up to 10 lowercase tags (`/^[a-z0-9][a-z0-9-]{0,29}$/`) | `[]` | Same tag grammar as tickets. Shown on project cards and project headers; editable in Project Settings → General. |
| `projectVersion` | `1`, `2` | `2` | Dedicated migration state (not a user tag). Pre-upgrade projects start at `1` and move to `2` once confirmed in the Upgrade Wizard. |
| `nextEpic` | positive integer (internal) | `1` | Per-project epic sequence counter; never exposed outside the server. |

### Projects overview (`#projects`)

- The page header contains only **`+ New project`** (the `+ New item` shortcut is removed from `#projects`; items are created from `#items` or inside a project).
- Toolbar filters allow narrowing projects by **`label`** and **`type`**.
- Clicking a project card opens the project workspace (`#projects/<id>`).
- Clicking **`⚙ Settings`** on a card or in the project header opens `#projects/<id>/settings`, where name, description, type, labels, look & feel, features, references, and **Delete project** live.

### New Project dialog

- Fields: **Name** (required, 1–80 chars), **ID** and **Key** (auto-proposed from Name, editable before save, permanent after save), **Description** (0–500 chars), **Type** (`web`, `app`, `game`, `other`, or none), **Labels**, and two opt-in checkboxes:
  - **Wiki** (unchecked by default in the UI): when checked, creating the project also creates its linked Wiki space and root page titled **`<Project Name> Home`**, and sets `settings.wiki = true`. When unchecked, sets `settings.wiki = false` and creates no wiki.
  - **Review** (unchecked by default in the UI): sets `settings.reviews = true` when checked, `false` when unchecked.
- **API/MCP semver compatibility**: existing API/MCP callers of `POST /api/tickets/projects` / `project_save` that omit `settings` continue to receive the existing defaults (`PROJECT_SETTINGS`) so no current client breaks. The UI form sends `settings.wiki` and `settings.reviews` explicitly (and triggers wiki creation when requested).

### Renaming a project

- Changing a project's `name` in Project Settings → General keeps `id` and `key` unchanged.
- If the project has a linked Wiki space, the Wiki space's display name in the sidebar follows the project's new name automatically.
- If the linked Wiki's root page title still exactly matches `<Old Project Name> Home`, it is updated to `<New Project Name> Home`. A root page that was manually renamed by a user is left untouched.

## 2. Epics

### Data model

An **Epic** is a first-class entity owned by one project, stored in `hub.db` under `kind='tickets'`, `coll='epics'`.

| Field | Type / rules | Notes |
|---|---|---|
| `id` | `<KEY>-E<n>` (e.g. `APP-E1`) | Generated from the project's permanent `key` and `nextEpic`. |
| `project` | `PROJECT_ID` | Owning project; immutable. |
| `title` | string (1–200 chars) | Required. |
| `description` | string (0–2,000 chars) | Short summary shown on cards and lists. |
| `spec` | Markdown string (0–65,536 bytes) | Dedicated plan/specification document describing goal, scope, and approach. Supports `@` mentions and `![file]` attachments; independent of Wiki. |
| `status` | `open`, `in-progress`, `done`, `cancelled` | Default `open`. |
| `priority` | `low`, `normal`, `high`, `urgent` | Default `normal`. |
| `release` | existing release version in the project, or `null` | Optional. |
| `assignee` | string (up to 60 chars) or `null` | Optional. |
| `labels` | up to 10 lowercase tags | Same grammar as tickets. |
| `refs` | up to 20 strings (1–300 chars) | Commits, PR links, related ticket/epic IDs. |
| `attachments` | up to 20 files | Content-addressed files shared with the tracker attachment store. |
| `comments` | up to 200 append-only comments | Supports `@` mentions and attachments. |
| `history` | up to 200 audit entries | Records field changes (with `title`, `description`, `spec` logged as changed without duplicating full bodies). |
| `reporter`, `createdAt`, `updatedAt`, `closedAt`, `rev` | standard tracker metadata | Optimistic concurrency via `rev`. |

### Relationship with tickets

- Every **Ticket** gains an optional `epic` field (`<KEY>-E<n>` or `null`), validated to belong to the ticket's project. A ticket belongs to at most one epic.
- Changing an epic's `status` (including `done` or `cancelled`) does **not** alter its tickets' statuses. The UI displays a non-blocking notice when marking an epic `done` while it still has `open` or `in-progress` tickets.
- **Standalone epic deletion** (`POST /api/tickets/epics/delete` / MCP `epic_delete`, `tickets:write`) removes the epic, detaches all tickets referencing it (`epic → null`), unindexes it from search, and cleans up unreferenced epic attachment files. Tickets themselves are never deleted by standalone epic deletion.

### Project and Epic UI

- **Project page (`#projects/<id>`)**: provides **Items** and **Epics** tabs. The Items view (board and table) adds an **Epic** filter (`All epics`, `No epic`, or a specific epic).
- **Epic detail (`#epics/<ID>`)**:
  - Header with status, priority, assignee, release, labels, and a **progress bar** computed over linked tickets (done / in-progress / open, excluding cancelled).
  - Main content renders **Specification (`spec`)** and **Description**, with edit mode supporting the Markdown chip editor, `@` mention picker, and *Make reference* from selected text.
  - **Linked tickets** section with:
    - **`+ New item in this epic`** (pre-fills `project` and `epic`).
    - **`+ Assign existing tickets`** button opening a searchable multiselect modal over the project's tickets so multiple tickets can be moved into the epic in one action.
  - **Linked Reviews** summary aggregating review sets attached to the epic's tickets (review sets remain ticket-first per [review.md](review.md)).
  - **References and where used**, **Comments**, **Attachments**, and **History** timeline.

### References, search and MCP

- **References**: `epic` is added as a first-class reference kind (`@[Title](ref:epic/APP-E1)` in Markdown, `{t:"ref", kind:"epic", id:"APP-E1", label}` in Wiki docs). Epics participate in `references_suggest`, `references_search`, `reference_get` (with incoming usages), and cross-project sharing (`reference_share`). Mentions inside epic `description`, `spec`, and `comments` are validated by `createMentionGuard`.
- **Search**: epics are indexed in `hub.db` FTS5 (`kind='epic'`) covering ID, title, description, spec, comments, attachment names, labels, refs, and people, and appear in global `#search`.
- **MCP tools**: `epics_list`, `epic_get`, `epic_create`, `epic_update`, `epic_comment`, `epic_delete` (and `epic` filter/field on `tickets_list`, `ticket_create`, `ticket_update`).

## 3. Wiki: project-linked and standalone spaces

### Space model

Wiki changes from strictly requiring a tracker project to a **Wiki space** model (`kind='wiki'`, `coll='wikis'`):

| Field | Type / rules | Notes |
|---|---|---|
| `id` | slug (`/^[a-z][a-z0-9-]{1,39}$/`) | Equals `project.id` for a project-linked wiki; user/slug-chosen for a standalone wiki. Unique across all spaces. |
| `name` | string (1–80 chars) | Display name for standalone spaces (for linked spaces, follows `project.name`). |
| `projectId` | `PROJECT_ID` or `null` | `null` indicates a standalone wiki space. At most one wiki space may link to a given project. |
| `home` | `PAGE_ID` | Root page ID. |
| `count`, `createdAt`, `createdBy` | existing metadata | Preserved. |

Existing pages, summaries, assets, uploads, receipts, and import grants remain keyed by `<spaceId>/<itemId>` (`#wiki/<spaceId>[/<pageId>]`), so detaching a project wiki preserves all page IDs, asset references, and URLs without rewriting pages.

### Standalone management and sidebar visibility

- **`+ New wiki`** is available in the expanded **Wiki** sidebar section and on a `#wiki` overview page for writers (`tickets:write`). Creating a standalone space takes a name (and auto-generated editable slug `id`) and initializes its root page titled **`<Name> Home`**.
- A standalone wiki space can be **renamed**, **deleted** (with confirmation, removing its pages, summaries, grants, and orphaning its assets for cleanup), or **linked to an existing project** that does not yet have a wiki.
- **Sidebar visibility (`settings.wiki`)**: turning `settings.wiki` off in Project Settings hides that project's wiki from both the project page and the Wiki sidebar. It deletes nothing; direct URLs (`#wiki/<id>`) and API/MCP calls continue to work.
- **Detached project wikis**: when a project is deleted and the user chooses to keep its wiki, `projectId` becomes `null` and `name` is snapshot from the project's last name. Existing inline `{t:"ticket", id}` links to deleted tickets render safely as unavailable badges rather than errors.

## 4. Review

- **Sidebar**: **Review** stays a single flat link (`#review`), not an expandable tree.
- **Overview (`#review`)**:
  - Each review set preview card displays a prominent **project label/badge in the top-right corner** (styled with the project's color token when set).
  - The toolbar includes **project filter chips** (same pattern as `#items`), including a **No project** chip whenever detached sets exist.
- **Settings**: `settings.reviews = false` remains presentation-only (hides Review entry points and creation prompts on the project's pages; existing direct links and API/MCP contracts stay unchanged).
- **Detached review sets**: when a project is deleted and the user chooses to keep its Reviews, each set is updated with `project: null` and `detachedProjectName: <project.name>` (and marked read-only for new publications):
  - Displayed in `#review` with a `<Original Project> · no project` top-right badge.
  - All rounds, variants, decisions, and comments remain readable. Publishing new rounds to a detached set is refused.
  - Writers (`review:write`) can either **delete** a detached set (cleaning up unreferenced blobs) or **reassign** it to another existing project (clearing unavailable ticket links or keeping them labeled for repair).

## 5. Project deletion

Project deletion is available in **Project Settings → General → Danger zone** (`#projects/<id>/settings`), via HTTP `POST /api/tickets/projects/delete`, and via MCP `project_delete`.

### What is always deleted

Deleting a project always deletes:
- The project row itself (guarded by `rev`).
- All **Epics** of the project (and their comments, history, search entries, and unreferenced attachments).
- All **Tickets** of the project (and their comments, history, search entries, and unreferenced attachments).
- All **Releases** of the project.
- Reference `notes` rows belonging to deleted tickets/epics.

### Conditional options for linked entities

The UI confirmation dialog computes what exists for the project, displays exact item counts (epics, tickets, releases, wiki pages, review sets, local references), requires typing the project's **key or name** to confirm, and shows checkboxes only for linked entities that exist:

| Option | API/MCP field | Default in UI | When checked (`true`) | When unchecked (`false`) |
|---|---|---|---|---|
| Delete Wiki | `deleteWiki` | unchecked (`false`) | Deletes the project's Wiki space, pages, summaries, grants, and orphans its assets for cleanup. | Detaches the Wiki space (`projectId → null`) into a standalone wiki. |
| Delete Reviews | `deleteReviews` | unchecked (`false`) | Deletes all Review sets of the project, their search entries, and unreferenced blobs. | Detaches Review sets (`project → null`, read-only) into *No project*. |
| Promote local References to global | `promoteReferences` | **checked (`true`)** | Moves all project-local Custom references to `global` (`scope='global', project=null`), preserving their stable `id` so existing `@` mentions keep resolving. | Deletes all project-local Custom references; existing `@` mentions in other projects or detached wikis fall back to their saved labels. |

### Reference label conflicts on promotion

- Global Custom references require unique case/diacritic-folded labels (`server/references.mjs`).
- Before submitting, the UI previews any local reference whose label collides with an existing global Custom reference.
- On execution with `promoteReferences: true`, colliding labels are automatically disambiguated by appending ` (<KEY>)` (e.g. `Hero (APP)` — with numeric suffix if needed, truncated within label limits) so project deletion is never blocked by a naming collision; the response lists renamed records.

### Required scopes

| Action | Required scope(s) |
|---|---|
| Delete project (epics, tickets, releases; detach wiki/reviews; delete local refs) | `tickets:write` |
| Plus `deleteWiki: true` | `tickets:write` (wiki writes use `tickets:write`) |
| Plus `deleteReviews: true` | `tickets:write` **and** `review:write` |
| Plus `promoteReferences: true` | `tickets:write` **and** `references:write` |

In the UI, any option whose extra scope the signed-in principal lacks is shown disabled with an explicit explanation. In HTTP/MCP, requesting an option without its scope returns `403` and changes nothing.

## 6. Upgrade and `v1 → v2` Project Migration Wizard

### Automatic database migration on `update.mjs apply`

When an operator upgrades Home Hub via `node scripts/update.mjs apply` ([updating.md](updating.md)) and the new version starts:

1. `server/db.mjs` executes one forward-only, atomic transaction migrating `hub.db` from **schema 6 → 7**, raising `package.json → homeHub.dataEpoch` from **11 → 12**, updating the wiki collection schema (`4 → 5`) for `projectId`/standalone spaces, and bumping `SEARCH_VERSION` to index epics.
2. Every existing project row keeps its `rev`, ticket counter `next`, `settings`, tickets, releases, wiki, and reviews intact, and receives:
   - `labels: []`
   - `nextEpic: 1`
   - `projectVersion: 1`
3. Existing projects, tickets, wikis, reviews, and MCP clients remain **100% operational immediately** after startup. Older releases refuse schema 7; rolling back restores the pre-update backup as documented in [updating.md](updating.md).

### Interactive `v1 → v2` Upgrade Wizard

Projects with `projectVersion: 1` show a **`v1 · Upgrade`** badge on their `#projects` card and a top banner on `#projects/<id>` with a **Start upgrade wizard** button. Opening a `v1` project normally is never blocked.

Clicking **Upgrade** opens a 4-step wizard for that project (writers with `tickets:write`):

1. **Project profile**: review/update `type` (including the new `web` type) and optionally add initial project `labels`.
2. **Linked Wiki & Review**: display the project's detected Wiki (page count; if the root page is still titled `Home`, offer a checkbox to rename it to `<Project Name> Home`) and detected Review sets (`R-…`), and confirm `settings.wiki` and `settings.reviews`.
3. **Local References** *(shown only when the project has local Custom references)*: display the count/names and confirm they remain scoped to this project.
4. **Epics & existing tickets**: display the count of existing tickets and let the user either:
   - confirm **“No epic needed right now — leave tickets unassigned (I can create epics and assign tickets manually later)”**, or
   - create one or more initial epics right away (and optionally assign existing tickets to them).

Confirming the final step saves the chosen updates (revision-checked via `rev`), sets **`projectVersion: 2`**, and removes the `v1` badge and banner.

## 7. HTTP and MCP contract summary

Additive routes and MCP tools (final schemas to be mirrored in [API.md](API.md) upon implementation):

| Area | HTTP routes | MCP tools | Scope |
|---|---|---|---|
| Projects | `POST /api/tickets/projects` (extended: `type:'web'`, `labels`, `projectVersion`, optional `createWiki`), `POST /api/tickets/projects/delete` | `project_save` (extended), `project_delete` | `tickets:write` (+ `review:write` / `references:write` per options) |
| Epics | `GET /api/tickets/epics`, `GET /api/tickets/epics/<ID>`, `POST /api/tickets/epics/create`, `POST /api/tickets/epics/update`, `POST /api/tickets/epics/comment`, `POST /api/tickets/epics/delete`, `POST /api/tickets/epics/<ID>/assign`, `PUT/GET/POST /api/tickets/epics/<ID>/attachments...` | `epics_list`, `epic_get`, `epic_create`, `epic_update`, `epic_comment`, `epic_delete` | `read` / `tickets:write` |
| Tickets | `POST /api/tickets`, `POST /api/tickets/update`, `GET /api/tickets` (extended with `epic`) | `tickets_list`, `ticket_create`, `ticket_update` (extended with `epic`) | `read` / `tickets:write` |
| Wiki spaces | `GET /api/wiki`, `POST /api/wiki/spaces` (create/rename/attach), `POST /api/wiki/spaces/delete` | `wiki_spaces_list`, `wiki_space_create`, `wiki_space_update`, `wiki_space_delete` | `read` / `tickets:write` |
| Review | `POST /api/review/sets/delete`, `POST /api/review/sets/reassign` (for detached sets); `GET /api/review?detached=true` | `review_set_delete`, `review_set_reassign` | `review:write` |
| References | Existing routes extended with `kind:'epic'` | Existing tools extended with `kind:'epic'` | `read` / `tickets:write` / `references:write` |

## 8. Acceptance criteria

### Server, storage and migration

- Creating a project accepts `type: 'web'` and validated `labels`; omitting `settings` from legacy API/MCP clients preserves existing defaults.
- Creating a project with `createWiki: true` creates both the project and its `<Project Name> Home` wiki space; renaming the project syncs the linked wiki name and updates `<Old Name> Home` only when unchanged.
- Epics support full CRUD, `spec` (up to 64 KiB Markdown with `@` mention validation and attachments), comments, history, `rev` conflict detection, FTS5 search, `kind:'epic'` references, and ticket `epic` linkage (same-project enforced).
- Standalone epic deletion detaches tickets (`epic → null`) without deleting them.
- Standalone wiki spaces can be created, edited, renamed, attached to a project without a wiki, and deleted independently of tracker projects; `settings.wiki = false` excludes a project wiki from the sidebar index while keeping direct reads working.
- Project deletion atomically removes epics, tickets, releases, and search entries; honours `deleteWiki`, `deleteReviews`, and `promoteReferences`; disambiguates global reference label collisions with ` (<KEY>)`; enforces `review:write` and `references:write` when those options are requested; leaves detached wikis and detached reviews readable and safely handles missing ticket links.
- Opening a literal schema-6 `hub.db` migrates forward to schema 7 in one transaction, setting `labels: []`, `nextEpic: 1`, `projectVersion: 1` while keeping `rev`, `next`, `settings`, tickets, wiki, and reviews intact; older code refuses schema 7.

### UI

- `#projects` header shows only `+ New project` and supports filtering by project type and label; New Project dialog offers `web` type, labels, and unchecked-by-default `Wiki` and `Review` checkboxes.
- Project pages offer **Items** and **Epics** tabs, Epic filtering on Items, Epic detail (`#epics/<ID>`) with progress bar, `spec`, `@` mentions / *Make reference*, and bulk **Assign existing tickets**.
- Wiki sidebar lists linked (where `settings.wiki !== false`) and standalone spaces with `+ New wiki`.
- Review sidebar remains flat; `#review` cards show the project badge in the top-right corner, support project filtering (including *No project*), and render detached sets read-only with delete/reassign actions.
- Project Settings → General includes **Delete project** with counts, key/name confirmation, conditional checkboxes for Wiki/Reviews/local References (with conflict warnings and scope-aware disable states).
- `v1` projects display the `v1 · Upgrade` badge and banner, remain usable without upgrading, and transition cleanly to `v2` through the 4-step Upgrade Wizard.

## 9. Implementation plan

The reviewed base is `main` at `6a3ec7e` (v1.7.0). This is a tier L change spanning persisted state, access control, the HTTP and MCP contracts, and the browser UI. Use the existing Node and browser modules with zero added dependencies.

### Agree on the shared interfaces first

1. **Project lifecycle.** Use one server implementation for project creation with a Wiki, rename, deletion and wizard completion. The existing SQLite collection change API owns a transaction for one collection. Extend it so lifecycle operations can change selected rows across Tracker, Wiki, Review and References in one transaction. Check scopes before writes and check revisions, ownership and associations again inside the transaction. Update search rows in that transaction and invalidate affected caches after commit. Defer physical file cleanup until after a durable commit and only remove unreferenced files. Audit existing Review and Wiki writers for stale writes that could restore deleted or detached rows.
2. **Wiki identity.** Proposed clarification for §3: a wiki created for a project uses the project ID, while attaching an existing space preserves the space's ID and URLs. Look up a project's wiki by `projectId`; use the space ID for pages, assets, uploads and import receipts. Return a conflict if the proposed ID is occupied. Keep the legacy `GET /api/wiki` response fields and add a space listing for navigation. Filter the sidebar by project settings and keep existing direct reads. Define mention visibility and import eligibility when a space has no project.
3. **Review and filters.** `none` is a legal existing project ID. Use an explicit detached filter such as `detached=true` in HTTP and the equivalent MCP option, preserving `project=none` for that project. Make detached sets readable and reject publication and feedback writes. Allow revision-checked delete or reassignment with `review:write`. Keep historical ticket IDs readable while detached and propose clearing unavailable or cross-project links on reassignment.
4. **Mutation payloads.** Define HTTP/MCP schemas, conflict responses, and fixtures before wiring adapters. Specify deletion preview counts and collision warnings, server-side key/name confirmation, omitted option defaults, and the behavior when dependencies change after preview. A safe proposed default for an omitted `promoteReferences` is to require an explicit choice when local references exist. Reserve `projectVersion` changes for the revision-checked wizard completion action. Commit profile, settings, any agreed Wiki title change, initial epics and ticket assignments together. Define assignment semantics for tickets already assigned to another epic and reject a stale or invalid batch atomically. Set a route body limit that accommodates an encoded 64 KiB spec plus its JSON envelope, and enforce the spec limit in UTF-8 bytes.

### Parallel implementation

Use three isolated worktrees based on the same `origin/main` revision and share the agreed payload fixtures. Each implementer owns focused tests at their interface.

| Lane | Ownership | Deliverable |
|---|---|---|
| A — Persistence and Tracker | `server/db.mjs`, `server/tickets-store.mjs`, tracker HTTP/MCP adapters, tracker attachment and search integration, data epoch and migration tests | Schema 7 and legacy import normalization, project fields, epic CRUD and bulk assignment, ticket filters, FTS5 indexing and removal, and the shared project lifecycle transaction. Place epic GET routes ahead of the existing ticket catch-all. Keep ticket-specific hybrid search and file access behavior intact. |
| B — Wiki, Review and References | Respective server stores, HTTP/MCP adapters, and shared reference format and validation | Standalone spaces and stable attach/detach, upload and import handling, detached Review and reassignment, epic references and backlinks, and lifecycle operations for deletion and reference promotion. Publish transaction-compatible store operations for lane A. |
| C — Browser | `public/app.js`, tracker, Wiki, Review and search views, shared UI and translations | Implement the Projects overview and settings, Epic views and assignment, Wiki navigation, Review filters and badges, deletion dialog and upgrade wizard. Begin with agreed response fixtures, then connect to real endpoints and verify routes, permissions and error states. Coordinate shared reference-format changes with lane B. |

Merge A's transaction interface and the shared payload definitions into the integration worktree first. Lanes B and C can work against those definitions while A finishes migration and Tracker. Integrate the server lanes before binding the UI to live endpoints. The coordinator owns shared API documentation, changelog and test-window metadata. Update the API and storage docs alongside the implementation and include the data-epoch change in the changelog's Data section. Preserve the updater's existing backup and restore path.

### Independent review and verification

The review agent can inspect the interface proposal up front, then review the combined diff against this specification and repository standards. Prioritize cross-collection rollback, authorization parity, stale writes, resource cleanup and migration compatibility. Include exact reproduction steps and identify any acceptance criteria still lacking coverage.

- **Migration and rollback.** Open a literal schema-6 database with Wiki schema-4 data and representative Tracker, Review and Reference rows. Check preserved IDs, revisions, counters, settings and old-client reads and writes. Verify migration on restart, refusal by older code, fresh installs and legacy imports, and restore from the updater backup.
- **Contracts and atomicity.** Exercise HTTP and MCP with limited scopes, stale revisions, a mixed-project assignment batch and an injected failure during project deletion. Check that rejected writes leave all rows and FTS entries intact. Cover folded reference collisions including numeric suffixes, shared blobs, Wiki attachment links and mentions, detached Review mutations, and deletion followed by project ID reuse. Verify the spec byte limit with multibyte input and JSON escaping.
- **Live preview.** Use a generic fixture and isolated local state. Walk through an existing project's wizard, epic creation and assignment, Wiki opt-in and rename, Review reassignment, and both keep and delete choices with different scopes. Verify desktop and narrow layouts and stop the preview after testing.
- **Release candidate checks.** Run the full core suite, the Python router suite, and the leak scan. On macOS, use a short, securely owned temporary directory for Unix sockets and release trust fixtures. Record the latest run for each selected window in `TEST-WINDOWS.json`. Use an isolated updater smoke test for the schema boundary before considering a minor release.
