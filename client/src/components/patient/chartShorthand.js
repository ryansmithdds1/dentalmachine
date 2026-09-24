// Charting by typing, the way a dentist calls it out to the assistant:
//   "30 MO caries"        → caries on #30, mesial and occlusal
//   "14 D2740"            → a planned crown on #14 (any CDT code)
//   "2-4 sealant plan"    → planned sealants on #2, #3 and #4
//   "3 crown"             → an existing crown on #3 (other office)
//   "19 rct done"         → a root canal completed today
//   "1, 16, 17, 32 missing; 8 watch"
//   "14 crb bu", "np", "srp no LL", "3-5 brg" → bundles and aliases (Settings → Clinical → Chart shortcuts & bundles)
// Several entries can be separated by ";" or a new line. Primary teeth take a # ("#K O caries") so they don't
// read as surfaces.
//
// The engine itself lives in server/src/chartengine.js, because the server runs the very same code: the voice
// assistant's resolver (POST /charting/resolve) and the chart call's checks. One engine, one answer.
export {
  codeFor, parseEntry, parseShorthand, describe, resolveEntry, buildLookups, shortcutRef, shortcutText, expandBundle, bundleOptions, checkBundle,
  itemProblem, chartWarnings, isComparison, surfaceProblem, areaKind, STARTER_BUNDLES, SHORTCUT_ICONS, WORK_KINDS, FINDING_KINDS, TOOTH_RULES,
  QUADRANTS, ARCHES,
} from '../../../../server/src/chartengine.js';
