# Project settings

Each tracker project has a settings page: what the project is called and what it is, how it looks, which of its
parts its pages show, and which references its authors are offered. This document is the product specification.
The HTTP and MCP contract is in [API.md](API.md#project-tracker-ui-projects-items-releases), the storage in
[storage.md](storage.md#hubdb).

## What a project stores

Settings live on the project row, next to `name`, `description` and `type`, under the project's `rev`. They are
additive: nothing that existed before changes meaning.

| Field | Values | Default | What it does |
|---|---|---|---|
| `color` | `null`, `slate`, `red`, `orange`, `amber`, `green`, `teal`, `blue`, `violet` | `null` | The project's named color wherever the project is shown (chips, cards, headers). `null` is the neutral look. A name, never a hex value: the UI maps each name to design tokens for light and dark themes. |
| `view` | `board`, `table` | `board` | How the project page lists its items. It is the project's choice for everyone, not a personal toggle. |
| `releases` | boolean | `true` | Show the project's releases on its pages. |
| `reviews` | boolean | `true` | Show review entry points and request controls for the project. Existing review links remain visible. |
| `wiki` | boolean | `true` | Show the project's wiki entry points on its pages. |
| `globalReferences` | boolean | `true` | Offer global references, and wiki pages and tickets other projects share, in this project's reference suggestions. |

Every answer that carries a project carries all six fields, each filled with its default when the project never
set it: `GET /api/tickets` (`projects`), MCP `projects_list` and `tickets_list`, and the answer of every project
save. That includes projects seeded from `site.json → tracker.projects`, projects imported from an old
`tickets.json`, and projects written by a release before data epoch 11.

### Presentation, not permission

`releases`, `reviews` and `wiki` only decide what the project's pages show. Turning one off:

- removes, archives or locks nothing; there is no side effect when it is turned on again either;
- leaves every route, MCP tool and direct link working (`#releases`, `#review/...`, `#wiki/<project>`, the APIs);
- leaves existing records as they are: releases still plan tickets, review sets still take rounds, wiki pages
  still resolve and are still searched.

`globalReferences` is about discovery only. When it is `false`, `GET /api/references/suggest` and MCP
`references_suggest` for that project leave out global Custom and model records and the wiki pages and tickets
other projects share. They still return the project's own sources (its local Custom records, its wiki pages and
tickets, shared ones it owns included), every machine and every project. Nothing else changes: a mention already
saved stays valid, a global mention typed or pasted in is still accepted on save, resolution, the References
catalog, incoming uses and cross-project sharing behave as before.

## Saving

Settings are saved through the project save that already exists: `POST /api/tickets/projects` and MCP
`project_save`. There is no new route and no new scope.

- **Permission.** `tickets:write`, like every tracker write: a write session (same origin) or an API key with
  that scope. A `read` key or a read-only session gets `403` (MCP: the tool is not listed and a call is an error)
  and nothing is written. Readers see the settings and the settings page read-only.
- **Partial.** `settings` names only the fields to change; the others keep their values. An explicit `false`
  is a value and is kept. `{}` changes no setting. A client that does not know settings (it sends only `name`,
  `description` or `type`) leaves them untouched.
- **Exact.** An unknown field, a wrong type (`"false"`, `0`, `null` where a boolean or a view is expected) or a
  value outside the lists is `400` (`TICKETS_FAILED`) and writes nothing, including the other fields of the
  same request.
- **Revision.** A change needs the project's current `rev`; a stale one is `409` and writes nothing. Every
  successful save raises `rev` by one, whatever it changed. The merge happens inside the same transaction as the
  rev check, so two saves of different fields from the same rev cannot both win: the second is refused and its
  client reads again and reapplies.
- **Create.** A new project may pass `settings`; omitted fields start at the defaults.
- **Identity.** `id` and `key` never change. Ticket numbering (`<KEY>-<n>`) continues as before.

### Prior state and upgrade

Data epoch 11 moves `hub.db` from schema 5 to 6. The upgrade writes the default settings into every project row
that has none, in one transaction at start-up. It changes no other field: `rev`, the ticket counter, names and
timestamps stay, so a `rev` read before the upgrade still saves afterwards. A release before epoch 11 refuses a
schema-6 database rather than misreading it; going back means restoring the backup taken before the update
([updating.md](updating.md)). Projects archive and delete are not part of this change.

## Settings page

Each project card has a settings gear. The project page (`#projects/<id>`) also has one in its header. It opens `#projects/<id>/settings`, a page
with tabs, each with its own address so it can be linked, reloaded and moved through with Back and Forward:

| Address | Tab |
|---|---|
| `#projects/<id>/settings` | General |
| `#projects/<id>/settings/look` | Look and feel |
| `#projects/<id>/settings/features` | Additional settings |
| `#projects/<id>/settings/references` | References |

An unknown tab or project shows the not-found state, not another tab. Readers can open every tab; the controls
are read-only for them and say why. Every save sends the `rev` the page read; a `409` keeps what the user entered,
says the project changed, and offers to reload it.

### General

- Editable: name (1–80 characters), description (up to 500), type (`app`, `game`, `other`, none).
- Shown, not editable: the project ID and the ticket key, with a note that they never change.

### Look and feel

- Color: the eight named colors and "none", as swatches that are labelled buttons (the name is text and
  `aria-label`, never color alone), with the current one marked for assistive technology as well as visually.
  The choice applies to the whole project for everyone.
- View: board or table, the project's default listing for everyone.

### Additional settings

- **Releases**, **Reviews**, and **Wiki** control project entry points and contextual creation. Existing content
  and direct links remain available. Creating a wiki still requires an explicit setup action.
- **Global references** controls whether editors in this project suggest global records and shared sources from
  other projects. When off, it also hides the Global option when creating a reference from selected text.
  Saved mentions still resolve.

### References

- **This project's references**: the list of the project's own sources from `GET /api/references?scope=local&project=<id>`,
  with search (`q`, the catalog's prefix match), an optional kind filter and pagination by `offset`/`limit`. The
  order is stable, so pages neither repeat nor skip; a page past the end shows the empty state, and a change
  made meanwhile shows on the next read.
- **Create a project Custom record** from this tab (`POST /api/references/local/save`, `tickets:write`), with the
  usual revision and duplicate-label rules.
- References appear as visible, accessible chips (text label, kind, keyboard focus, a name for screen readers),
  the same chips mentions use elsewhere.
- The central catalog in Settings → References (`#references`) is unchanged: global records, promotion and
  sharing stay there.

## Project page

- The project page lists its own items in the project's `view` (board or table), with filters of its own: they
  narrow only this project's list, are not shared with `#items` or another project, and do not leak into the
  address of another page.
- The old "Table →" action that jumped from the project page to the global `#items` list is removed; `#items`
  stays in the navigation.
- The project's color, and the presence of its releases, reviews and wiki sections, follow its settings.

## Not in scope

- Archiving or deleting a project, and any UX for it.
- Personal, temporary view toggles: the view is the project's setting.
- A separate settings API or scope, or settings that grant or withhold access.
- Changes to how saved references are validated, resolved, listed or shared across projects.

## Acceptance

Server (core tests, `tests/project-settings.test.mjs`, `tests/data-epoch.test.mjs`):

- Seeded, created, imported (`tickets.json`) and pre-epoch-11 projects all project the six fields with defaults;
  the store's defaults and the migration's are the same values.
- Partial saves merge: omitted siblings stay, an explicit `false` stays, a name-only save from an old client keeps
  the settings, `null` resets the color, `{}` changes no setting, ticket numbering continues.
- Invalid settings (unknown field, wrong type, unlisted value, `null`, an array) are refused on create and update
  and write nothing; a stale `rev` is a conflict; the ticket counter never leaves the server.
- A literal schema-5 `hub.db` opens as schema 6 with defaults added and `rev`, counter and every other field kept;
  a rev read before the upgrade still saves; a database newer than the code is refused.
- HTTP and MCP: `tickets:write` saves, `read` is refused and changes nothing, `projects_list` and `tickets_list`
  show the settings, the MCP schema lists exactly the six fields and rejects others.
- Hidden features keep working: a release can be saved and a wiki set up and read while those switches are off.
- `globalReferences: false` leaves out global Custom and model records and other projects' shared items from the
  project's suggestions (HTTP and MCP), keeps its own items (a shared one it owns included), machines and
  projects, and changes nothing for other projects; the catalog listing, resolution and saving a global mention
  are unchanged; the project's local catalog pages are disjoint, ordered and complete.

UI (browser and DOM tests, owned with the UI work):

- The gear opens General; each tab address loads its tab directly, after reload and through Back/Forward; an
  unknown tab or project shows not-found.
- ID and key are read-only; name, description and type save with the rev and show a conflict without losing input.
- Color swatches and switches are keyboard-operable, labelled, and announce their state; the project color shows
  in light and dark themes.
- The view setting changes the project page's listing for everyone; the project's filters stay its own; the
  "Table →" shortcut is gone.
- Turning off releases, reviews or wiki hides those sections and leaves their direct links working.
- The References tab lists, searches and pages the project's local references and creates a project Custom record.
- The global references setting controls suggestions and the availability of the Global creation option. In the
  Make reference form, the checkbox and its label sit together and work by pointer and keyboard.
- Saved mentions use accessible, visibly distinct chips. A mention inside the visible excerpt of a collapsed
  inventory cell has the same visual treatment. The expanded cell contains the link.
- Readers see every tab read-only.
