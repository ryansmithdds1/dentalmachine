# 14 · View and attach x-rays and intraoral photos

**Budget: 2 actions** to see the newest x-rays and move to the next image (X → →), with the patient's
Documents & x-rays tab open; **2 actions** to attach files (drop them: 1, nothing else needed).
Tested by `e2e/workflows/14-15-images-medical.test.mjs`.

## Trigger and who does it
The dentist or hygienist looks at radiographs during an exam or while treatment planning; an assistant or the
front desk attaches outside x-rays, intraoral photos, referral letters, consent forms and insurance cards.
Several times per patient per visit.

## Data needed
- The patient's documents (`GET /patients/:id/documents`, newest first) and mounts (`GET /patients/:id/mounts`).
- For an upload: the file, its type (x-ray, photo, document, consent, insurance card, referral, other) and an
  optional tooth. Clinical access (`clinical:read` to view, `clinical:write` to add, change or remove).

## Today (from the audit)
View 3 actions (Documents tab, click a thumbnail, arrows only inside the imaging studio); attach 4–5 (pick a
type — always defaulted to X-ray — pick a tooth, open the file chooser, choose files). No drag and drop.
Removing asked "Are you sure?" with `confirm()`. "Edit details" opened a second dialog on top of the viewer.

## Target
- **View (2):** **X** on the Documents tab opens the newest x-ray set (the latest mount that isn't a photo
  series) in the imaging studio on its first image; **← →** go through the set; **Esc** closes it straight away.
  With no mount, X opens the newest loose x-ray in the viewer, and ← → step through the patient's x-rays
  ("1 of 4" shows where you are). A **Latest x-rays** button does the same for mouse users.
- **Attach (1–2):** drop files anywhere on the tab (or paste an image with Ctrl/⌘+V, or press **U** for the file
  chooser). Each file is filed by what it is — nothing to pick.
- **Remove:** the Remove button (or **Delete** in the viewer) removes at once, with an Undo toast
  (Ctrl/⌘+Z). No confirmation, because nothing is lost: documents are only hidden (`deleted_at`).
- **Edit details** opens as a panel under the image inside the same viewer (Esc closes only the panel).

## What gets automated
- **Type from the file** (`client/src/components/imaging/category.js`): a clear word in the name wins
  (consent, insurance/card, referral, x-ray/pano/FMX/BW/PA, photo); DICOM and TIFF are x-rays; images are
  checked in the browser — grey-scale pictures are x-rays, colour pictures (camera JPEGs, screenshots) photos;
  PDFs are filed as whatever this person last changed a PDF to (remembered with `useRemembered`,
  `documents.category@pdf`, default Document). The Type select keeps "Automatic (from the file)" unless someone
  picks a fixed type, which is remembered (`documents.type`).
- Each file is sent with its own `Idempotency-Key`, so a doubled or retried upload files it once.
- The upload toast offers Undo (removes what was just added, through the normal remove route).

## Server
- `DELETE /documents/:did` — soft delete, recorded with `recorded()` (before/after of `deleted_at`) and audited
  (`document.delete`); removing twice is harmless.
- `POST /documents/:did/restore` — new: brings a removed document back, recorded and audited
  (`document.restore`). `clinical:write`; another practice's document is a 404.
- `PUT /documents/:did` (details) now records before/after too.

## Edge cases
- Files the server refuses (wrong kind, over 25 MB) show the reason in a red toast and the error box; files
  already uploaded in the same drop stay.
- A drop or paste without clinical write access does nothing (the drop zone isn't active).
- Pasting while typing in a box (search, tooth) is left to the box.
- Mounts that point at a removed image show the slot empty; a restore puts it back.
- DICOM that the viewer can't decode still opens with the download offer.
- Plain-key shortcuts don't fire while a dialog is open; X is off while the viewer or studio is open.

## Acceptance
- X then → shows the second image of the newest set in 2 actions; Esc closes the studio (`e2e`).
- Without a mount, X opens the newest x-ray ("1 of 2") and → goes to "2 of 2" in 2 actions (`e2e`).
- Dropping a camera JPEG, a grey PNG and a PDF files them as Photo, X-ray and Document in 1 action (`e2e`).
- Remove shows no dialog, the tile disappears and Ctrl/⌘+Z restores it; Edit details doesn't stack a second
  dialog (`e2e`).
- Restore/remove audit rows carry before/after; permissions and other-practice 404s
  (`server/test/imagesmedical.test.js`).

## Not done here
- An "Images" link from the schedule's appointment drawer (in `calendar/*`, another workstream).
