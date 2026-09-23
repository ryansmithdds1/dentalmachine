// Reads the few DICOM header fields needed to file an image: patient ID/name, study date, modality.
// Handles Part 10 files with explicit or implicit VR little endian datasets (what dental sensors and
// pans export); pixel data is never decoded.
const LONG_VR = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);
const WANT = { '00100020': 'patientId', '00100010': 'patientName', '00080020': 'studyDate', '00080060': 'modality', '00180015': 'bodyPart' };

export function isDicom(buf) {
  return buf.length > 132 && buf.toString('latin1', 128, 132) === 'DICM';
}

export function readDicomTags(buf) {
  if (!isDicom(buf)) return null;
  const out = {};
  let pos = 132;
  let explicit = true;
  const text = (start, len) => buf.toString('latin1', start, start + len).replace(/\0/g, '').trim();
  while (pos + 8 <= buf.length) {
    const group = buf.readUInt16LE(pos);
    const element = buf.readUInt16LE(pos + 2);
    const tag = group.toString(16).padStart(4, '0') + element.toString(16).padStart(4, '0');
    if (group > 0x0018 && group !== 0xfffe) break; // everything we need comes before these groups
    const isMeta = group === 0x0002;
    let vr = null;
    let len;
    let header;
    if (isMeta || explicit) {
      vr = buf.toString('latin1', pos + 4, pos + 6);
      if (LONG_VR.has(vr)) {
        len = buf.readUInt32LE(pos + 8);
        header = 12;
      } else {
        len = buf.readUInt16LE(pos + 6);
        header = 8;
      }
    } else {
      len = buf.readUInt32LE(pos + 4);
      header = 8;
    }
    const valueStart = pos + header;
    if (len === 0xffffffff) {
      // Undefined-length sequence: skip to its delimiter (FFFE,E0DD).
      const delim = buf.indexOf(Buffer.from([0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0]), valueStart);
      if (delim < 0) break;
      pos = delim + 8;
      continue;
    }
    if (tag === '00020010') explicit = text(valueStart, len) !== '1.2.840.10008.1.2';
    if (WANT[tag]) out[WANT[tag]] = text(valueStart, len);
    pos = valueStart + len;
  }
  if (out.studyDate && /^\d{8}$/.test(out.studyDate)) out.studyDate = `${out.studyDate.slice(0, 4)}-${out.studyDate.slice(4, 6)}-${out.studyDate.slice(6, 8)}`;
  if (out.patientName) out.patientName = out.patientName.replace(/\^+/g, ' ').trim();
  return out;
}

// Builds a minimal DICOM file (explicit VR little endian). Used by tests and the bridge's self-check.
export function buildDicom({ patientId, patientName = 'TEST^PATIENT', studyDate = '20260101', modality = 'IO', pixels = Buffer.alloc(16), image = null }) {
  const el = (group, element, vr, value) => {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value).length % 2 ? `${value} ` : String(value), 'latin1');
    const long = LONG_VR.has(vr);
    const head = Buffer.alloc(long ? 12 : 8);
    head.writeUInt16LE(group, 0);
    head.writeUInt16LE(element, 2);
    head.write(vr, 4, 'latin1');
    if (long) head.writeUInt32LE(data.length, 8);
    else head.writeUInt16LE(data.length, 6);
    return Buffer.concat([head, data]);
  };
  const meta = [el(0x0002, 0x0010, 'UI', '1.2.840.10008.1.2.1\0')];
  const groupLen = el(0x0002, 0x0000, 'UL', (() => { const b = Buffer.alloc(4); b.writeUInt32LE(Buffer.concat(meta).length); return b; })());
  return Buffer.concat([
    Buffer.alloc(128), Buffer.from('DICM'), groupLen, ...meta,
    el(0x0008, 0x0020, 'DA', studyDate), el(0x0008, 0x0060, 'CS', modality),
    el(0x0010, 0x0010, 'PN', patientName), el(0x0010, 0x0020, 'LO', patientId),
    ...(image ? imageElements(el, image) : []),
    el(0x7fe0, 0x0010, 'OW', pixels),
  ]);
}

// Test images: size, bit depth, spacing, photometric, and an undefined-length sequence to skip over.
function imageElements(el, { rows, columns, bits = 16, spacing = null, photometric = 'MONOCHROME2', window = null }) {
  const us = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const seq = Buffer.alloc(12 + 8 + 8 + 8);
  seq.writeUInt16LE(0x0040, 0); seq.writeUInt16LE(0x0275, 2); seq.write('SQ', 4, 'latin1'); seq.writeUInt32LE(0xffffffff, 8);
  seq.writeUInt16LE(0xfffe, 12); seq.writeUInt16LE(0xe000, 14); seq.writeUInt32LE(0xffffffff, 16); // item, undefined length
  seq.writeUInt16LE(0xfffe, 20); seq.writeUInt16LE(0xe00d, 22); seq.writeUInt32LE(0, 24); // item end
  seq.writeUInt16LE(0xfffe, 28); seq.writeUInt16LE(0xe0dd, 30); seq.writeUInt32LE(0, 32); // sequence end
  return [
    el(0x0018, 0x0015, 'CS', 'TOOTH'), ...(spacing ? [el(0x0018, 0x1164, 'DS', `${spacing}\\${spacing}`)] : []),
    el(0x0028, 0x0002, 'US', us(1)), el(0x0028, 0x0004, 'CS', photometric), el(0x0028, 0x0010, 'US', us(rows)), el(0x0028, 0x0011, 'US', us(columns)),
    el(0x0028, 0x0100, 'US', us(bits)), el(0x0028, 0x0101, 'US', us(bits === 16 ? 12 : 8)), el(0x0028, 0x0103, 'US', us(0)),
    ...(window ? [el(0x0028, 0x1050, 'DS', String(window[0])), el(0x0028, 0x1051, 'DS', String(window[1]))] : []),
    seq,
  ];
}
