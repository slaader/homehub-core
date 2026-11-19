# Project wiki

Open a project in **Projects** and choose **Set up wiki**. Setup opens **Home** for editing. On later
visits, choose **Wiki** in the project toolbar and select a page from **Pages**. Anyone with read access
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
Choose **Attachment group** to insert the same media controls outside a table.

In either group choose **Add attachment** to upload a file, reuse an asset from the project, or import
from an approved source. Fill in an optional display label and caption. You can move, replace or
remove one attachment at a time. **Apply changes** updates the draft. **Save** publishes its references
and lets project readers access the bytes.

Choose an image to open its group at that image. Use the arrow buttons or Left and Right keys to
browse images in that group. Audio has inline native controls and only one track plays at a time.
Select a video to open its native player, including sound and fullscreen. Open a GLB to orbit and
zoom, or pick and play an embedded animation. For GLB models, embed all buffers and textures and
use a model the bundled viewer can decode without fetching resources from another host. Escape or
**Close** returns focus to the opener and stops the expanded media. Generic files are downloads.

The page loads image thumbnails lazily near the viewport. Full videos and 3D models load when opened.
Browser file uploads require HTTPS or localhost for SHA-256. If an upload is interrupted, choose
**Upload or resume** for the same file in the same tab. An MCP client can also ask for the current offset
and resume after losing a response. Uploads expire after 24 hours, and unreferenced assets are kept
for seven days so a draft can still be recovered.

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
| Attachment group | `{t:"attachments", id, attachments:[{assetId,label?,caption?}]}` |
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
3. For each local file, call `wiki_upload_begin` with its name, size and digest. Send base64 chunks of
   up to 32 KiB and call `wiki_upload_finish` for the asset ID. For approved Git LFS or Review media,
   use `wiki_asset_import` to get the pinned asset ID.
4. Call `wiki_attachment_add` with the asset ID, expected page revision and a request ID. Use
   `groupId:"downloads"` for the standalone group above, or `tableId:"units", rowId:"scout",
   columnId:"unit"` for its cell. Use the returned revision for the next edit.
5. Call `wiki_get` to confirm the stored order, read the asset metadata or open the page URL. Retry a
   create or attachment with the same request ID and unchanged arguments if its response is lost.

See [the API reference](API.md#project-wiki) for tool inputs, errors and raw uploads.
