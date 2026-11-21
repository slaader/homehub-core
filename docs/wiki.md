# Project wiki

Open a project in **Projects** and choose **Set up wiki**. Setup opens **Home** for editing. On later
visits, expand **Wiki** under **Project Tracker** in the sidebar, then choose a project and a page.
The sidebar lists projects once their wiki is set up. Expand the control next to **Home** or any parent
to see its child pages. The project toolbar also opens **Home** directly. Anyone with read access
can open an enabled wiki. A person or API key with `tickets:write` can set up a wiki and save changes.

Choose **New child page** on Home or any other page. Use the page tree, the breadcrumb or the
**Child pages** list to navigate. **Move page** changes the parent for a page and its subtree.
Choose **Edit** and change **Page title** to rename a page. Page URLs and ticket backlinks keep
the same IDs through moves and renames. Home stays at the root.

- The formatting toolbar offers headings, lists, quotes, code, links and common inline styles.
- Insert a table, then place the caret in a cell to add or remove rows and columns or toggle the header.
  Tab and Shift+Tab move between cells. Tab in the last cell adds a row while there is room.
- Choose **Ticket** and search by id or title to link an existing ticket in this project. The ticket's
  **Wiki** section lists every saved page linking to it.
- Choose **HTML block** for static content. Give the block a label, set its height, and use **Preview**
  to check it before saving. The frame supports common HTML formatting, inline CSS and embedded
  data images. Active markup and navigation attributes are stripped. The sandbox blocks scripts,
  forms and network resources.

Use **Save** or Cmd/Ctrl+S. If another writer saved first, your draft stays open. Choose **Save as
new page** to preserve it as a separate page, or **Reload saved version** to discard the draft and
open the latest version. An unsaved draft is also kept for that page in the browser tab when you
navigate away.

## Inventory and media

In the editor choose **Inventory table**, name the columns, and add rows. Use the arrows to reorder
columns or rows. Open **Edit cell** to add rich text, ticket links, ordered stats or attachments.
Each stat has a name, a value and an optional unit. Each inventory table can use different columns.
Cells show the first four stats. Open **All stats** for the rest or **Cell text** to expand a longer description.
Use the table's scroll region to see additional columns on a narrow screen. Choose **Attachment group**
to include media outside a table.

In either group choose **Add attachment** to upload a file, reuse an asset from the project, or import
from an approved source. Fill in an optional display label and caption. You can move, replace or
remove one attachment at a time. **Apply changes** updates the draft. **Save** publishes its references
and lets project readers access the bytes.

In an inventory cell, a single image opens from a small portrait. An image folder opens a gallery
with a thumbnail strip. Choose a thumbnail, use the arrow buttons or Left and Right keys to browse,
or press Home or End to jump to the first or last image. Audio and video open as lists. Select a file
to play it, and select another to switch.

In a standalone attachment group, choose an image to open its gallery at that image. Use the arrow
buttons or Left and Right keys to browse. Audio has inline native controls and one track plays at a time.
Select a video to open its native player, including sound and fullscreen. Open a GLB to orbit and
zoom, or pick and play an embedded animation. For GLB models, embed all buffers and textures and
use a model the bundled viewer can decode without fetching resources from another host. Escape or
**Close** returns focus to the opener and stops the expanded media. Generic files are downloads.

The page loads image thumbnails lazily near the viewport. Full images, videos and 3D models load
when opened. To enable thumbnails on macOS or Linux, set `HOME_HUB_WIKI_FFMPEG` for the hub service
to the absolute path of an installed FFmpeg executable. The hub renders one still PNG up to 384
pixels per side from JPEG, PNG, GIF or WebP files up to 32 MiB and 24 megapixels. An image with
an unavailable thumbnail still opens from its label.
Browser file uploads require HTTPS or localhost for SHA-256. If an upload is interrupted, choose
**Upload or resume** for the same file in the same tab. An MCP client can also ask for the current offset
and resume after losing a response. Uploads expire after 24 hours, and unreferenced assets are kept
for seven days so a draft can still be recovered.

### Playback copies and animation

When editing a GLB or video attachment, choose **Add preview file** to pair it with a lighter copy.
Use a self-contained GLB for a model or an MP4 or WebM for a video. **Download original** always
opens the original attachment. For a GLB, optionally enter the exact name of its **Initial animation**.
The viewer selects that available animation, an Idle animation if present, or the first available one.

For videos, the player tries the paired copy first and then the original. When the browser cannot play
an MP4, the hub can prepare a 960×540-or-smaller WebM with VP8 video and Opus audio. The hub uses
`HOME_HUB_WIKI_FFMPEG` with a build that includes the `libvpx` and `libopus` encoders. It processes
one MP4 at a time, queues up to two other files, and limits the source to 64 MiB, conversion to
20 seconds, and output to 16 MiB.
For longer or larger videos, attach a compatible playback copy. If playback fails, download the original.

`displayAssetId` and `initialClip` are optional on attachment references and on `wiki_attachment_add`.
Both assets must be available to the author in the destination project. A saved page publishes both
references. `initialClip` is available for GLB attachments and accepts up to 200 characters.

Original bytes, image thumbnails, and `?preview=webm` are served after authorizing the original
asset. Each published representation has a private cache entry that must revalidate, with
`If-None-Match` returning `304` when the current representation matches. Drafts use `no-store`.
The originals and WebM previews accept a single byte range. `If-Range` must match the current
strong ETag for a partial response.

## Source imports

Open **Wiki import sources** as an administrator to approve a Git LFS connection and repository
for this project. If the Git host uses a different HTTPS download origin, enter that exact origin
when approving the repository. The grant applies to the configured Git host. Grant access again
if the connection moves to another host. Review sets are available within their own project.
An administrator can grant a Review set to a different destination project by set ID.

Choose **Import from a source** when adding an attachment. For LFS, choose the repository and enter
a branch, tag or commit and the file's repository path. For Review, pick the round, item, variant
and media file. The hub verifies and keeps its own copy and provenance. All project readers can see
the copy once the page is saved. An upstream change, unavailable source or revoked grant leaves
existing saved copies playable. Choose **Replace file** to bring in a newer revision.

### Versioned Git LFS archives

Use `wiki_sources_list` with the granted connection and repository to find repository paths and refs
from the hub's latest catalog. Open the returned repository URL to browse an unscanned repository or
verify the exact ref and path directly on the forge.

For an individual file stored inside an LFS archive, use a checkout of the repository on your computer.
Resolve the ref to a full commit with `git rev-parse --verify '<ref>^{commit}'` and inspect the archive's
pointer with `git show '<commit>:<archive-path>'`. Record the 64-digit SHA-256 after `oid sha256:`.
Fetch and check out the LFS archive at that commit. Verify its downloaded SHA-256 against the pointer,
list the archive entries and extract only the selected member to a file. Hash the original extracted
member before making a preview or other derived version.

Include `archiveMember:{connection,repo,commit,archivePath,archiveOid,memberPath,originalDigest}` in the
member's entry in `wiki_upload_manifest`. Use the actual upload's size and digest in the outer entry.
For an unchanged member, the upload digest equals the original digest. For a derived preview, the
original digest identifies the input and the upload digest identifies the preview. The asset records
this source as `kind:"lfs-member"` with `verification:"author-reported"`. The hub verifies the uploaded
bytes against the upload digest. The author's supplied archive metadata records the extraction lineage.

### Review choices and captions

Call `wiki_sources_list` with `project` to find authorized sets, add `set` to list its rounds, and add
`round` to list media with its import arguments. Filter by item and variant to find specific media.
Discovery and the import receipt include the set, numbered round and notes, item and variant titles,
the recorded decision and note, and the selected variant's role and status. A reference is comparison
material and can represent the production baseline or an earlier version. An item-wide rejection
applies to its candidates. The reference keeps its comparison role, and an undecided candidate stays
pending. A decision with `scope:"unset"` indicates that no feedback has been saved.

Copy or edit the receipt's `captionSuggestion` when adding the attachment. The caption is published
with the page and is editable independently of Review. The pinned source in the asset metadata records
the exact Review file that was copied. Use `wiki_assets_list` with its digest or `sourceKind:"review"` to
find an existing copy before importing it again.

## Document format

The [HTTP API](API.md#project-wiki) accepts a structured JSON document with `v:1` and a `blocks` array.
Each block uses one of these shapes.

| Block | Fields |
|---|---|
| Paragraph or quote | `{t:"p"\|"quote", c:[inline]}` |
| Heading | `{t:"h", level:1\|2\|3, c:[inline]}` |
| List | `{t:"ul"\|"ol", items:[[inline]]}` |
| Code | `{t:"code", text}` |
| Divider | `{t:"hr"}` |
| Table | `{t:"table", header:boolean, rows:[[[inline]]]}`, where rows have the same number of cells |
| Inventory | `{t:"inventory", id, columns:[{id,label}], rows:[{id,cells:{[columnId]:{c?,stats?,attachments?}}}]}` |
| Attachment group | `{t:"attachments", id, attachments:[{assetId,label?,caption?,displayAssetId?,initialClip?}]}` |
| HTML | `{t:"html", id, label, height, source}`, where the id is `h` and eight lowercase base32 characters, unique within the page |

Inline runs are `{t:"text", text, m?:["b"|"i"|"s"|"code"]}`, `{t:"link", href, c:[text run]}` or
`{t:"ticket", id}`. Hyperlinks use HTTP or HTTPS. The ticket id must exist in the page's project.

A document may be up to 256 KiB of JSON with 1,000 blocks, of which up to 10 may be HTML blocks.
Tables accept up to 100 rows, 20 columns and 2,000 characters per cell. An HTML block accepts
up to 64 KiB of source, a label of 1–120 characters, and a height of 80–2,000 pixels.


Inventory and attachment block IDs are unique within a page. Column and row IDs are unique within
their table and remain the same when reordered. Each is a lowercase letter followed by up to 39
lowercase letters, digits or hyphens. Omit an empty cell or use an empty object. `c` uses the same
inline runs as an ordinary table cell. `stats` is an array of `{name,value,unit?}` with a string or
number as its value. Attachment and stat arrays hold up to 50 entries each. Column labels, stat names,
units and attachment labels hold up to 120 characters. Captions hold up to 1,000 characters.

This version 1 document has one inventory row and an attachment group:

```json
{
  "v": 1,
  "blocks": [
    {
      "t": "inventory",
      "id": "units",
      "columns": [
        {"id": "unit", "label": "Unit"},
        {"id": "stats", "label": "Stats"}
      ],
      "rows": [
        {
          "id": "scout",
          "cells": {
            "unit": {"c": [{"t": "text", "text": "Scout", "m": ["b"]}]},
            "stats": {"stats": [{"name": "Speed", "value": 7, "unit": "m/s"}]}
          }
        }
      ]
    },
    {"t": "attachments", "id": "downloads", "attachments": []}
  ]
}
```

## Author through MCP

1. Call `wiki_setup` with the project ID. Create a child with `wiki_page_create` and a request ID,
   using Home as the default parent.
2. Save the document with `wiki_page_save` and the page's revision. For a document above the 64 KiB
   request limit, stage its UTF-8 bytes via `wiki_upload_begin` with `purpose:"document"`,
   `wiki_upload_chunk` and `wiki_upload_finish`. Save with the returned `documentUploadId`.
3. For local files, call `wiki_upload_manifest` with a list of filenames, byte sizes and lowercase
   SHA-256 digests. Reuse entries with an asset ID. For new and resumable entries, send bytes starting
   at `nextOffset` and call `wiki_upload_finish`. If a response goes missing, submit the same manifest
   to recover the current session IDs and offsets. Retry deferred entries as prior uploads finish.
   For approved Git LFS or Review media, use `wiki_asset_import` to get the pinned asset ID.
4. Call `wiki_attachment_add` with the asset ID, expected page revision and a request ID. Use
   `groupId:"downloads"` for the standalone group above, or `tableId:"units", rowId:"scout",
   columnId:"unit"` for its cell. Use the returned revision for the next edit.
5. Call `wiki_get` with `mode:"inventory"`, `tableId` and optional `rowIds` and `columnIds` to verify
   only the relevant cells. Use `mode:"summary"` to find IDs and `mode:"assets"` to page through
   referenced metadata. Retry a create or attachment with the same request ID and unchanged arguments
   if its response is lost.

See [the API reference](API.md#project-wiki) for tool inputs, errors and raw uploads.

### Fast local transfer

Use the manifest's HTTP transport with the same authenticated principal as MCP. Send
`application/octet-stream` with PUT to `/api/wiki/uploads/<uploadId>?offset=<nextOffset>`.
Each body can hold up to 8 MiB. Slice the local file at the returned offset and continue with each
response's `nextOffset`. After an interruption, recover the offset with `wiki_upload_status` or
resubmit the manifest after the in-flight transfer has settled. Call `wiki_upload_finish` after
the last chunk to verify size, digest and the file's preview format. MCP-only clients can send
up to 32 KiB of bytes in each base64 `wiki_upload_chunk` call.

### Patch one inventory cell

Use the revision returned by a selective read. For example, pass this to `wiki_page_save` to replace
the `stats` cell of the `scout` row.

```json
{
  "project": "example-game",
  "pageId": "wabcdefghijk",
  "rev": 4,
  "patch": {
    "tableId": "units",
    "rowId": "scout",
    "cells": {
      "stats": {"stats": [{"name": "Speed", "value": 8, "unit": "m/s"}]}
    }
  }
}
```

Include several columns in the same patch to update a row, or set a cell to null to remove it.
The response includes the new revision and saved cells. If the revision is stale, read the relevant
cells again and reapply the intended edit against the current revision.

## References

Type `@` and part of a label or ID in a paragraph or rich inventory cell, then select a result with
the arrow keys and Enter. Ticket descriptions and comments offer the same picker. Select plain text
and choose **Make reference** to name a Custom record and optionally describe it. The new record belongs
to the current project by default. Save the page or ticket to publish its mention. **Settings → References** lists records by type and scope. Open a
record to read its description and incoming uses. A project author with References write access can
share a local record globally. Its ID and existing mentions stay the same.

Inside any inline-run array, use `{t:"ref",kind,id,label}` for a machine, model, project, Custom record
or wiki page. The label is a fallback. For wiki pages use the stable composite ID `project/pageId`.
Ticket links keep their existing `{t:"ticket",id}` run. A page summary exposes unique typed targets
in the optional `links.refs` array and ticket IDs in `links.tickets`. A mention opens the source. On a
page, ticket or project, expand **References and where used** to read incoming links and their excerpts.
Model documentation and minimal machine details are available to signed-in readers and agents.
