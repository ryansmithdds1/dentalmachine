# Documents: scanning, any file type, search, notes, office documents

Backlog D1–D5 ("Document management and scanning"). Patient documents stay in the one `documents` table
(encrypted files, soft delete, restore); office documents are the same rows with no patient.

## What staff do

| Task | How |
|---|---|
| Scan paper into the chart on screen | **S** on the Documents tab → **1** this computer's scanner (through its imaging bridge) · **2** phone/tablet (QR code) · **3** a file from this computer. Drop or paste still works anywhere on the tab; **U** opens the file picker. |
| Photograph pages with a phone | Scan the QR code, photograph each page: the page is found, straightened, evened out (colour / grey / black & white), and all pages go as **one PDF**. Corners can be dragged if the page wasn't found. |
| File a scan the way it's suggested | The document's side panel says "Looks like an EOB — it mentions an explanation of benefits (…)"; **File as EOB** is one click (recorded as the person's decision). |
| Find a document by what it says | Search box on the Documents tab (**F**) and the command bar (Ctrl/⌘K) search file names, tags, folders, notes **and the words inside** (PDF text, Word/Excel, OCR of scans and photos). |
| Notes / sticky notes | Side panel: type, **Enter**. **P** (or "Pin on page") then click the picture to pin a sticky note there. Edits keep the earlier wording (History); removing has Undo. |
| Needs review | "Ask someone to review" → it's a task on that person's to-do list; "Reviewed" closes both. |
| Belongs with | Link a document to a visit, claim or treatment plan of the same patient. |
| Office documents | `/documents` page: contracts, licences (expiry → reminder task 60 days ahead), policies, invoices; the **Scan inbox** (scans no chart was named for) with "File to" the active patient; **To review**; **Search all documents**. |

## File types (server/src/filetypes.js)

Decided from the file's bytes, never its name or the browser's type. Refused (415) whatever they're called:
programs (Windows/macOS/Linux executables, Java), shell and other scripts (`#!`, .js/.ps1/.bat/.vbs…),
web pages and SVG (markup with script), macro-enabled Office files, `.msi`-style containers.

| Kind | Types | Largest | Preview |
|---|---|---|---|
| Pictures | JPEG, PNG, GIF, WebP, BMP | 50 MB | image viewer (x-ray tools) |
| iPhone photos | HEIC/HEIF | 50 MB | shown where the browser can (Safari); otherwise download |
| TIFF (incl. multi-page) | TIFF | 100 MB | pages decoded in the browser (none, LZW, PackBits, Deflate); fax G3/G4 → download |
| PDF | PDF | 100 MB | built-in PDF viewer, page by page |
| Office | .docx .xlsx .pptx, .doc .xls .ppt | 50 MB | their words (read on the server); download to open |
| Text | .txt, .csv (as a table), .rtf | 25 MB | shown |
| Audio | MP3, M4A, WAV, OGG, WebM audio, FLAC | 200 MB | player |
| Video | MP4, MOV, WebM (AVI: download) | 500 MB | player with seeking (range requests) |
| X-rays, 3D | DICOM; CBCT zip; STL/PLY/OBJ | 100 MB / 1 GB / 200 MB | image viewer / 3D viewer (unchanged) |

`GET /api/documents/:id/file` answers `Range` requests (206/416). A `<video>` can't send the sign-in header,
so players get a 10-minute link from `POST /api/media/documents/:id/link` (see mounts); until that is mounted
the whole file is fetched once instead. Viewing is audited once per opening, not per range.

## Virus scanning (server/src/virusscan.js)

Adapter: **ClamAV** (`clamd` over TCP, INSTREAM) when `CLAMAV_HOST` is set (`CLAMAV_PORT`, default 3310);
otherwise a **sandbox** that only catches the EICAR test file. Infected → 422, the file is not stored,
`document.virus_blocked` is audited and a Needs attention item is raised. Scanner unreachable → 503 and one
Needs attention item ("uploads are paused"), resolved automatically by the next scan that works. Each scan is
in Settings → Connection activity (service "ClamAV", no file contents). `documents.virus_status`:
`clean` (ClamAV passed it) or `not_scanned` (sandbox).

## Reading text (OCR) and search (server/src/ocr.js, server/src/docsearch.js)

After an upload the text is read in the background:
1. From the file itself, nothing sent anywhere: text, CSV, RTF, Word/Excel/PowerPoint, PDFs with a text layer.
2. Scans and photos of paperwork (not x-rays/photos in a chart) go to the OCR adapter: **AI** (Claude vision
   via `ai.js`, only when `ANTHROPIC_API_KEY` is set **and** the practice hasn't switched it off —
   `PUT /api/documents/settings {document_ai}`, administrators), **sandbox** (no-op; demo/test servers,
   or `OCR=sandbox`), or **off**. An AI read is audited as `document.ai_read` with source `ai` and its
   one-line reason; its category suggestion is only a suggestion until a person accepts it.
   A failed read becomes a Needs attention item (kind AI), resolved by the next successful read.

The text is stored **encrypted in file storage** like the file (`documents.ocr_key`). The database keeps only
keyed hashes of words and their 3–6 letter beginnings (`document_terms`, HMAC with `DOCUMENT_SEARCH_KEY`,
else the document encryption key; changing it needs a re-read of the documents). Searches check candidates
against the decrypted text before showing a snippet. Searches are audited (`document.search`, result ids).
Scope: a patient's chart, or practice-wide with office access rules (patients a restricted user can't see,
other offices' office documents) — never another practice.

Documents that arrived another way (phone link, imaging bridge) are read the next time the chart's document
list is opened (last 14 days), or on "Read text now" in the side panel.

## Scanning through the imaging bridge (bridge/dental-machine-bridge.mjs 1.5.0)

```json
"scanner": { "driver": "auto" }                       // WIA on Windows, scanimage (SANE) on macOS/Linux
"scanner": { "preset": "epson" }                      // presets.json → scanPresets (Epson, Canon, Brother, HP, fi-series, SANE)
"scanner": { "driver": "command", "command": "…", "args": ["{dir}", "{dpi}", "{color}", "{source}", "{duplex}"] }
"scanFolders": [{ "preset": "scansnap" }, { "folder": "D:\\Scans\\Copier", "moveTo": "D:\\Scans\\Copier\\filed" }]
```

- The chart's **Scan now** queues a `scan` command (the same long-poll queue as "Open in DEXIS"); the bridge
  scans (feeder/glass, both sides, colour/grey/B&W, dpi), builds one PDF from the JPEG pages (no
  re-compression, page size from the dpi) or sends separate pictures, and posts it to
  `/api/bridge/scans/:id/file`; progress shows in the chart. The document is recorded as the integration
  ("Imaging bridge: Op 2"), with the person who pressed Scan as the uploader.
- **Scan folders** (ScanSnap Home, copiers' "scan to folder", a mail rule that saves attachments): files named
  `P<chart#>_…` go to that chart (only a patient of this practice); anything else goes to the **Scan inbox**
  for a person to file. Duplicate files (same SHA-256) are filed once.
- `--list-scanners` lists WIA/SANE scanners; `--check` includes the scanner.
- **Untested on real hardware:** the WIA script (`bridge/installer/scan.ps1`, also embedded in the bridge so
  install packages without it still work) was written from the WIA 2.0 automation documentation — no Windows
  machine was available. SANE source names differ by backend (`"sources"` overrides them). The "command"
  driver is what the tests use (a fake scanner).

## Data

- `documents`: `patient_id` may be NULL (office documents, scan inbox — `NULLABLE` in db.js); categories
  widened (`RELAXED`): patient `eob, lab_rx, id_card, xray_report, medical_history, correspondence`; office
  `contract, license, policy, invoice, certificate, hr`. New columns: `folder`, `appointment_id`, `claim_id`,
  `treatment_plan_id`, `ocr_*`, `suggested_category`, `suggestion_reason`, `suggestion_source`, `review_*`,
  `expires_on`, `expiry_task_id`, `virus_status`, `inbox`.
- `document_notes`: one row per version; an edit supersedes (status `superseded`), a removal is status
  `deleted`; pins carry `page`, `x`, `y` (fractions).
- `document_terms`: derived search index (rebuilt freely).
- `bridge_agents.scanner`, `scanner_info`; `practices.document_ai`.

## Permissions

Patient documents: `clinical:read` / `clinical:write` as before (plus office access). Office documents:
`officedocs:read` / `officedocs:write` — **administrators only until those two are added to
`PERMISSION_CATALOG` in server/src/auth.js** (then they can be given to an office manager). The scan inbox:
`clinical:write`. Anyone may be asked to review a document they can open.

## API (all under /api, signed in)

`GET /patients/:id/documents/search?q=` · `GET /documents/search?q=&scope=all|patients|office` ·
`GET /documents/:id/details` · `GET /documents/:id/text` · `POST /documents/:id/read` ·
`POST /documents/:id/accept-suggestion` · `POST /documents/:id/dismiss-suggestion` ·
`GET|POST /documents/:id/notes` · `PUT|DELETE /document-notes/:id` · `POST /document-notes/:id/restore` ·
`PUT /documents/:id/review {assignee_id, note}` · `POST /documents/:id/review/done` ·
`GET /documents/needs-review?mine=1` · `PUT /documents/:id/links` · `GET /documents/:id/link-options` ·
`GET /patients/:id/document-folders` · `GET|POST /office-documents` · `GET /office-documents/folders` ·
`GET /document-inbox` · `POST /document-inbox/:id/file {patient_id, category}` · `GET /scanners` ·
`POST /patients/:id/scan` · `GET /scans/:id` · `GET|PUT /documents/settings`.
Bridge (key auth): `POST /api/bridge/scanner`, `POST /api/bridge/scans/:id/file`, `POST /api/bridge/scan-inbox`.

## Mounts (outside these files)

- server/src/app.js, next to the bridge routes:
  `app.use('/api/bridge', docBridgeRoutes({ db, storage, config }));` and
  `app.use('/api/media', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, docMediaRoutes({ db, storage, secret }));`
  with `import { docBridgeRoutes, docMediaRoutes } from './routes/docbridge.js';`
- client/src/App.jsx: `const OfficeDocuments = lazy(() => import('./pages/OfficeDocuments.jsx'));`,
  `<Route path="/documents" element={<OfficeDocuments />} />`, nav
  `['/documents', FolderOpen, 'Documents', can('clinical:read') || can('officedocs:read')]`, and
  `<DocumentCommands />` beside `<IntranetCommands />` (`import DocumentCommands from './components/docs/DocumentCommands.jsx';`).
- A daily job may call `remindExpiringDocuments(db, practiceId)` (routes/docmanage.js); it also runs whenever
  the office documents list is opened.
