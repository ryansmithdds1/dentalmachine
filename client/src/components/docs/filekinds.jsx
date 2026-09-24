import { File, FileText, FileSpreadsheet, FileAudio, FileVideo, FileImage, Presentation, Box, ScanLine } from 'lucide-react';

// What each kind of document is called on screen (matches server/src/ocr.js).
export const CATEGORY_LABELS = {
  xray: 'X-ray', photo: 'Photo', document: 'Document', consent: 'Consent', insurance_card: 'Insurance card', referral: 'Referral', eob: 'EOB',
  lab_rx: 'Lab Rx', id_card: 'ID', xray_report: 'Imaging report', medical_history: 'Medical history', correspondence: 'Letter', other: 'Other',
  contract: 'Contract', license: 'Licence / permit', policy: 'Policy', invoice: 'Invoice', certificate: 'Certificate', hr: 'HR / staff',
};
export const PATIENT_CATEGORIES = ['xray', 'photo', 'document', 'consent', 'insurance_card', 'referral', 'eob', 'lab_rx', 'id_card', 'xray_report', 'medical_history', 'correspondence', 'other'];
export const OFFICE_CATEGORIES = ['document', 'contract', 'license', 'policy', 'invoice', 'certificate', 'hr', 'correspondence', 'other'];
export const catLabel = (c) => CATEGORY_LABELS[c] || String(c || '').replace(/_/g, ' ');

// Everything the chart takes (the server checks the contents; this only helps the file picker).
export const ACCEPT = 'image/*,application/pdf,.pdf,.dcm,.zip,.stl,.ply,.obj,.heic,.heif,.tif,.tiff,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.rtf,.csv,.txt,audio/*,video/*,.m4a,.mp3,.wav,.mp4,.mov,.webm';

const OFFICE = /officedocument|msword|ms-excel|ms-powerpoint/;
// How a document is shown: → image | pdf | tiff | heic | dicom | mesh | volume | text | csv | office | audio | video | file
export function kindOf(doc) {
  const m = doc?.mime || '';
  if (/^image\/(png|jpeg|gif|webp|bmp)$/.test(m)) return 'image';
  if (m === 'image/tiff') return 'tiff';
  if (m === 'image/heic' || m === 'image/heif') return 'heic';
  if (m === 'application/pdf') return 'pdf';
  if (m === 'application/dicom') return 'dicom';
  if (m === 'application/zip') return 'volume';
  if (/^model\//.test(m) || (m === 'text/plain' && /\.(stl|ply|obj)$/i.test(doc.filename || ''))) return 'mesh';
  if (m === 'text/csv') return 'csv';
  if (m === 'text/plain' || m === 'application/rtf') return 'text';
  if (OFFICE.test(m)) return 'office';
  if (/^audio\//.test(m)) return 'audio';
  if (/^video\//.test(m)) return 'video';
  return 'file';
}
export function KindIcon({ doc, size = 28 }) {
  const k = kindOf(doc);
  const m = doc?.mime || '';
  const Icon = k === 'pdf' || k === 'text' ? FileText
    : k === 'office' ? (/sheet|excel/.test(m) ? FileSpreadsheet : /presentation|powerpoint/.test(m) ? Presentation : FileText)
      : k === 'csv' ? FileSpreadsheet : k === 'audio' ? FileAudio : k === 'video' ? FileVideo
        : k === 'mesh' || k === 'volume' ? Box : k === 'tiff' || k === 'heic' || k === 'image' ? FileImage : k === 'dicom' ? ScanLine : File;
  return <Icon size={size} aria-hidden strokeWidth={1.6} />;
}
export const kindLabel = (doc) => ({
  image: 'Picture', tiff: 'TIFF', heic: 'iPhone photo (HEIC)', pdf: 'PDF', dicom: 'DICOM x-ray', volume: 'CBCT', mesh: '3D scan', text: 'Text',
  csv: 'Spreadsheet (CSV)', office: /sheet|excel/.test(doc?.mime) ? 'Excel' : /presentation|powerpoint/.test(doc?.mime) ? 'PowerPoint' : 'Word', audio: 'Audio', video: 'Video', file: 'File',
})[kindOf(doc)];

export function fmtSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
