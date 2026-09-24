import { useLayoutEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useShortcuts, useCommands } from '../../shortcuts.js';
import { useRemembered } from '../../prefs.js';
import { useBusinessAccess, useBusinessSchedule, BusinessToggle, BusinessStrip, StaffLanes, ExamsCard, BandLegend, visitBreakdown, $, $h } from './BusinessView.jsx';

// The business view on the schedule (PM3, BD1–BD3, EX), for the owner. Kept in its own module so the schedule
// needs only a few lines to mount it (docs/workflows/specs/BV-business-view.md, "Mounting"):
//   const biz = useBusinessView({ date: from, days: view === 'week' ? 7 : 1, office, version: data });
//   toolbar:          {biz.allowed && <BusinessToggle on={biz.on} onToggle={biz.toggle} />}
//   under the bars:   {biz.on && <BusinessPanel biz={biz} date={date} office={office} view={view} />}
//   after the grid:   {biz.on && <BusinessOverlay biz={biz} columns={gridColumns} />}
// The overlay marks the grid's visits and column headings in place (a band color, "$270/h", a hover breakdown),
// so the calendar itself needs no change. Staff never see any of it: the server doesn't answer them.
export { BusinessToggle };

export function useBusinessView({ date, days = 1, office, version }) {
  const nav = useNavigate();
  const access = useBusinessAccess();
  const allowed = !!access?.view;
  // On or off is remembered per person (on the server), like the schedule's other view choices.
  const [pref, remember] = useRemembered('schedule.business_view', false);
  const on = allowed && !!pref;
  const [lanesPref, rememberLanes] = useRemembered('schedule.business_lanes', true);
  const toggle = () => remember(!on);
  useShortcuts([
    { combo: 'shift+b', handler: toggle, label: 'Business view: margin per hour, labor vs production', section: 'Schedule views', enabled: allowed },
    { combo: 'shift+l', handler: () => rememberLanes(!lanesPref), label: 'Staff lanes in the business view', section: 'Schedule views', enabled: on },
  ]);
  useCommands(allowed ? [
    { id: 'sched-business', label: on ? 'Schedule: hide the business view' : 'Schedule: business view (margin per hour, labor %)', hint: 'Shift+B', run: toggle },
    { id: 'business-page', label: 'Business: today, what pays, trends, costs', run: () => nav('/business') },
  ] : []);
  const { data } = useBusinessSchedule({ date, days, office, on, version });
  return { allowed, on, toggle, data, access, lanes: on && !!lanesPref && (access?.lanes ?? false), toggleLanes: () => rememberLanes(!lanesPref) };
}

// Legend, today's strip, exams and the staff lanes, under the schedule's bars.
export function BusinessPanel({ biz, date, office, view }) {
  if (!biz?.on) return null;
  return (
    <div className="biz-panel no-print">
      <BandLegend biz={biz.data} />
      {view !== 'week' && <BusinessStrip date={date} office={office} onLanes={biz.access?.lanes ? biz.toggleLanes : null} lanesOn={biz.lanes} />}
      {view !== 'week' && <ExamsCard date={date} office={office} compact />}
      {view !== 'week' && biz.lanes && <StaffLanes date={date} office={office} />}
    </div>
  );
}

// Marks the calendar's visits and column headings with the business view, in place. It only sets a class, a CSS
// variable and data/title attributes on the grid's own elements (never adds or removes nodes React owns), and does
// it again whenever the grid redraws them.
export function BusinessOverlay({ biz, columns }) {
  const visits = biz?.on ? biz.data?.visits : null;
  const basis = biz?.data?.basis;
  const colTotals = biz?.on && biz.data ? columns.map((c) => columnTotals(c, biz.data)) : null;
  useLayoutEffect(() => {
    if (!visits) return undefined;
    const root = document.querySelector('.cal');
    if (!root) return undefined;
    const paint = () => {
      for (const el of root.querySelectorAll('.cal-appt[data-appt-id]')) {
        const v = visits[el.getAttribute('data-appt-id')];
        const band = v ? `biz-${v.band}` : null;
        for (const c of [...el.classList]) if (c.startsWith('biz-') && c !== band) el.classList.remove(c);
        if (!v) { el.classList.remove('biz'); el.removeAttribute('data-biz'); continue; }
        if (!el.classList.contains('biz')) el.classList.add('biz');
        if (!el.classList.contains(band)) el.classList.add(band);
        // Too short for a second tag (a 30-minute visit at a small zoom): the $/h would sit on the name line and
        // cover its badges (Late, $?). The hover title still has the full breakdown.
        const label = v.value == null || el.offsetHeight < 34 ? '' : $h(v.value);
        if (el.getAttribute('data-biz') !== label) el.setAttribute('data-biz', label);
        const title = visitBreakdown(v, basis);
        if (el.getAttribute('title') !== title) el.setAttribute('title', title);
      }
      const heads = root.querySelectorAll('.cal-col-head');
      heads.forEach((el, i) => {
        const t = colTotals?.[i];
        const text = t ? `${$(t.margin)} margin${t.profit != null ? ` · ${$(t.profit)} profit` : ''}` : '';
        if ((el.getAttribute('data-biz') || '') !== text) {
          if (text) el.setAttribute('data-biz', text); else el.removeAttribute('data-biz');
        }
        const band = t ? `biz-${t.band}` : null;
        for (const c of [...el.classList]) if (c.startsWith('biz-') && c !== band) el.classList.remove(c);
        if (band && !el.classList.contains(band)) el.classList.add(band);
      });
    };
    paint();
    const obs = new MutationObserver(() => paint());
    obs.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] }); // style: a zoom change resizes the cards
    return () => {
      obs.disconnect();
      for (const el of root.querySelectorAll('.cal-appt.biz, .cal-col-head[data-biz]')) {
        el.classList.remove('biz');
        for (const c of [...el.classList]) if (c.startsWith('biz-')) el.classList.remove(c);
        el.removeAttribute('data-biz');
        if (el.classList.contains('cal-appt')) el.removeAttribute('title');
      }
    };
  }, [visits, basis, JSON.stringify(colTotals)]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
function columnTotals(c, data) {
  if (c.assign?.provider_id) return data.columns?.providers?.[c.date]?.[c.assign.provider_id] || null;
  if (c.assign && 'operatory_id' in c.assign) return data.columns?.operatories?.[c.date]?.[c.assign.operatory_id ?? 'none'] || null;
  return data.days?.[c.date] || null;
}
