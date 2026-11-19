# Project wiki

Open a project in **Projects** and choose **Set up wiki**. Setup opens **Home** for editing. On later
visits, choose **Wiki** in the project toolbar and select a page from **Pages**. Anyone with read access
can open an enabled wiki. A person or API key with `tickets:write` can set up a wiki and save changes.

Choose **New page** to add a page. Choose **Edit** and change **Page title** to rename a page.
Links to the page use its stable id and continue to work after a rename.

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
| HTML | `{t:"html", id, label, height, source}`, where the id is `h` and eight lowercase base32 characters, unique within the page |

Inline runs are `{t:"text", text, m?:["b"|"i"|"s"|"code"]}`, `{t:"link", href, c:[text run]}` or
`{t:"ticket", id}`. Hyperlinks use HTTP or HTTPS. The ticket id must exist in the page's project.

A document may be up to 256 KiB of JSON with 1,000 blocks, of which up to 10 may be HTML blocks.
Tables accept up to 100 rows, 20 columns and 2,000 characters per cell. An HTML block accepts
up to 64 KiB of source, a label of 1–120 characters, and a height of 80–2,000 pixels.
