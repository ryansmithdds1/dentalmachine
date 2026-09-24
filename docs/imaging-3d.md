# CBCT and 3D scans

Staff open a patient's CBCT or intraoral scan from their documents and read it in the browser. They
don't need a separate imaging workstation for everyday reads.

- **CBCT viewer**: shows axial, coronal and sagittal slices side by side, with linked crosshairs. You
  can scroll, use the arrow keys or Page Up/Down to move through slices. It has window/level presets
  (Auto, Bone, Teeth, Soft tissue, Airway), and you can also drag to set window/level (the W/L tool or
  a right-drag). You can zoom, pan and invert. Measurements are in mm, taken from the DICOM voxel
  spacing. The fourth pane shows either a 3D rendering or a panoramic reconstruction. The 3D rendering
  can be a surface at a chosen density, a lit volume, or a MIP. For the panoramic reconstruction you
  click along the arch on the axial view, and you can set the slab thickness.
- **Scan viewer** (.stl, .ply, .obj): lets you orbit, zoom and pan the model. You can switch the upper
  and lower jaws on and off, and a slider opens the bite. There are preset views (front, sides, each
  occlusal), a wireframe, and the scanner's own colours when the file has them. You can measure the
  distance in mm between two points on the surface.
- **Snapshot** (needs `clinical:write`): saves a PNG of the current view as a new document. The PNG
  goes into the patient's chart and includes any measurements on screen. The source file is never
  changed.

Measurements on screen aren't saved. Take a snapshot to keep them.

## How it's stored

A CBCT series is stored as **one document**: the uploaded zip, encrypted by `storage` like every other
file. This follows the rule of using the existing model. There is no new table, and the manifest is
derived from the file. `server/src/volume.js` reads the series:

- **Zip reading**: reads the zip's central directory. Entries are unpacked one at a time, and each one
  is checked against its declared size. There are caps on the number of entries, the size of each
  entry and the total unpacked size (so a zip bomb is refused). Zip64 archives and password-protected
  zips are refused with a plain message.
- **Slice geometry**: uses dicomimage.js's `parseDicom` for the pixels, and a geometry walker for
  ImagePositionPatient, ImageOrientationPatient, spacing, rescale and series UID. The walker also looks
  inside sequences, so enhanced multi-frame CT works too.
- **Slice order**: slices are ordered along the slice normal, not by file name or instance number.
  Instance number is only a fallback, and the viewer shows a warning when it's used.
- **Series and duplicates**: when a zip holds more than one series, the largest one is used. Duplicate
  positions are dropped. Uneven gaps between slices are flagged.
- **Patient check**: slices from more than one patient are refused (422).
- **Compression**: compressed transfer syntaxes (JPEG, JPEG 2000) are refused, with a message asking
  the user to export the series uncompressed.
- **Manifest**: the result is a small manifest. It holds the dimensions, the voxel spacing in mm
  (x = column spacing, y = row spacing, z = the median slice gap), the orientation, the units (HU when
  the files carry a rescale), the slice order and any warnings.

Scans are served as stored. The format is found from the bytes: the exact size for binary STL,
`solid…facet` for ASCII STL, the `ply` header, and the `.obj` name plus its text. A zip of scans
(`UpperJaw.stl` and `LowerJaw.stl`) is split into parts, and each part gets a jaw label taken from its
name.

## API (`server/src/routes/volumes.js`)

All routes are practice-scoped (`findOr404`), return 404 for removed documents, and need `clinical:read`.
Opening a volume or a mesh writes `document.view` to the audit log, with `{ view: 'volume' | 'mesh' }`.

| Route | Returns |
|---|---|
| `GET /documents/:id/view3d` | `{ kind: 'volume', dims, spacing, slices, warnings, … }` or `{ kind: 'mesh', parts: [{ index, name, format, jaw, size }] }` |
| `GET /documents/:id/volume/info` | the manifest summary |
| `GET /documents/:id/volume?max=512` | the volume in binary: `"DMVOL1\0\0"`, a uint32 data offset, a JSON header, then Int16 LE voxels (x fastest). The values are rescaled, so they are HU for CT. The volume is box-averaged down so that its largest side is at most `max`, and the header's `spacing` grows to match. The body is gzipped when the client accepts gzip. |
| `GET /documents/:id/mesh?part=0` | the scan file's bytes, with `X-Mesh-Format: stl \| ply \| obj` |
| `POST /documents/:id/snapshot?view=…` | body is a PNG (at most 8 MB). Creates a new document with category `xray` for a CBCT or `photo` for a scan, and audits `document.snapshot`. Needs `clinical:write`. |

Decoding is limited to two volumes at a time per server. It also yields between slabs so that other
requests keep moving.

## Client (`client/src/components/volume/`)

- `index.jsx` goes in the main bundle and is about 2 kB. It holds `Viewer3D`, `is3dDoc` and
  `zipFolder`. `Viewer3D` asks `/view3d` what the document is, then lazy-loads the matching viewer.
- `VolumeViewer.jsx`, `mpr.js` and `volren.js` make up the CBCT chunk: **35 kB (14 kB gzip)**. Slices
  are drawn on a 2D canvas through a 64K-entry window/level lookup table. The 3D view is a focused
  WebGL2 ray-marcher over one 8-bit 3D texture, with three modes: surface, lit volume and MIP.
- `MeshViewer.jsx` is the scan chunk: **548 kB (140 kB gzip)**, almost all of it three.js. It uses
  three.js loaders for STL, PLY and OBJ, OrbitControls, and a room environment with a key light that
  follows the camera. It welds STL vertices so the teeth are smoothly shaded, and it renders only when
  something changes.

**Why no cornerstone3D or vtk.js:** both toolkits run to megabytes and use web workers or WASM codecs
that need extra Vite setup. We only need uncompressed DICOM, because the server decodes it, and three
reslices plus a ray-marcher. Doing that ourselves costs about 1,000 lines and a 14 kB gzip chunk.

## Wiring it in (for the owners of app.js, documents.js and DocumentsTab.jsx)

1. **app.js**: add `import volumeRoutes from './routes/volumes.js';`, then
   `api.use(volumeRoutes({ db, storage }));` next to `documentRoutes`.
2. **documents.js upload**:
   - Add `import { sniffScanMime, inspectUpload } from '../volume.js';`.
   - Set `const mime = sniffMime(req.body, filename) || sniffScanMime(req.body, filename) || (declared === 'text/plain' ? declared : null);`.
   - Extend `ALLOWED` with `|application\/zip|model\/(stl|ply|obj)`.
   - When `mime === 'application/zip' || mime.startsWith('model/')`, call `inspectUpload(req.body, filename)`. It throws 415 (or 422 for mixed patients) for a zip that isn't a CBCT or a scan. When the query gave no category, use its `category`.
   - Upload limit: CBCT zips are 50–500 MB, so give `.zip` uploads a larger `express.raw` limit (for example 1 GB) and keep 25 MB for everything else. Check that the reverse proxy allows it.
   - Optional: add `documents.volume_manifest TEXT` to `COLUMNS` and save `JSON.stringify(inspect.manifest)` there. The routes use it when it's present. Otherwise they compute the manifest once and cache it in memory.
3. **DocumentsTab.jsx**:
   - When `is3dDoc(doc)`, open `<Viewer3D documentId={doc.id} canEdit={canWrite} onClose={close} onSaved={reload} height="78vh" />` in place of ImageViewer.
   - A multi-frame DICOM CBCT can be opened the same way through an "Open in 3D" action.
   - To upload a folder, add `<input type="file" webkitdirectory>` and upload `await zipFolder(files)` as `<folder>.zip`.
4. **Tests**: `server/test/volumes.test.js` covers series reading and the routes. After the wiring,
   `e2e/workflows/cbct.test.mjs` runs end to end. Until then it skips.
