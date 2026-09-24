// The chart-entry engine (server/src/chartengine.js, re-exported to the browser by chartShorthand.js): aliases,
// bundles, comparisons of options, and the old chart-by-typing behaviour unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const engine = await import('../src/chartengine.js');
const { parseShorthand, resolveEntry, buildLookups, expandBundle, checkBundle, codeFor, describe, chartWarnings, itemProblem, STARTER_BUNDLES, unsealedMolars } = engine;
const bundles = STARTER_BUNDLES.map((b, i) => ({ ...checkBundle(b), id: i + 1, active: 1 }));
const lookups = buildLookups({ bundles });
const run = (text, extra = {}) => resolveEntry(text, { lookups, ...extra });
const said = (text, extra) => run(text, extra).items.map(describe);

test('the browser gets the same engine, and its tooth facts match the drawing', async () => {
  const client = await import('../../client/src/components/patient/chartShorthand.js');
  assert.equal(client.parseShorthand, parseShorthand, 'chartShorthand.js re-exports the engine');
  const teeth = await import('../../client/src/components/teeth.js');
  for (const t of [...Array.from({ length: 32 }, (_, i) => String(i + 1)), ...'ABCDEFGHIJKLMNOPQRST'.split(''), '51', '82', 'AS']) {
    assert.equal(engine.isPosterior(t), teeth.isPosterior(t), `posterior ${t}`);
    assert.equal(engine.isMolar(t), teeth.isMolar(t), `molar ${t}`);
  }
});

test('old chart-by-typing is unchanged', () => {
  assert.deepEqual(parseShorthand('30 MO caries'), [{ type: 'condition', tooth: '30', surfaces: 'MO', condition: 'caries' }]);
  assert.deepEqual(parseShorthand('14 D2740'), [{ type: 'procedure', tooth: '14', surfaces: null, code: 'D2740', complete: false }]);
  assert.deepEqual(parseShorthand('3 crown'), [{ type: 'condition', tooth: '3', surfaces: null, condition: 'crown' }]);
  assert.deepEqual(parseShorthand('19 rct done')[0], { type: 'procedure', tooth: '19', surfaces: null, code: 'D3330', complete: true });
  assert.equal(parseShorthand('17 ext')[0].code, 'D7140');
  assert.equal(parseShorthand('32 ext surgical')[0].code, 'D7210');
  assert.deepEqual(parseShorthand('2-4 sealant plan').map((x) => x.tooth), ['2', '3', '4']);
  assert.throws(() => parseShorthand('33 caries'), /isn't a tooth/);
  assert.throws(() => parseShorthand('MO caries'), /tooth number/);
  assert.throws(() => parseShorthand('30 MO banana'), /Didn't understand “banana”/);
  // Without the practice's set-up, aliases are just words.
  assert.throws(() => parseShorthand('np'), /Didn't understand/);
  assert.equal(codeFor('bridge_retainer', '3'), 'D6750');
  assert.equal(codeFor('bone_graft', '19'), 'D7953');
});

test('said the way a dentist says it: fillers, "to", several kinds of work at once', () => {
  assert.deepEqual(said('number 14 crown, plan it'), ['#14 D2740 planned']);
  assert.deepEqual(said('3 to 5 sealant plan'), ['#3 D1351 planned', '#4 D1351 planned', '#5 D1351 planned']);
  assert.deepEqual(said('30 MO caries filling plan'), ['#30 MO caries', '#30 MO D2392 planned'], 'the finding and the fix');
  assert.deepEqual(said('19 root canal, buildup and crown plan'), ['#19 D3330 planned', '#19 D2950 planned', '#19 D2740 planned']);
  assert.deepEqual(said('3-5 bridge plan'), ['#3 D6750 planned', '#4 D6240 planned', '#5 D6750 planned'], 'retainers on the ends, a pontic between');
  assert.deepEqual(said('3-5 pontic plan'), ['#3 D6240 planned', '#4 D6240 planned', '#5 D6240 planned'], 'pontics are pontics');
  assert.deepEqual(said('D4341 UR UL'), ['UR D4341 planned', 'UL D4341 planned']);
  assert.throws(() => run('D4341'), /by quadrant: add UR/);
  assert.throws(() => run('3, 20 bridge plan'), /along one arch/);
  assert.throws(() => run('3-4 bridge plan'), /at least 3/);
});

test('aliases and bundles: crown bundle with options, implant phases, new patient, SRP quadrants, bridge from a range', () => {
  assert.deepEqual(said('crown bundle on 14 with buildup, plan it'), ['#14 D2740 planned', '#14 D2950 planned']);
  assert.deepEqual(said('14 crb'), ['#14 D2740 planned'], 'optional parts off by default');
  assert.deepEqual(said('14 crb with post no buildup'), ['#14 D2740 planned', '#14 D2954 planned']);
  const crown = run('14 crb bu');
  assert.deepEqual(crown.items.map(describe), ['#14 D2740 planned', '#14 D2950 planned'], 'a built-in word switches its option on');
  assert.deepEqual(crown.bundles[0].options.map((o) => [o.label, o.on]), [['buildup', true], ['post', false]]);
  assert.ok(crown.items.every((it) => it.bundle === 'Crown'));
  assert.deepEqual(said('14 crb done').length, 1);
  assert.equal(run('14 crb done').items[0].complete, true);
  assert.throws(() => run('14 crb existing'), /planned or done/);
  assert.throws(() => run('crb'), /Say which tooth for Crown, e\.g\. “14 crb”/);

  const imp = run('30 imp').items;
  assert.deepEqual(imp.map((x) => [x.code, x.tooth, x.phase]), [['D6010', '30', 1], ['D6057', '30', 2], ['D6065', '30', 3]], 'implant as phases');
  assert.deepEqual(said('30 imp no abutment'), ['#30 D6010 planned', '#30 D6065 planned']);

  assert.deepEqual(said('np'), ['D0150 planned', 'D0210 planned', 'D1110 planned']);
  assert.deepEqual(said('new patient'), said('np'), 'by name too');
  assert.throws(() => run('14 np'), /isn't charted on a tooth/);
  assert.deepEqual(said('npc no fluoride'), ['D0150 planned', 'D0272 planned', 'D1120 planned']);

  assert.deepEqual(said('srp'), ['UR D4341 planned', 'UL D4341 planned', 'LL D4341 planned', 'LR D4341 planned']);
  assert.deepEqual(said('srp no LL'), ['UR D4341 planned', 'UL D4341 planned', 'LR D4341 planned']);

  assert.deepEqual(said('3-5 brg'), ['#3 D6750 planned', '#5 D6750 planned', '#4 D6240 planned']);
  assert.deepEqual(said('19-21 brg').map((x) => x.split(' ')[1]), ['D6750', 'D6750', 'D6240']);
  assert.deepEqual(said('3, 6 brg').filter((x) => x.includes('D6240')), ['#4 D6240 planned', '#5 D6240 planned'], 'the ends are enough');
  assert.throws(() => run('3-4 brg'), /at least 3 teeth/);

  assert.deepEqual(said('cdu'), ['U D5110 planned']);
  assert.deepEqual(said('ng'), ['D9944 planned']);
  assert.throws(() => run('np; srp; 14 crb crown bundle imp'), /One bundle per entry/);
  assert.deepEqual(run('np; 14 crb').bundles.map((b) => b.name), ['New patient', 'Crown']);
});

test('sealants on every unsealed permanent molar, from the chart', () => {
  const chart = {
    conditions: [{ tooth: '3', condition: 'sealant', resolved: 0 }, { tooth: '14', condition: 'missing', resolved: 0 }, { tooth: '30', condition: 'caries', resolved: 1 }],
    procedures: [{ tooth: '19', code: 'D2391', status: 'completed' }, { tooth: '18', code: 'D1351', status: 'planned' }, { tooth: '31', code: 'D1351', status: 'cancelled' }],
  };
  assert.deepEqual(run('seal', { chart }).items.map((x) => x.tooth), ['2', '15', '30', '31']);
  assert.deepEqual(run('2, 15 seal', { chart }).items.map((x) => x.tooth), ['2', '15'], 'named teeth win');
  assert.throws(() => run('seal'), /Name the teeth/);
  assert.throws(() => unsealedMolars({ conditions: engine.SEALABLE_MOLARS.map((t) => ({ tooth: t, condition: 'sealant' })) }), /No unsealed/);
});

test('custom aliases: a person\'s buttons and aliases resolve to codes, work, findings and bundles', () => {
  const shortcuts = [
    { id: 1, user_id: null, alias: 'bw', kind: 'code', target: 'D0274', mode: 'plan', active: 1 },
    { id: 2, user_id: 7, alias: 'fmod', kind: 'work', target: 'filling', mode: 'plan', surfaces: 'MOD', active: 1 },
    { id: 3, user_id: 7, alias: 'bigone', kind: 'bundle', target: '1', mode: 'done', active: 1 },
    { id: 4, user_id: 7, alias: 'dk', kind: 'finding', target: 'caries', mode: 'existing', active: 1 },
    { id: 5, user_id: 7, alias: 'gone', kind: 'code', target: 'D2950', mode: 'plan', active: 0 },
  ];
  const lk = buildLookups({ bundles, shortcuts });
  const r = (t) => resolveEntry(t, { lookups: lk }).items.map(describe);
  assert.deepEqual(r('bw'), ['D0274 planned']);
  assert.deepEqual(r('30 fmod'), ['#30 MOD D2393 planned'], 'alias with its own surfaces and mode');
  assert.deepEqual(r('30 fmod done'), ['#30 MOD D2393 done'], 'said in the entry beats the alias');
  assert.deepEqual(r('14 bigone'), ['#14 D2740 done'], 'a bundle alias with its own mode');
  assert.deepEqual(r('30 DO dk'), ['#30 DO caries']);
  assert.throws(() => r('30 gone'), /Didn't understand/, 'retired aliases are gone');
});

test('comparing options: "option one … option two …", "compare … or …", the tooth carries across', () => {
  const a = run('the patient wants to compare: option one, extraction and bone graft on 19; option two, root canal, buildup and crown on 19');
  assert.deepEqual(a.options.map((o) => [o.label, o.items.map((it) => `${it.code} #${it.tooth}`)]), [
    ['Option A', ['D7140 #19', 'D7953 #19']],
    ['Option B', ['D3330 #19', 'D2950 #19', 'D2740 #19']],
  ]);
  assert.ok(a.options.every((o) => o.items.every((it) => !it.complete)), 'options are planned');
  const b = run('option 1, extraction and bone graft; option 2, root canal, buildup and crown on 19');
  assert.deepEqual(b.options[0].items.map((it) => it.tooth), ['19', '19'], 'the tooth said once is used for every option');
  const c = run('compare extraction surgical or 30 root canal and crown');
  assert.deepEqual(c.options.map((o) => o.items.map((it) => it.code)), [['D7210'], ['D3330', 'D2740']]);
  const d = run('option a 14 imp; option b 13-15 brg; option c 14 ext');
  assert.equal(d.options.length, 3);
  assert.deepEqual(d.options[1].items.map((it) => it.code), ['D6750', 'D6750', 'D6240'], 'bundles work inside an option');
  assert.throws(() => run('compare extraction on 19'), /at least two options/);
  assert.throws(() => run('option 1 3 ext; option 2 4 ext; option 3 5 ext; option 4 6 ext'), /up to three/);
  assert.equal(run('14 D2740 plan').options, null, 'an ordinary entry is not a comparison');
});

test('bundle recipes are checked when saved; items expand the same way everywhere', () => {
  assert.throws(() => checkBundle({ name: '', items: [{ code: 'D2740' }] }), /name/);
  assert.throws(() => checkBundle({ name: 'X', items: [] }), /at least one/);
  assert.throws(() => checkBundle({ name: 'X', alias: 'crown', items: [{ code: 'D2740' }] }), /already means something/);
  assert.throws(() => checkBundle({ name: 'X', alias: 'two words', items: [{ code: 'D2740' }] }), /one short word/);
  assert.throws(() => checkBundle({ name: 'X', items: [{ code: 'D27' }] }), /isn't a CDT code/);
  assert.throws(() => checkBundle({ name: 'X', items: [{ code: 'D4341' }] }), /by quadrant/);
  assert.throws(() => checkBundle({ name: 'X', items: [{ work: 'bridge_retainer', tooth: 'ends' }] }), /“between”/);
  assert.throws(() => checkBundle({ name: 'X', items: [{ code: 'D2740', phase: 12 }] }), /phase/);
  assert.throws(() => checkBundle({ name: 'X', items: [{ code: 'D2740', work: 'crown' }] }), /choose a code/);
  const ok = checkBundle({ name: ' Quad fill ', alias: 'QF', items: [{ work: 'filling', surfaces: 'same', tooth: 'same' }, { code: 'd9230', tooth: 'none', optional: true }] });
  assert.equal(ok.alias, 'qf');
  assert.deepEqual(expandBundle(ok, { teeth: ['3', '8'], surfaces: 'MO' }).map(describe), ['#3 MO D2392 planned', '#8 MO D2331 planned'], 'codeFor per tooth');
  assert.deepEqual(expandBundle(ok, { teeth: ['3'], surfaces: 'O', options: new Map([[1, true]]), mode: 'done' }).map(describe), ['#3 O D2391 done', 'D9230 done']);
});

test('what the preview warns about and refuses', () => {
  assert.match(itemProblem({ type: 'procedure', tooth: '30', surfaces: 'MI', code: 'D2392' }), /back tooth/);
  assert.match(itemProblem({ type: 'condition', tooth: '8', surfaces: 'O', condition: 'caries' }), /front tooth/);
  assert.equal(itemProblem({ type: 'procedure', tooth: '8', surfaces: 'MIF', code: 'D2332' }), null);
  const chart = { conditions: [{ tooth: '14', condition: 'missing', resolved: 0 }, { tooth: '30', condition: 'caries', surfaces: 'MO', resolved: 0 }], procedures: [{ tooth: '3', code: 'D2740', status: 'planned' }] };
  const w = chartWarnings([
    ...parseShorthand('3 D2740'), ...parseShorthand('14 D2740'), ...parseShorthand('14 D6010'), ...parseShorthand('30 MO caries'), ...parseShorthand('3 D2950; 3 D2950'),
  ], chart);
  assert.deepEqual(w, ['D2740 on #3 is already planned', '#14 is charted as missing', 'caries on #30 is already charted', 'D2950 on #3 is in this entry twice']);
});

test('Alt+1…9 match by key position (a Mac types ¡™£ with Option), and Shift+digit is not the digit', async () => {
  const { matches } = await import('../../client/src/shortcuts.js');
  const key = (k, code, o = {}) => ({ key: k, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
  assert.equal(matches('alt+1', key('1', 'Digit1', { altKey: true })), true);
  assert.equal(matches('alt+1', key('¡', 'Digit1', { altKey: true })), true, 'Option+1 on a Mac');
  assert.equal(matches('alt+1', key('1', 'Digit1')), false, 'needs Alt');
  assert.equal(matches('alt+2', key('1', 'Digit1', { altKey: true })), false);
  assert.equal(matches('3', key('3', 'Digit3')), true);
  assert.equal(matches('3', key('#', 'Digit3', { shiftKey: true })), false, 'Shift+3 is #');
  assert.equal(matches('3', key('3', 'Numpad3')), true, 'the number pad too');
  assert.equal(matches('alt+c', key('ç', 'KeyC', { altKey: true })), true, 'letters unchanged');
});
