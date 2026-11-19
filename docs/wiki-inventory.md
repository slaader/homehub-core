# Project wiki hierarchy, inventory tables and attachments

**Feature specification.** See [Project wiki](wiki.md) for the implemented workflow and format. A project author can document a collection on child pages, attach media to an entry, and publish the same content from an MCP client. Existing wikis already have stable page IDs, revision checks, rich-text tables and project ticket links. This proposal extends that contract. See [Wiki](wiki.md), [Reviews](review.md) and [Git LFS](git-lfs.md).

## Author experience

Under Home, create **Game inventory**. Add **Units**, **Buildings** and **Neutral enemies** as its children. The parent can contain its own introduction and shows links to its children. The page tree, breadcrumb and **New child page** action make the hierarchy navigable. **Move page** changes a page's parent and moves its subtree with it. Home stays at the root. Keep siblings alphabetically ordered. Store parent IDs and preserve page IDs, URLs and ticket backlinks across moves and renames. Reject cycles, missing parents and cross-project moves in the same transaction as the move, including concurrent opposing moves.

On Units, insert an inventory table. One example row looks like this:

| Unit | Description | Stats | Voices | 3D preview | Gameplay |
|---|---|---|---|---|---|
| Scout and two screenshots | Fast reconnaissance unit, linked to its implementation ticket | Health 80, speed 7 m/s | Selected.wav, Move.wav | Scout.glb with idle and run animations | Attack.mp4 with sound and impact effects |

Authors choose and reorder columns. Support rich text with ticket links, stats as ordered name/value/optional-unit entries, and ordered attachment groups. A cell may combine a name or caption with its media. Each category can use its own columns. Existing prose and ordinary tables continue to render and edit as before. This first version is a documentation catalog. Game-engine export and cross-project stat queries are outside its scope.

## Media behavior

Attachment groups work as standalone wiki blocks and inside inventory cells. Writers can upload, label, caption, reorder, replace or remove individual attachments. The same asset may appear in multiple groups.

| Asset | On the page | Expanded behavior |
|---|---|---|
| Images and in-game screenshots | Thumbnails with accessible labels | Open at the clicked image. Arrows, Left/Right keys and an image count navigate pictures in this group only. |
| Voices and other supported audio | Labeled inline play, pause, seek and volume controls, including WAV | Starting another track stops the previous one. |
| Interactive animated GLB | Poster or model button | Load on open. Drag to orbit, zoom, choose an embedded animation and play or pause. Provide accessible controls and a download fallback. |
| Gameplay or pre-rendered animation | Poster or video button | Open a larger native player with seeking, fullscreen and the recorded SFX. Support the MP4/WebM formats used in Reviews. |
| Other files | Filename, label, size and download action | Serve as downloads. |

Dialogs have a title and close button, contain keyboard focus, support Escape, restore focus to the opener and preserve page scroll. Close or leave the page to stop playback and release the active model. Loading a table fetches metadata and visible thumbnails. Full models and clips load on demand. An unavailable preview keeps the rest of the row usable.

## Storage, authorization and upgrades

Store a project asset record with a stable asset ID, media type, byte size, digest and optional source provenance. Store ordered references and presentation labels in page documents. Keep binary payloads in the instance data directory outside Git and outside page JSON. Reuse Review's validated chunk ingestion, content addressing, byte-range streaming and existing GLB viewer where applicable. Keep Review comparison, comments and approvals in Reviews.

A wiki writer can upload to its project. Resolve downloads, previews and range requests through authorized asset references. A raw digest gives no authority to read, attach or discover another project's asset. Verify size, digest and supported preview signatures before publishing. Reuse existing upload size and disk-budget policies where applicable, enforce limits while streaming, and expire abandoned upload sessions. Serve unrecognized or active file formats as attachment downloads. Preserve the wiki HTML sandbox.

Save a page's document, asset references, ticket backlinks and revision atomically. Removing one reference preserves all others, including Review references if payloads are shared. A stale save returns a conflict with the current revision and preserves the author's draft. Delay cleanup of unreferenced assets long enough for draft recovery; coordinate deletion with in-flight saves. Backups cover metadata and payloads together.

Ship as a minor release with a data epoch change. On upgrade, place existing non-Home pages directly under Home, retaining IDs, content, revisions and links. Keep legacy documents readable. Keep current page/table size limits initially and return actionable limit errors. Validate restore against an actual pre-upgrade fixture.

## Git LFS and Review sources

**Import from LFS when the author chooses an existing repository asset.** Reuse Hub's configured Git connections and pointer discovery. Add a server-side download/import path. Resolve a repository, ref and path to a commit and LFS pointer, stream the object, and verify the pointer's SHA-256 and size. Record repository, commit, path and object ID. Keep a verified local copy for playback and backup; reuse identical bytes when available. A later branch update or unavailable Git host leaves the published wiki playable. Replacing an attachment with a newer revision is explicit.

An administrator must authorize a source repository for import into the destination project. Make the resulting audience clear before import: project readers will be able to view the copied asset. Catalog visibility alone does not grant import rights. Keep credentials and temporary provider download URLs server-side. Missing objects, denied access, digest mismatches or budget failures leave the page unchanged. Direct upload works without a Git connection. Apply the same source-access and destination-write checks to **Use from Review**, pinning a selected variant's bytes and retaining its provenance.

## MCP authoring contract

Expose the same validation and transactions to the UI and MCP. The [API reference](API.md#mcp-wiki-authoring) lists the tool arguments. Return stable IDs, the resulting revision for mutations, and a navigable page URL. Filter tool discovery and execution using existing tracker read/write scopes and principal permissions. Source imports also require source authorization.

| Tool | Inputs and effect |
|---|---|
| wiki_list / wiki_get | Read a project's tree or a page with its revision, document, table/row/column IDs and attachment metadata. |
| wiki_setup | Enable a project wiki idempotently and return Home. |
| wiki_page_create | Create under parentId, defaulting to Home. Return pageId and rev. |
| wiki_page_move | Set parentId with expected page rev. Validate the current tree atomically. |
| wiki_page_save | Rename or edit content using expected rev. Supports creating tables, editing stats, linking tickets and ordering rows, columns and attachment groups. |
| wiki_upload_begin / wiki_upload_chunk / wiki_upload_finish | A client supplies project, filename, size and digest. Return an expiring session, permitted chunk size and next offset. Accept bounded base64 chunks over MCP. Identical chunk retries are safe. Finish verifies bytes and returns assetId. |
| wiki_asset_import | Accept an authorized Git LFS repo/ref/path or Review variant ID and return project assetId plus resolved provenance. |
| wiki_attachment_add | Attach assetId to a page group or specific table/row/column with label, caption, position and expected page rev. Return updated page rev. |

Require retry-safe request IDs for creates and attachment additions. Return structured errors for stale revisions, invalid targets, denied access, expired uploads and size limits. A client may also use authenticated raw chunk uploads for throughput. The entire authoring flow must work through MCP alone, including local media when LFS and Reviews are absent. Clients supply file bytes; the Hub server never resolves a caller-supplied local filesystem path.

## Delivery and acceptance

1. **Hierarchy and migration.** Upgrade a populated flat wiki, create the example tree via MCP, then move and rename a populated subtree in the UI. Verify old URLs, content, ticket backlinks and stale-revision handling. Exercise concurrent cycle attempts.
2. **One complete row.** From an MCP client, create Units, add the Scout row, upload pictures, two WAV voices, an animated GLB, a gameplay clip with sound and a generic file. Attach, reorder and read them back. Open the same saved page in a browser and exercise each control above. Edit it in the UI and verify the new revision via MCP.
3. **Durability and permissions.** Interrupt and resume an upload, retry a successful attach after losing its response, and race two writers. Verify a viewer can play but cannot mutate. Test unauthorized asset references, range requests, shared references, backup/restore and byte-for-byte download integrity.
4. **Source imports and scale.** Import a pinned LFS screenshot and Review variant. Change the upstream revision and take the source offline. Verify the published page still shows the chosen bytes. Exercise a 100-row table and confirm opening the page does not fetch full videos or instantiate GLB viewers. Run the repository's large-change verification before release.
