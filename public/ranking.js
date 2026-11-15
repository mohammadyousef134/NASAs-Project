// ranking.js  -  "Best landing site" panel.
//
// You pick a landing date. The panel shows the 8 sites ranked for the 6.5 days (156 hours) that follow that date,
// a small report, and the rule that made the score.
//
// Nothing is calculated here. scripts/18_rank_sites.py did all the work once and wrote public/ranking.json,
// one row per landing date and one entry per site: [score, sun %, earth %, longest dark h, longest Earth gap h].
// The browser only reads that file, sorts 8 numbers and draws a table.

export function initRanking(api) {
  const { $, sites, T0_MS } = api;
  const DAY_MS = 86400000;
  const norm = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let R = null;                       // the parsed ranking.json
  let siteIndex = [];                 // ranking site i -> index in the website's site list (for the 3D view)
  let day = 0;

  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const startMs = () => Date.parse(`${R.start}T00:00:00Z`);

  function show(on) { $('rPanel').style.display = on ? 'block' : 'none'; if (on && R) render(); }
  $('rOpen').onclick = () => show($('rPanel').style.display !== 'block');
  $('rClose').onclick = () => show(false);

  fetch('ranking.json').then((r) => (r.ok ? r.json() : null)).catch(() => null).then((j) => {
    if (!j) { $('rNote').textContent = 'ranking.json was not found. Run scripts/18_rank_sites.py and put the file next to index.html.'; return; }
    R = j;
    siteIndex = R.sites.map((s) => sites.findIndex((w) => norm(w.id) === norm(s.id) || norm(w.name) === norm(s.name)));
    const last = iso(startMs() + (R.n_days - 1) * DAY_MS);
    $('rDate').min = R.start; $('rDate').max = last;
    $('rDate').value = iso(T0_MS + api.getHour() * api.MS_H) >= R.start && iso(T0_MS + api.getHour() * api.MS_H) <= last ? iso(T0_MS + api.getHour() * api.MS_H) : R.start;
    $('rRange').textContent = `Landing dates ${R.start} to ${last} (00:00 UTC). Stay: ${R.window_hours / 24} days.`;
    $('rRuleText').innerHTML = '<ol class="rl">' + R.rule.text.map((t) => `<li>${t}</li>`).join('') + '</ol>' +
      `<div class="sub">Algorithm</div><ol class="rl">
        <li>Python, once: for every hour and every site, find the Sun and the Earth in the site's sky and compare them with its skyline (the same maths as the 3D view).</li>
        <li>For every landing date, take the next ${R.window_hours} hours: S = share of hours with the Sun above the terrain, E = share of hours with Earth in view, dark = longest run with no Sun.</li>
        <li>Score = ${R.rule.weights.power} × S + ${R.rule.weights.earth} × E + ${R.rule.weights.continuity} × (1 − dark / ${R.window_hours}).</li>
        <li>Sort the sites by score. The website only reads the result.</li></ol>`;
    if (iso(T0_MS) !== R.start) $('rNote').textContent = 'Warning: ranking.json and ephemeris.json start on different dates. Rerun the scripts.';
    if ($('rPanel').style.display === 'block') render();
  });

  function setDay(d, sync = true) {
    day = Math.max(0, Math.min(R.n_days - 1, d));
    $('rDate').value = iso(startMs() + day * DAY_MS);
    if (sync) api.setHour(day * 24 + (Date.parse(`${R.start}T00:00:00Z`) - T0_MS) / api.MS_H, true);   // show the same date in 3D
    render();
  }
  $('rDate').onchange = () => {
    if (!R) return;
    const ms = Date.parse(`${$('rDate').value}T00:00:00Z`);
    if (Number.isNaN(ms)) return;
    setDay(Math.round((ms - startMs()) / DAY_MS));
  };
  $('rPrev').onclick = () => R && setDay(day - 1);
  $('rNext').onclick = () => R && setDay(day + 1);

  const nogo = (r) => r[2] < R.rule.min_earth_pct || r[1] < R.rule.min_sun_pct;     // knock-out rules
  const verdict = (r) => (nogo(r) ? 'no-go' : r[0] >= R.rule.good ? 'good' : r[0] >= R.rule.fair ? 'fair' : 'poor');
  const comps = (r) => {                                            // the three parts of the score, in points
    const w = R.rule.weights;
    return { power: (w.power * r[1]) / 100, earth: (w.earth * r[2]) / 100, cont: w.continuity * (1 - r[3] / R.window_hours) };
  };

  function render() {
    if (!R) return;
    const d = Math.round((Date.parse(`${$('rDate').value}T00:00:00Z`) - startMs()) / DAY_MS);
    if (Number.isFinite(d) && d >= 0 && d < R.n_days) day = d;
    const rows = R.days[day].map((r, i) => ({ i, r })).sort((a, b) => nogo(a.r) - nogo(b.r) || b.r[0] - a.r[0] || b.r[1] - a.r[1]);   // valid sites first
    $('rWhen').textContent = `Landing ${iso(startMs() + day * DAY_MS)} 00:00 UTC · stay until ${iso(startMs() + day * DAY_MS + R.window_hours * 3600e3)} ${new Date(startMs() + day * DAY_MS + R.window_hours * 3600e3).toISOString().slice(11, 16)} UTC`;
    const sel = api.getSelected();
    $('rTable').innerHTML = '<tr><th>#</th><th>Site</th><th>Score</th><th>Sun</th><th>Earth</th><th>Dark</th></tr>' +
      rows.map(({ i, r }, k) => {
        const dw = r[3] > R.rule.dark_limit_h; const ew = r[4] > R.rule.gap_limit_h;
        return `<tr class="${k === 0 && !nogo(r) ? 'top' : ''} ${nogo(r) ? 'nogo' : ''} ${siteIndex[i] === sel && sel >= 0 ? 'sel' : ''}" data-i="${i}">
          <td>${k + 1}</td><td class="nm">${R.sites[i].name}</td>
          <td class="sc"><span class="bar" style="width:${Math.max(2, r[0])}%"></span><b>${r[0].toFixed(0)}</b> <span class="vd">${verdict(r)}</span></td>
          <td>${r[1].toFixed(0)}%</td><td title="${ew ? 'No Earth link for up to ' + r[4] + ' h' : ''}">${r[2].toFixed(0)}%${ew ? ' ⚠' : ''}</td><td title="${dw ? 'Darkness longer than ' + R.rule.dark_limit_h + ' h' : ''}">${r[3]} h${dw ? ' ⚠' : ''}</td></tr>`;
      }).join('');

    // the small report, built from the same numbers
    const best = rows[0]; const second = rows[1]; const worst = rows[rows.length - 1];
    const cb = comps(best.r); const cs = comps(second.r);
    const diffs = [['power', cb.power - cs.power], ['Earth link', cb.earth - cs.earth], ['continuity', cb.cont - cs.cont]].sort((a, b) => b[1] - a[1]);
    const nGood = rows.filter(({ r }) => verdict(r) === 'good').length;
    const nValid = rows.filter(({ r }) => !nogo(r)).length;
    const nWarn = rows.filter(({ r }) => !nogo(r) && r[3] > R.rule.dark_limit_h).length;
    const why = nogo(best.r)
      ? `<div><b>No site passes the knock-out rules on this date</b> (Earth in view under ${R.rule.min_earth_pct} % or Sun under ${R.rule.min_sun_pct} %). Closest: ${R.sites[best.i].name}, score ${best.r[0].toFixed(0)}.</div>`
      : `<div><b>${R.sites[best.i].name}</b> is the best site for this date: score ${best.r[0].toFixed(0)} (${verdict(best.r)}). ` +
        `Sun ${best.r[1].toFixed(0)} %, Earth in view ${best.r[2].toFixed(0)} % of the time, longest darkness ${best.r[3]} h.</div>` +
        (nogo(second.r) ? `<div>It is the only valid site: the others are knocked out (too little Earth link or sunlight).</div>`
          : `<div>It beats ${R.sites[second.i].name} by ${(best.r[0] - second.r[0]).toFixed(1)} points, mostly on ${diffs[0][0]} (${diffs[0][1] >= 0 ? '+' : ''}${diffs[0][1].toFixed(1)} pts).</div>`);
    $('rReport').innerHTML = why +
      `<div>${nValid} of ${rows.length} sites pass the knock-out rules, ${nGood} rate good${nWarn ? `, ${nWarn} would sit in darkness for over ${R.rule.dark_limit_h} h` : ''}.</div>` +
      `<div>Weakest: ${R.sites[worst.i].name}, score ${worst.r[0].toFixed(0)} (${verdict(worst.r)}).</div>`;
  }

  $('rTable').onclick = (e) => {
    const tr = e.target.closest('tr[data-i]'); if (!tr) return;
    const j = siteIndex[Number(tr.dataset.i)];
    if (j >= 0) { api.openCard(j); render(); }
  };
  // keep the highlighted row in step with the site chosen elsewhere
  let lastSel = -2;
  return { update() { const s = api.getSelected(); if (s !== lastSel) { lastSel = s; if ($('rPanel').style.display === 'block') render(); } } };
}
