/* =========================================================================
   DATA LOADING
   Two ways this file gets its epics:
     1. Standalone build (epic-network.html) — build.js inlines a snapshot
        as `window.__EPICS_DATA__` before this script runs. No network
        needed, works from a plain double-clicked file.
     2. Dev mode (src/index.html served over http://) — no embedded data,
        so we fetch ./epics.json next to the HTML instead.
   Either way the shape is the same:
     {
       projects: { CODE: { label, parent: CODE|null }, ... },
       workstreams: { KEY: { label, color }, ... },
       epics: [ { id, title, ws, project, state, pct, blocked, startDate,
                  targetDate, dependsOn: [id, ...], parentId: id|null,
                  tags: [str, ...], color? }, ... ]
     }
   epics is everything ADO returned for the "Epic" work item type across
   every ADO project in the programme tree, unfiltered — tags decide what
   actually gets used (see init() below): "key epic" for real workstream
   epics, "programme theme" for Strategic Themes (Tree view only,
   structurally a level above workstream epics), anything else is dropped.
   dependsOn drives the Network/Gantt critical path; parentId drives the
   Tree view (Theme -> Epic, or Epic -> Epic for nested programme structure)
   and is a separate relationship — see fetch_epics.js for how both are
   pulled and shaped. Since a programme's Epics can live in a tree of ADO
   projects (a top-level programme project plus several product projects),
   both dependsOn and parentId routinely point at an epic in a *different*
   project — every id lookup in this file (byId, themesById, etc.) is keyed
   by bare epic id regardless of project, so those links are followed
   transparently. `project` on each epic just drives the project filter and
   the cross-project visual cue (see the `xproj` class below).
   ========================================================================= */
async function loadData(){
  if(window.__EPICS_DATA__) return window.__EPICS_DATA__;
  const res = await fetch('epics.json');
  if(!res.ok) throw new Error(`Failed to load epics.json (HTTP ${res.status})`);
  return res.json();
}

/* =========================================================================
   GRAPH + CPM ENGINE
   ========================================================================= */
function buildGraph(epics){
  const byId = new Map(epics.map(e => [e.id, e]));
  const successors = new Map(epics.map(e => [e.id, []]));
  epics.forEach(e => e.dependsOn.forEach(p => successors.get(p).push(e.id)));
  return { byId, successors };
}

function topoOrder(epics, successors){
  const indeg = new Map(epics.map(e => [e.id, e.dependsOn.length]));
  const queue = epics.filter(e => indeg.get(e.id) === 0).map(e => e.id);
  const order = [];
  while(queue.length){
    const id = queue.shift();
    order.push(id);
    successors.get(id).forEach(s => {
      indeg.set(s, indeg.get(s)-1);
      if(indeg.get(s) === 0) queue.push(s);
    });
  }
  if(order.length !== epics.length) console.warn('Cycle detected in dependency graph');
  return order;
}

// Duration per epic is derived from its ADO Start/Target dates (calendar
// days), so slack/critical-path math reflects real scheduled durations
// rather than a hand-entered estimate.
function deriveDurations(epics){
  epics.forEach(e => {
    // new Date(null) silently resolves to the 1970 epoch rather than
    // failing, so a missing date must be checked for explicitly — otherwise
    // one epic without dates can poison the whole timeline (see
    // deriveProgrammeStart below, which has the same hazard).
    if(!e.startDate || !e.targetDate){ e.duration = 1; return; }
    const days = Math.round((new Date(e.targetDate) - new Date(e.startDate)) / 86400000);
    e.duration = Number.isFinite(days) && days > 0 ? days : 1;
  });
}

// Programme start anchors to the earliest ADO start date among root epics
// (no dependsOn) so the CPM pass reflects the real programme timeline
// instead of a hardcoded date.
function deriveProgrammeStart(epics){
  const withDates = e => !!e.startDate;
  const roots = epics.filter(e => e.dependsOn.length === 0 && withDates(e));
  const pool = roots.length ? roots : epics.filter(withDates);
  return pool.reduce((min, e) => {
    const d = new Date(e.startDate);
    return (!min || d < min) ? d : min;
  }, null) || new Date();
}

function runCPM(epics, programmeStart){
  const { byId, successors } = buildGraph(epics);
  const order = topoOrder(epics, successors);

  const ES = new Map(), EF = new Map();
  order.forEach(id => {
    const e = byId.get(id);
    const es = e.dependsOn.length ? Math.max(...e.dependsOn.map(p => EF.get(p))) : 0;
    ES.set(id, es);
    EF.set(id, es + e.duration);
  });
  const projectEnd = Math.max(...order.map(id => EF.get(id)));

  const LF = new Map(), LS = new Map();
  [...order].reverse().forEach(id => {
    const succs = successors.get(id);
    const lf = succs.length ? Math.min(...succs.map(s => LS.get(s))) : projectEnd;
    LF.set(id, lf);
    LS.set(id, lf - byId.get(id).duration);
  });

  const level = new Map();
  order.forEach(id => {
    const e = byId.get(id);
    level.set(id, e.dependsOn.length ? Math.max(...e.dependsOn.map(p => level.get(p))) + 1 : 0);
  });

  epics.forEach(e => {
    e.ES = ES.get(e.id); e.EF = EF.get(e.id);
    e.LS = LS.get(e.id); e.LF = LF.get(e.id);
    e.slack = LS.get(e.id) - ES.get(e.id);
    e.critical = e.slack <= 0;
    e.level = level.get(e.id);
    e.startDate = addDays(programmeStart, e.ES);
    e.targetDate = addDays(programmeStart, e.EF);
  });

  return { byId, successors, order, projectEnd };
}

function addDays(date, n){ const d = new Date(date); d.setDate(d.getDate()+n); return d; }
function fmtDate(d){ return d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }); }

/* =========================================================================
   MAIN — everything below runs once data has loaded, since layout/CPM/DOM
   all depend on the epic set being known.
   ========================================================================= */
loadData().then(init).catch(err => {
  console.error(err);
  const loading = document.getElementById('loadingState');
  const errorEl = document.getElementById('errorState');
  if(loading) loading.style.display = 'none';
  if(errorEl){
    errorEl.style.display = 'flex';
    errorEl.textContent = 'Could not load epic data.\n' + err.message +
      '\n\nRun fetch_epics.js to (re)generate epics.json, or open the standalone epic-network.html instead.';
  }
});

function init(data){
  const WORKSTREAMS = data.workstreams;
  // The ADO programme tree: a top-level programme project (e.g. BDM)
  // containing several product projects (e.g. BAD, DECD, BDM2, TPLAT).
  // Epics carry a bare `project` code; this map resolves it to a display
  // label and lets us walk up to root for a breadcrumb.
  const PROJECTS = data.projects || {};
  function projectLabel(code){ return (PROJECTS[code] && PROJECTS[code].label) || code || '—'; }
  function projectBreadcrumb(code){
    const chain = [];
    let cur = code;
    const seen = new Set();
    while(cur && !seen.has(cur)){
      seen.add(cur);
      chain.unshift(cur);
      cur = PROJECTS[cur] ? PROJECTS[cur].parent : null;
    }
    return chain.map(projectLabel).join(' › ');
  }
  // data.epics is everything ADO returned for the "Epic" work item type —
  // that includes real workstream epics, Strategic Themes (also Epics in
  // ADO, just one level up the hierarchy), and anything untagged/unrelated
  // that happened to match the WIQL query (e.g. old prototype work). Tags
  // are what tell these apart, since ADO has no other signal for it:
  //   "key epic"        -> a real, in-scope workstream epic (Network/Gantt/Tree)
  //   "programme theme" -> a Strategic Theme, Tree view only — never
  //                        rendered in Network/Gantt, and excluded from the
  //                        dependsOn/CPM graph since it isn't scheduled work
  //   (neither)          -> not part of this programme; dropped entirely
  const hasTag = (item, tag) => (item.tags || []).some(t => t.toLowerCase() === tag.toLowerCase());
  const EPICS = data.epics.filter(e => hasTag(e, 'key epic'));
  const THEME_ITEMS = data.epics.filter(e => hasTag(e, 'programme theme'));
  const themesById = new Map(THEME_ITEMS.map(t => [t.id, t]));
  const excludedCount = data.epics.length - EPICS.length - THEME_ITEMS.length;

  // Every layout/CPM computation below assumes at least one key epic (e.g.
  // levels[0] is dereferenced unconditionally) — fail with a clear, specific
  // message here instead of a cryptic "Cannot read properties of undefined"
  // deep in the layout code. This is a real, expected state mid-rollout: ADO
  // epics start out untagged, so a fresh fetch can easily have Themes tagged
  // correctly but zero workstream epics tagged 'key epic' yet.
  if(EPICS.length === 0){
    document.getElementById('loadingState')?.remove();
    const errorEl = document.getElementById('errorState');
    if(errorEl){
      errorEl.style.display = 'flex';
      const themeNote = THEME_ITEMS.length ? ` (${THEME_ITEMS.length} Strategic Theme${THEME_ITEMS.length===1?'':'s'} tagged correctly and found)` : '';
      errorEl.textContent = `Fetched ${data.epics.length} epic${data.epics.length===1?'':'s'} from Azure DevOps, but none are tagged 'key epic'${themeNote} — nothing to render.\n\nTag your workstream Epics 'key epic' in ADO, then re-run fetch_epics.js and rebuild.`;
    }
    return;
  }

  // Free-form tags (beyond the two structural ones above) drive the Tag
  // filter; an epic's theme (via parentId) drives the Parent filter. Both
  // get a synthetic bucket key ('__untagged__'/'__unassigned__') so an epic
  // missing that attribute still has a filter chip to live under, rather
  // than being unfilterable/invisible to the UI.
  const STRUCTURAL_TAGS = ['key epic', 'programme theme'];
  const UNASSIGNED = '__unassigned__';
  const UNTAGGED = '__untagged__';
  function userTags(e){
    return (e.tags || []).filter(t => !STRUCTURAL_TAGS.some(s => s.toLowerCase() === t.toLowerCase()));
  }
  function tagKeysOf(e){ const t = userTags(e); return t.length ? t : [UNTAGGED]; }
  // Re-derives from themesById directly (rather than calling the
  // later-defined themeOf) so this has no dependency on function-declaration
  // order relative to where it's first used below.
  function themeKeyOf(e){ return (e.parentId && themesById.has(e.parentId)) ? e.parentId : UNASSIGNED; }
  const ALL_TAGS = [...new Set(EPICS.flatMap(userTags))].sort((a,b) => a.localeCompare(b));
  const hasUntagged = EPICS.some(e => userTags(e).length === 0);
  const hasUnassigned = EPICS.some(e => themeKeyOf(e) === UNASSIGNED);

  deriveDurations(EPICS);
  const PROGRAMME_START = deriveProgrammeStart(EPICS);
  const { byId, successors, projectEnd } = runCPM(EPICS, PROGRAMME_START);

  function predecessorsOf(id){ return byId.get(id).dependsOn; }
  function ancestorsOf(id){
    const seen = new Set();
    (function walk(x){ predecessorsOf(x).forEach(p => { if(!seen.has(p)){ seen.add(p); walk(p); } }); })(id);
    return seen;
  }
  function descendantsOf(id){
    const seen = new Set();
    (function walk(x){ successors.get(x).forEach(s => { if(!seen.has(s)){ seen.add(s); walk(s); } }); })(id);
    return seen;
  }

  /* =======================================================================
     LAYOUT — layered DAG, barycenter ordering pass to reduce crossings
     ======================================================================= */
  const COL_W = 268, ROW_H = 128, MARGIN_X = 50, MARGIN_Y = 60, CARD_W = 220, CARD_H = 104;

  const levels = [];
  EPICS.forEach(e => { (levels[e.level] = levels[e.level] || []).push(e.id); });

  const yIndex = new Map();
  levels[0].forEach((id,i) => yIndex.set(id,i));
  function avgY(ids){
    if(!ids.length) return 0;
    return ids.reduce((s,id) => s + yIndex.get(id), 0) / ids.length;
  }
  for(let L=1; L<levels.length; L++){
    levels[L].sort((a,b) => {
      const ba = avgY(predecessorsOf(a)), bb = avgY(predecessorsOf(b));
      return ba - bb;
    });
    levels[L].forEach((id,i) => yIndex.set(id,i));
  }

  const maxRows = Math.max(...levels.map(l => l.length));
  levels.forEach(level => {
    const offset = (maxRows - level.length) / 2;
    level.forEach((id, i) => {
      const e = byId.get(id);
      e.x = MARGIN_X + e.level * COL_W;
      e.y = MARGIN_Y + (i + offset) * ROW_H;
    });
  });

  const svgW = MARGIN_X*2 + (levels.length-1)*COL_W + CARD_W;
  const svgH = MARGIN_Y*2 + maxRows*ROW_H;

  /* =======================================================================
     RENDER — NETWORK
     ======================================================================= */
  const svg = document.getElementById('net');
  svg.setAttribute('width', svgW);
  svg.setAttribute('height', svgH);
  svg.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);
  const edgeLayer = document.getElementById('edgeLayer');
  const nodeLayer = document.getElementById('nodeLayer');

  function statusClass(e){
    if(e.blocked) return 'blocked';
    if(e.state === 'Done') return 'done';
    if(e.state === 'In Progress') return 'progress';
    return 'notstarted';
  }
  function statusColorVar(cls){
    return { done:'var(--done)', progress:'var(--progress)', notstarted:'var(--notstarted)', blocked:'var(--blocked)' }[cls];
  }

  // An epic's parentId can point at either a Strategic Theme or another
  // Epic (e.g. a Programme-level Epic) — these are two different tiers, so
  // only ever resolve to one or the other, never both.
  function themeOf(e){ return e.parentId && themesById.has(e.parentId) ? themesById.get(e.parentId) : null; }
  function parentEpicOf(e){ return e.parentId && byId.has(e.parentId) ? byId.get(e.parentId) : null; }

  function epicCardHTML(e){
    const cls = statusClass(e);
    const badgeLabel = e.blocked ? 'Blocked' : e.state;
    const theme = themeOf(e);
    const themeTag = theme ? ` · <span style="color:${theme.color}">${truncate(theme.title, 22)}</span>` : '';
    return `
      <div class="node-card" xmlns="http://www.w3.org/1999/xhtml">
        <div class="ws-bar" style="background:${WORKSTREAMS[e.ws].color}"></div>
        <div class="row-top">
          <span class="eid"><span class="ptag">${e.project}</span> ${e.id} · ${WORKSTREAMS[e.ws].label}${themeTag}</span>
          <span class="badge ${cls}">${badgeLabel}</span>
        </div>
        <div class="title">${e.title}</div>
        <div class="progress-track"><div class="progress-fill" style="width:${e.pct}%;background:${statusColorVar(cls)}"></div></div>
        <div class="meta meta-dates">
          <span>${fmtDate(e.startDate)} → ${fmtDate(e.targetDate)}</span>
        </div>
        <div class="meta meta-progress" style="margin-top:2px;">
          <span>${e.pct}% complete</span>
          <span class="slack" style="color:${e.critical ? 'var(--amber)' : 'var(--text-mute)'}">${e.critical ? 'CRITICAL · 0d slack' : e.slack+'d slack'}</span>
        </div>
      </div>`;
  }

  EPICS.forEach(e => {
    e.dependsOn.forEach(pId => {
      const p = byId.get(pId);
      const x1 = p.x + CARD_W, y1 = p.y + CARD_H/2;
      const x2 = e.x,          y2 = e.y + CARD_H/2;
      const dx = Math.max(40, (x2-x1)/2);
      const d = `M ${x1},${y1} C ${x1+dx},${y1} ${x2-dx},${y2} ${x2},${y2}`;
      const isCritical = p.critical && e.critical && p.EF === e.ES;
      const isCrossProject = p.project !== e.project;

      const path = document.createElementNS('http://www.w3.org/2000/svg','path');
      path.setAttribute('d', d);
      path.setAttribute('class', 'edge' + (isCritical ? ' critical' : '') + (isCrossProject ? ' xproj' : ''));
      path.setAttribute('marker-end', isCritical ? 'url(#arrowCritical)' : 'url(#arrow)');
      path.dataset.from = pId; path.dataset.to = e.id;
      edgeLayer.appendChild(path);

      if(isCritical){
        const dot = document.createElementNS('http://www.w3.org/2000/svg','circle');
        dot.setAttribute('r', 3.2); dot.setAttribute('class','flow-dot');
        const anim = document.createElementNS('http://www.w3.org/2000/svg','animateMotion');
        anim.setAttribute('dur', '2.4s');
        anim.setAttribute('repeatCount', 'indefinite');
        anim.setAttribute('path', d);
        anim.setAttribute('begin', (Math.random()*1.2).toFixed(2)+'s');
        dot.appendChild(anim);
        edgeLayer.appendChild(dot);
      }
    });
  });

  EPICS.forEach(e => {
    const g = document.createElementNS('http://www.w3.org/2000/svg','g');
    g.setAttribute('class', 'node' + (e.critical ? ' critical' : ''));
    g.dataset.id = e.id;

    const fo = document.createElementNS('http://www.w3.org/2000/svg','foreignObject');
    fo.setAttribute('x', e.x); fo.setAttribute('y', e.y);
    fo.setAttribute('width', CARD_W); fo.setAttribute('height', CARD_H);
    fo.innerHTML = epicCardHTML(e);

    g.appendChild(fo);
    nodeLayer.appendChild(g);

    g.addEventListener('mouseenter', ev => showTooltip(ev, e));
    g.addEventListener('mousemove', ev => positionTooltip(ev));
    g.addEventListener('mouseleave', hideTooltip);
    g.addEventListener('click', () => selectNode(e.id));
  });

  /* =======================================================================
     TOOLTIP
     ======================================================================= */
  const tooltip = document.getElementById('tooltip');
  function showTooltip(ev, e){
    const deps = e.dependsOn.length ? e.dependsOn.map(id => byId.get(id).id + ' · ' + byId.get(id).title).join('<br>') : '— none (programme root)';
    const theme = themeOf(e);
    const parentEpic = parentEpicOf(e);
    tooltip.innerHTML = `
      <h4>${e.id} — ${e.title}</h4>
      <div class="tt-row"><span>Project</span><b>${projectBreadcrumb(e.project)}</b></div>
      <div class="tt-row"><span>Workstream</span><b>${WORKSTREAMS[e.ws].label}</b></div>
      ${theme ? `<div class="tt-row"><span>Strategic theme</span><b style="color:${theme.color}">${theme.title}</b></div>` : ''}
      <div class="tt-row"><span>State</span><b>${e.blocked ? 'Blocked' : e.state}</b></div>
      <div class="tt-row"><span>Start → Target</span><b>${fmtDate(e.startDate)} → ${fmtDate(e.targetDate)}</b></div>
      <div class="tt-row"><span>Duration</span><b>${e.duration}d</b></div>
      <div class="tt-row"><span>Slack (float)</span><b style="color:${e.critical?'#F5A623':'#E8EDF4'}">${e.slack}d</b></div>
      <div class="tt-row"><span>On critical path</span><b>${e.critical ? 'YES' : 'no'}</b></div>
      <div class="tt-row"><span>Tags</span><b>${userTags(e).join(', ') || '—'}</b></div>
      <div class="tt-deps"><b style="font-family:'IBM Plex Mono',monospace;color:var(--text-dim);">Depends on:</b><br>${deps}</div>
      ${parentEpic ? `<div class="tt-deps"><b style="font-family:'IBM Plex Mono',monospace;color:var(--text-dim);">Parent epic:</b><br>${parentEpic.id} · ${parentEpic.title}</div>` : ''}
    `;
    tooltip.classList.add('show');
    positionTooltip(ev);
  }
  function showThemeTooltip(ev, themeId){
    const theme = themesById.get(themeId);
    const children = (treeChildren.get(themeId) || []).map(id => byId.get(id));
    tooltip.innerHTML = `
      <h4>${theme.title}</h4>
      <div class="tt-row"><span>Project</span><b>${projectBreadcrumb(theme.project)}</b></div>
      <div class="tt-row"><span>Type</span><b>Strategic theme</b></div>
      <div class="tt-row"><span>Epics</span><b>${children.length}</b></div>
      <div class="tt-deps"><b style="font-family:'IBM Plex Mono',monospace;color:var(--text-dim);">Contains:</b><br>${children.length ? children.map(c => c.id + ' · ' + c.title).join('<br>') : '— none'}</div>
    `;
    tooltip.classList.add('show');
    positionTooltip(ev);
  }
  function positionTooltip(ev){
    const pad = 16;
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if(x + 286 > window.innerWidth) x = ev.clientX - 286 - pad;
    if(y + 220 > window.innerHeight) y = window.innerHeight - 230;
    tooltip.style.left = x+'px'; tooltip.style.top = y+'px';
  }
  function hideTooltip(){ tooltip.classList.remove('show'); }

  /* =======================================================================
     SELECTION (trace upstream/downstream chain)
     ======================================================================= */
  let selectedId = null;
  function selectNode(id){
    selectedId = (selectedId === id) ? null : id;
    applyState();
  }

  /* =======================================================================
     FILTERS
     ======================================================================= */
  const activeWs = new Set(Object.keys(WORKSTREAMS));
  const activeProjects = new Set(Object.keys(PROJECTS));
  const activeThemes = new Set([...themesById.keys(), ...(hasUnassigned ? [UNASSIGNED] : [])]);
  const activeTags = new Set([...ALL_TAGS, ...(hasUntagged ? [UNTAGGED] : [])]);
  function tagMatches(e){ return tagKeysOf(e).some(k => activeTags.has(k)); }
  let critOnly = false;
  // Only one filter dimension is shown at a time (see filterTypeSwitch
  // below); the other three chip-groups keep whatever selection they had,
  // but that selection is ignored while hidden — otherwise toggling e.g. a
  // Theme off, then switching to the Tag row, would silently keep dimming
  // nodes for a filter the user can no longer see or change.
  let activeFilterType = 'ws';
  function epicMatchesFilter(e){
    switch(activeFilterType){
      case 'project': return activeProjects.has(e.project);
      case 'theme': return activeThemes.has(themeKeyOf(e));
      case 'tag': return tagMatches(e);
      default: return activeWs.has(e.ws);
    }
  }
  // Strategic Theme nodes (Tree view only) aren't real epics — they have no
  // workstream or tags, so only the Project and Theme filter rows apply to
  // them (mirrors the pre-existing ws/tag-don't-apply-to-themes behaviour).
  function themeMatchesFilter(themeId, node){
    switch(activeFilterType){
      case 'project': return activeProjects.has(node.project);
      case 'theme': return activeThemes.has(themeId);
      default: return true;
    }
  }

  // Each chip independently toggles its own membership in the group's
  // active set; Select all / Deselect all (wired below, once every group's
  // chips exist) act on whichever filter row is currently visible.
  function wireChipGroup(chips, activeSet, keyOf){
    chips.forEach(chip => {
      chip.addEventListener('click', () => {
        const key = keyOf(chip);
        if(activeSet.has(key)){ activeSet.delete(key); chip.classList.remove('active'); chip.classList.add('off'); }
        else { activeSet.add(key); chip.classList.add('active'); chip.classList.remove('off'); }
        applyState();
      });
    });
  }

  const wsFilters = document.getElementById('wsFilters');
  const wsChips = Object.entries(WORKSTREAMS).map(([key, w]) => {
    const chip = document.createElement('div');
    chip.className = 'chip active';
    chip.style.color = w.color;
    chip.innerHTML = `<span class="dot" style="background:${w.color}"></span>${w.label}`;
    chip.dataset.key = key;
    wsFilters.appendChild(chip);
    return chip;
  });
  wireChipGroup(wsChips, activeWs, chip => chip.dataset.key);

  // Project filter — independent of the workstream filter, since a
  // workstream's epics can be split across several ADO projects.
  const projFilters = document.getElementById('projFilters');
  const projChips = projFilters ? Object.keys(PROJECTS).map(code => {
    const chip = document.createElement('div');
    chip.className = 'chip active';
    chip.innerHTML = `<span class="mono">${code}</span>`;
    chip.title = projectBreadcrumb(code);
    chip.dataset.key = code;
    projFilters.appendChild(chip);
    return chip;
  }) : [];
  wireChipGroup(projChips, activeProjects, chip => chip.dataset.key);

  // Parent (Strategic Theme) filter — theme chips get a colored dot like
  // workstream chips, since a theme's color is a real, stable identity.
  const themeFilters = document.getElementById('themeFilters');
  const themeChips = [...themesById.values(), ...(hasUnassigned ? [{ id: UNASSIGNED, title: 'Unassigned', color: 'var(--text-mute)' }] : [])]
    .map(t => {
      const chip = document.createElement('div');
      chip.className = 'chip active';
      chip.style.color = t.color;
      chip.innerHTML = `<span class="dot" style="background:${t.color}"></span>${t.title}`;
      chip.dataset.key = t.id;
      themeFilters.appendChild(chip);
      return chip;
    });
  wireChipGroup(themeChips, activeThemes, chip => chip.dataset.key);

  // Tag filter — plain text chips, no dot: unlike ws/theme/project, a tag
  // has no stable color identity, it's free-form.
  const tagFilters = document.getElementById('tagFilters');
  const tagChips = [...ALL_TAGS, ...(hasUntagged ? [UNTAGGED] : [])].map(tag => {
    const chip = document.createElement('div');
    chip.className = 'chip active';
    chip.textContent = tag === UNTAGGED ? 'Untagged' : tag;
    chip.dataset.key = tag;
    tagFilters.appendChild(chip);
    return chip;
  });
  wireChipGroup(tagChips, activeTags, chip => chip.dataset.key);

  // Filter-type switch — swaps which single filter row (and hence which
  // single filter dimension) is visible/active, the same segmented-control
  // pattern as the Network/Gantt/Tree view switch.
  const filterGroups = document.querySelectorAll('#filterBar .filter-group');
  document.querySelectorAll('#filterTypeSwitch button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#filterTypeSwitch button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilterType = btn.dataset.filter;
      filterGroups.forEach(g => g.classList.toggle('active', g.dataset.filterGroup === activeFilterType));
      applyState();
    });
  });

  // Select all / Deselect all — act on whichever filter row is currently
  // visible, since only one chip group is ever on screen at a time.
  const chipGroupsByType = {
    ws: { chips: wsChips, activeSet: activeWs },
    project: { chips: projChips, activeSet: activeProjects },
    theme: { chips: themeChips, activeSet: activeThemes },
    tag: { chips: tagChips, activeSet: activeTags },
  };
  document.getElementById('selectAllChips')?.addEventListener('click', () => {
    const { chips, activeSet } = chipGroupsByType[activeFilterType];
    chips.forEach(c => { activeSet.add(c.dataset.key); c.classList.add('active'); c.classList.remove('off'); });
    applyState();
  });
  document.getElementById('deselectAllChips')?.addEventListener('click', () => {
    const { chips, activeSet } = chipGroupsByType[activeFilterType];
    activeSet.clear();
    chips.forEach(c => { c.classList.remove('active'); c.classList.add('off'); });
    applyState();
  });

  const critToggle = document.getElementById('critToggle');
  critToggle.addEventListener('click', () => {
    critOnly = !critOnly;
    critToggle.classList.toggle('on', critOnly);
    applyState();
  });

  const summaryToggle = document.getElementById('summaryToggle');
  summaryToggle.addEventListener('click', () => {
    const appEl = document.getElementById('app');
    const collapsed = appEl.classList.toggle('summary-collapsed');
    summaryToggle.setAttribute('aria-expanded', String(!collapsed));
    if(!userZoomed) zoomPct = fitZoomToView();
    applyZoom();
  });

  function applyState(){
    // If a Strategic Theme is selected (Tree view only — themes aren't part
    // of the dependsOn graph), fall back to its epic subtree so switching to
    // Network/Gantt still highlights something sensible instead of crashing
    // on ancestorsOf/descendantsOf(themeId), which only know about epics.
    const themeSelected = selectedId && themesById.has(selectedId);
    const highlightSet = selectedId
      ? (themeSelected ? hierarchyDescendantsOf(selectedId) : new Set([selectedId, ...ancestorsOf(selectedId), ...descendantsOf(selectedId)]))
      : null;

    document.querySelectorAll('.node').forEach(g => {
      const id = g.dataset.id, e = byId.get(id);
      let dim = !epicMatchesFilter(e) || (critOnly && !e.critical);
      if(highlightSet) dim = dim || !highlightSet.has(id);
      g.classList.toggle('dimmed', dim);
      g.classList.toggle('selected', id === selectedId);
    });

    document.querySelectorAll('.edge').forEach(p => {
      const from = p.dataset.from, to = p.dataset.to;
      const eFrom = byId.get(from), eTo = byId.get(to);
      let dim = !epicMatchesFilter(eFrom) || !epicMatchesFilter(eTo)
        || (critOnly && !p.classList.contains('critical'));
      let hl = false;
      if(highlightSet){
        hl = highlightSet.has(from) && highlightSet.has(to);
        dim = dim || !hl;
      }
      p.classList.toggle('dimmed', dim);
      p.classList.toggle('highlighted', hl && selectedId && !dim);
    });

    document.querySelectorAll('.gantt-bar-group').forEach(g => {
      const id = g.dataset.id, e = byId.get(id);
      let dim = !epicMatchesFilter(e) || (critOnly && !e.critical);
      if(highlightSet) dim = dim || !highlightSet.has(id);
      g.classList.toggle('dimmed', dim);
      g.classList.toggle('selected', id === selectedId);
    });
    document.querySelectorAll('.gantt-label-row').forEach(g => {
      const id = g.dataset.id, e = byId.get(id);
      let dim = !epicMatchesFilter(e) || (critOnly && !e.critical);
      if(highlightSet) dim = dim || !highlightSet.has(id);
      g.classList.toggle('dimmed', dim);
    });
    document.querySelectorAll('.gantt-link').forEach(p => {
      const from = p.dataset.from, to = p.dataset.to;
      const eFrom = byId.get(from), eTo = byId.get(to);
      let dim = !epicMatchesFilter(eFrom) || !epicMatchesFilter(eTo)
        || (critOnly && !p.classList.contains('critical'));
      let hl = false;
      if(highlightSet){
        hl = highlightSet.has(from) && highlightSet.has(to);
        dim = dim || !hl;
      }
      p.classList.toggle('dimmed', dim);
      p.classList.toggle('highlighted', hl && selectedId && !dim);
    });

    // --- tree nodes/links (hierarchy ancestors/descendants, not dependsOn) ---
    const hierarchyHighlightSet = selectedId ? new Set([selectedId, ...hierarchyAncestorsOf(selectedId), ...hierarchyDescendantsOf(selectedId)]) : null;

    document.querySelectorAll('.tree-node').forEach(g => {
      const id = g.dataset.id;
      // Themes aren't in a workstream and have no critical-path status, so
      // the ws/tag/critOnly filters don't apply to them — only the project
      // filter, their own Parent-filter membership, and the hierarchy
      // selection (if any) can dim a theme node.
      const e = byId.get(id);
      const node = e || themesById.get(id);
      let dim = e ? (!epicMatchesFilter(e) || (critOnly && !e.critical)) : !themeMatchesFilter(id, node);
      if(hierarchyHighlightSet) dim = dim || !hierarchyHighlightSet.has(id);
      g.classList.toggle('dimmed', dim);
      g.classList.toggle('selected', id === selectedId);
    });

    document.querySelectorAll('.tree-link').forEach(p => {
      const from = p.dataset.from, to = p.dataset.to;
      const eFrom = byId.get(from), eTo = byId.get(to); // undefined when an endpoint is a theme
      const nFrom = eFrom || themesById.get(from), nTo = eTo || themesById.get(to);
      let dim = (eFrom ? !epicMatchesFilter(eFrom) : !themeMatchesFilter(from, nFrom))
        || (eTo ? !epicMatchesFilter(eTo) : !themeMatchesFilter(to, nTo));
      let hl = false;
      if(hierarchyHighlightSet){
        hl = hierarchyHighlightSet.has(from) && hierarchyHighlightSet.has(to);
        dim = dim || !hl;
      }
      p.classList.toggle('dimmed', dim);
      p.classList.toggle('highlighted', hl && selectedId && !dim);
    });
  }

  document.getElementById('canvas-wrap').addEventListener('click', ev => {
    if(ev.target.id === 'canvas-wrap' || ev.target.id === 'net'){ selectedId = null; applyState(); }
  });
  document.getElementById('ganttBody').addEventListener('click', ev => {
    if(ev.target.id === 'ganttTimeline' || ev.target.id === 'ganttBarLayer' || ev.target.id === 'ganttGridLayer'){
      selectedId = null; applyState();
    }
  });

  /* =======================================================================
     GANTT VIEW
     ======================================================================= */
  const G_LABEL_W = 280, G_ROW_H = 34, G_GROUP_H = 26, G_PX_PER_DAY = 6, G_HEADER_H = 34, G_BAR_H = 18;

  function buildGanttRows(){
    const rows = [];
    Object.entries(WORKSTREAMS).forEach(([key, w]) => {
      const epics = EPICS.filter(e => e.ws === key).sort((a,b) => a.ES - b.ES);
      if(!epics.length) return;
      rows.push({ type:'group', key, label:w.label, color:w.color });
      epics.forEach(e => rows.push({ type:'epic', epic:e }));
    });
    return rows;
  }

  function renderGantt(){
    const rows = buildGanttRows();
    const totalDays = projectEnd + 14;
    const timelineW = totalDays * G_PX_PER_DAY;
    const bodyH = rows.length * G_ROW_H;

    const axisSvg = document.getElementById('ganttAxis');
    const labelsSvg = document.getElementById('ganttLabels');
    const timelineSvg = document.getElementById('ganttTimeline');
    const gridLayer = document.getElementById('ganttGridLayer');
    const linkLayer = document.getElementById('ganttLinkLayer');
    const barLayer = document.getElementById('ganttBarLayer');

    axisSvg.setAttribute('width', timelineW); axisSvg.setAttribute('height', G_HEADER_H);
    axisSvg.setAttribute('viewBox', `0 0 ${timelineW} ${G_HEADER_H}`);
    labelsSvg.setAttribute('width', G_LABEL_W); labelsSvg.setAttribute('height', bodyH);
    labelsSvg.setAttribute('viewBox', `0 0 ${G_LABEL_W} ${bodyH}`);
    timelineSvg.setAttribute('width', timelineW); timelineSvg.setAttribute('height', bodyH);
    timelineSvg.setAttribute('viewBox', `0 0 ${timelineW} ${bodyH}`);

    const xOf = day => day * G_PX_PER_DAY;

    let axisHtml = '';
    let gridHtml = '';
    const endDate = addDays(PROGRAMME_START, totalDays);
    let cursor = new Date(PROGRAMME_START.getFullYear(), PROGRAMME_START.getMonth(), 1);
    while(cursor <= endDate){
      const dayOffset = Math.round((cursor - PROGRAMME_START) / 86400000);
      if(dayOffset >= 0){
        const x = xOf(dayOffset);
        axisHtml += `<line x1="${x}" y1="0" x2="${x}" y2="${G_HEADER_H}" class="gantt-gridline month"></line>
          <text x="${x+6}" y="21" class="gantt-month-label">${cursor.toLocaleDateString('en-GB',{month:'short',year:'2-digit'})}</text>`;
        gridHtml += `<line x1="${x}" y1="0" x2="${x}" y2="${bodyH}" class="gantt-gridline month"></line>`;
      }
      cursor = new Date(cursor.getFullYear(), cursor.getMonth()+1, 1);
    }
    for(let d=0; d<=totalDays; d+=7){
      const x = xOf(d);
      gridHtml += `<line x1="${x}" y1="0" x2="${x}" y2="${bodyH}" class="gantt-gridline"></line>`;
    }
    axisSvg.innerHTML = axisHtml;
    gridLayer.innerHTML = gridHtml;

    let labelHtml = '';
    let stripeHtml = '';
    let barHtml = '';
    const rowY = new Map();

    rows.forEach((row, i) => {
      const y = i * G_ROW_H;
      if(row.type === 'group'){
        stripeHtml += `<rect x="0" y="${y}" width="${G_LABEL_W}" height="${G_GROUP_H}" class="grp-bg"></rect>`;
        labelHtml += `<g class="gantt-group-row">
            <rect x="0" y="${y}" width="${G_LABEL_W}" height="${G_GROUP_H}" class="grp-bg"></rect>
            <rect x="0" y="${y}" width="4" height="${G_GROUP_H}" fill="${row.color}"></rect>
            <text x="14" y="${y+G_GROUP_H/2+4}" fill="var(--text-dim)">${row.label}</text>
          </g>`;
      } else {
        const e = row.epic;
        rowY.set(e.id, y + G_ROW_H/2);
        const cls = statusClass(e);
        const color = statusColorVar(cls);

        stripeHtml += `<rect x="0" y="${y}" width="${G_LABEL_W}" height="${G_ROW_H}" class="gantt-row-stripe ${i%2?'alt':''}"></rect>`;
        labelHtml += `<g class="gantt-label-row" data-id="${e.id}">
            <rect x="0" y="${y}" width="${G_LABEL_W}" height="${G_ROW_H}" class="rowbg"></rect>
            <rect x="0" y="${y}" width="3" height="${G_ROW_H}" fill="${WORKSTREAMS[e.ws].color}"></rect>
            <text x="14" y="${y+14}" class="geid">${e.project} · ${e.id} · ${e.critical ? 'CRITICAL' : e.slack+'d slack'}</text>
            <text x="14" y="${y+27}" class="gname">${truncate(e.title, 30)}</text>
          </g>`;
        const x1 = xOf(e.ES), x2 = xOf(e.EF);
        const barY = y + (G_ROW_H - G_BAR_H)/2;
        const w = Math.max(4, x2-x1);
        const fillW = w * (e.pct/100);
        barHtml += `<g class="gantt-bar-group${e.critical?' critical':''}" data-id="${e.id}">
            <rect x="${x1}" y="${barY}" width="${w}" height="${G_BAR_H}" rx="4" class="gantt-bar-track"></rect>
            <rect x="${x1}" y="${barY}" width="${fillW}" height="${G_BAR_H}" rx="4" class="gantt-bar-fill" fill="${color}" opacity="0.85"></rect>
            <rect x="${x1}" y="${barY}" width="${w}" height="${G_BAR_H}" rx="4" class="gantt-bar-outline"></rect>
            <text x="${x2+8}" y="${barY+13}" class="gantt-bar-label">${e.pct}%${e.blocked?' · blocked':''}</text>
          </g>`;
      }
    });
    labelsSvg.innerHTML = `<g>${stripeHtml}</g>${labelHtml}`;
    barLayer.innerHTML = barHtml;

    let linkHtml = '';
    EPICS.forEach(e => {
      if(!rowY.has(e.id)) return;
      e.dependsOn.forEach(pId => {
        const p = byId.get(pId);
        if(!rowY.has(pId)) return;
        const x1 = xOf(p.EF), y1 = rowY.get(pId);
        const x2 = xOf(e.ES), y2 = rowY.get(e.id);
        const midX = x1 + Math.max(10, (x2-x1)/2);
        const isCritical = p.critical && e.critical && p.EF === e.ES;
        const isCrossProject = p.project !== e.project;
        const d = (Math.abs(y1-y2) < 1)
          ? `M ${x1},${y1} L ${x2},${y2}`
          : `M ${x1},${y1} L ${midX},${y1} L ${midX},${y2} L ${x2},${y2}`;
        linkHtml += `<path d="${d}" class="gantt-link${isCritical?' critical':''}${isCrossProject?' xproj':''}" data-from="${pId}" data-to="${e.id}" marker-end="url(#${isCritical?'arrowGanttCritical':'arrowGantt'})"></path>`;
      });
    });
    linkLayer.innerHTML = linkHtml;

    document.querySelectorAll('.gantt-bar-group, .gantt-label-row').forEach(g => {
      const id = g.dataset.id, e = byId.get(id);
      g.addEventListener('mouseenter', ev => showTooltip(ev, e));
      g.addEventListener('mousemove', ev => positionTooltip(ev));
      g.addEventListener('mouseleave', hideTooltip);
      g.addEventListener('click', ev => { ev.stopPropagation(); selectNode(id); });
    });
  }

  function truncate(str, n){ return str.length > n ? str.slice(0,n-1)+'…' : str; }

  const ganttScrollHeader = document.getElementById('ganttScrollHeader');
  const ganttTimelineScroll = document.getElementById('ganttTimelineScroll');
  ganttTimelineScroll.addEventListener('scroll', () => {
    ganttScrollHeader.scrollLeft = ganttTimelineScroll.scrollLeft;
  });

  /* =======================================================================
     TREE VIEW — parent/child Epic hierarchy: Strategic Themes at the top,
     then Epics (and potentially Programme-level Epics) nested under them.
     This is a *different* relationship from dependsOn (which drives the
     Network/Gantt critical path) — an epic can depend on a sibling in
     another workstream while still rolling up under the same theme, so
     this needs its own graph and its own ancestors/descendants used for
     click-to-trace highlighting. A parentId may point at either a Theme
     or another Epic — both are valid "parent" kinds in this graph.
     ======================================================================= */
  const treeChildren = new Map(); // parentId (theme or epic) -> [childId, ...]
  EPICS.forEach(e => {
    if(e.parentId && (byId.has(e.parentId) || themesById.has(e.parentId))){
      if(!treeChildren.has(e.parentId)) treeChildren.set(e.parentId, []);
      treeChildren.get(e.parentId).push(e.id);
    } else {
      e.parentId = null; // normalize dangling/self refs defensively
    }
  });
  // Themes are always top-level (no theme-of-theme nesting); epics with no
  // parent at all are also top-level, alongside whatever themes exist.
  const treeRoots = [...themesById.keys(), ...EPICS.filter(e => !e.parentId).map(e => e.id)];

  function hierarchyAncestorsOf(id){
    const seen = new Set();
    (function walk(x){ const node = byId.get(x); const p = node ? node.parentId : null; if(p && !seen.has(p)){ seen.add(p); walk(p); } })(id);
    return seen;
  }
  function hierarchyDescendantsOf(id){
    const seen = new Set();
    (function walk(x){ (treeChildren.get(x)||[]).forEach(c => { if(!seen.has(c)){ seen.add(c); walk(c); } }); })(id);
    return seen;
  }

  const T_COL_W = CARD_W + 36, T_ROW_H = CARD_H + 64, T_MARGIN_X = 50, T_MARGIN_Y = 50;
  // Populated by renderTree() below — captured here (rather than left local
  // to that function) so the zoom section can read the Tree view's native
  // layout size without depending on function declaration order.
  const treeDims = { w: 0, h: 0 };

  function layoutTree(){
    const centerOf = new Map(); // id -> { centerX, depth }
    let nextLeafSlot = 0;
    function place(id, depth){
      const kids = treeChildren.get(id) || [];
      let centerX;
      if(!kids.length){
        centerX = T_MARGIN_X + nextLeafSlot*T_COL_W + CARD_W/2;
        nextLeafSlot++;
      } else {
        const kidCenters = kids.map(k => place(k, depth+1));
        centerX = (Math.min(...kidCenters) + Math.max(...kidCenters)) / 2;
      }
      centerOf.set(id, { centerX, depth });
      return centerX;
    }
    treeRoots.forEach(r => place(r, 0));
    return centerOf;
  }

  function renderTree(){
    const centerOf = layoutTree();
    const maxDepth = Math.max(0, ...[...centerOf.values()].map(p => p.depth));
    const maxCenterX = Math.max(CARD_W, ...[...centerOf.values()].map(p => p.centerX));
    const svgW = maxCenterX + CARD_W/2 + T_MARGIN_X;
    const svgH = T_MARGIN_Y*2 + (maxDepth+1)*T_ROW_H - (T_ROW_H - CARD_H);
    treeDims.w = svgW; treeDims.h = svgH;

    const treeSvg = document.getElementById('treeNet');
    treeSvg.setAttribute('width', svgW);
    treeSvg.setAttribute('height', svgH);
    treeSvg.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);
    const treeEdgeLayer = document.getElementById('treeEdgeLayer');
    const treeNodeLayer = document.getElementById('treeNodeLayer');
    treeEdgeLayer.innerHTML = '';
    treeNodeLayer.innerHTML = '';

    treeChildren.forEach((kids, parentId) => {
      const pp = centerOf.get(parentId);
      const x1 = pp.centerX, y1 = T_MARGIN_Y + pp.depth*T_ROW_H + CARD_H;
      kids.forEach(childId => {
        const cp = centerOf.get(childId);
        const x2 = cp.centerX, y2 = T_MARGIN_Y + cp.depth*T_ROW_H;
        const dy = Math.max(16, (y2-y1)/2);
        const d = `M ${x1},${y1} C ${x1},${y1+dy} ${x2},${y2-dy} ${x2},${y2}`;
        const parentNode = byId.get(parentId) || themesById.get(parentId);
        const childNode = byId.get(childId) || themesById.get(childId);
        const isCrossProject = parentNode && childNode && parentNode.project !== childNode.project;
        const path = document.createElementNS('http://www.w3.org/2000/svg','path');
        path.setAttribute('d', d);
        path.setAttribute('class', 'tree-link' + (isCrossProject ? ' xproj' : ''));
        path.dataset.from = parentId; path.dataset.to = childId;
        treeEdgeLayer.appendChild(path);
      });
    });

    centerOf.forEach((pos, id) => {
      const isTheme = themesById.has(id);
      const e = isTheme ? null : byId.get(id);
      const x = pos.centerX - CARD_W/2, y = T_MARGIN_Y + pos.depth*T_ROW_H;

      const g = document.createElementNS('http://www.w3.org/2000/svg','g');
      g.setAttribute('class', 'tree-node' + (isTheme ? ' theme' : (e.critical ? ' critical' : '')));
      g.dataset.id = id;

      const fo = document.createElementNS('http://www.w3.org/2000/svg','foreignObject');
      fo.setAttribute('x', x); fo.setAttribute('y', y);
      fo.setAttribute('width', CARD_W); fo.setAttribute('height', CARD_H);
      fo.innerHTML = isTheme ? themeCardHTML(themesById.get(id), (treeChildren.get(id)||[]).length) : epicCardHTML(e);

      g.appendChild(fo);
      treeNodeLayer.appendChild(g);

      g.addEventListener('mouseenter', ev => isTheme ? showThemeTooltip(ev, id) : showTooltip(ev, e));
      g.addEventListener('mousemove', ev => positionTooltip(ev));
      g.addEventListener('mouseleave', hideTooltip);
      g.addEventListener('click', () => selectNode(id));
    });
  }

  function themeCardHTML(theme, childCount){
    return `
      <div class="node-card theme-card" xmlns="http://www.w3.org/1999/xhtml">
        <div class="ws-bar" style="background:${theme.color}"></div>
        <div class="row-top">
          <span class="eid"><span class="ptag">${theme.project}</span> STRATEGIC THEME</span>
        </div>
        <div class="title">${theme.title}</div>
        <div class="meta">
          <span>${childCount} epic${childCount === 1 ? '' : 's'}</span>
        </div>
      </div>`;
  }

  document.getElementById('tree-canvas-wrap').addEventListener('click', ev => {
    if(ev.target.id === 'tree-canvas-wrap' || ev.target.id === 'treeNet'){ selectedId = null; applyState(); }
  });

  /* =======================================================================
     VIEW SWITCHING
     ======================================================================= */
  const networkView = document.getElementById('networkView');
  const ganttView = document.getElementById('ganttView');
  const treeView = document.getElementById('treeView');
  document.querySelectorAll('#viewSwitch button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#viewSwitch button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.view;
      networkView.style.display = view === 'network' ? 'flex' : 'none';
      ganttView.style.display = view === 'gantt' ? 'flex' : 'none';
      treeView.style.display = view === 'tree' ? 'flex' : 'none';
      if(!userZoomed) zoomPct = fitZoomToView();
      applyZoom();
    });
  });
  networkView.style.display = 'flex';

  /* =======================================================================
     ZOOM + LEVEL-OF-DETAIL — Network and Tree share one zoom control, since
     both are node/edge diagrams laid out in fixed pixel coordinates (Gantt
     has its own time-axis scale and isn't part of this — the control hides
     itself there). Zoom is "% of native layout size": the SVG's viewBox
     stays fixed at the logical layout size while its rendered CSS
     width/height scale by the zoom fraction — SVG's own viewBox-scaling
     mechanism, so foreignObject card content scales with it for free and
     #canvas-wrap/#tree-canvas-wrap's existing overflow:auto scrollbars just
     work. See the data-lod CSS in styles.css for the legibility side: below
     ~75% zoom, geometric shrink alone makes card text illegible well before
     the layout is meaningfully zoomed out, so lower tiers drop secondary
     fields and enlarge what's left instead.
     ======================================================================= */
  const ZOOM_MIN = 20, ZOOM_MAX = 200;
  let zoomPct = 100;
  let userZoomed = false; // true once the user takes manual control; suppresses auto-fit-on-resize/view-switch

  const zoomWrap = document.getElementById('zoomWrap');
  const zoomSlider = document.getElementById('zoomSlider');
  const zoomLabel = document.getElementById('zoomLabel');
  const appEl = document.getElementById('app');

  function activeZoomableView(){
    if(networkView.style.display !== 'none') return { svg, w: svgW, h: svgH, wrap: document.getElementById('canvas-wrap') };
    if(treeView.style.display !== 'none') return { svg: document.getElementById('treeNet'), w: treeDims.w, h: treeDims.h, wrap: document.getElementById('tree-canvas-wrap') };
    return null; // Gantt — not zoomable here
  }

  function lodTierFor(pct){
    if(pct < 30) return '3';
    if(pct < 50) return '2';
    if(pct < 75) return '1';
    return null;
  }

  function applyZoom(){
    const view = activeZoomableView();
    zoomWrap.classList.toggle('hidden', !view);
    if(!view){ appEl.removeAttribute('data-lod'); return; }
    zoomPct = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoomPct));
    const frac = zoomPct / 100;
    if(view.w && view.h){
      view.svg.style.width = (view.w * frac) + 'px';
      view.svg.style.height = (view.h * frac) + 'px';
    }
    const lod = lodTierFor(zoomPct);
    if(lod) appEl.setAttribute('data-lod', lod); else appEl.removeAttribute('data-lod');
    zoomSlider.value = zoomPct;
    zoomLabel.textContent = Math.round(zoomPct) + '%';
  }

  // Fits the current view's full width AND height into the visible canvas —
  // used as the responsive default (initial load + window resize) whenever
  // the user hasn't manually overridden zoom. Never upscales past 100%
  // native. Fitting height too matters for the Tree view: it can fan out
  // wide but also run deep, and fitting width alone left tall trees taller
  // than the viewport, so scrolling straight down from a shallow branch
  // landed on blank canvas instead of the deeper siblings laid out to the
  // side.
  function fitZoomToView(){
    const view = activeZoomableView();
    if(!view || !view.w || !view.h) return 100;
    const availW = view.wrap.clientWidth - 24;
    const availH = view.wrap.clientHeight - 24;
    if(availW <= 0 || availH <= 0) return 100;
    const fitPct = Math.floor(Math.min(availW / view.w, availH / view.h) * 100);
    return Math.min(100, Math.max(ZOOM_MIN, fitPct));
  }

  zoomSlider.addEventListener('input', () => {
    userZoomed = true;
    zoomPct = Number(zoomSlider.value);
    applyZoom();
  });
  document.getElementById('zoomOut').addEventListener('click', () => {
    userZoomed = true; zoomPct -= 10; applyZoom();
  });
  document.getElementById('zoomIn').addEventListener('click', () => {
    userZoomed = true; zoomPct += 10; applyZoom();
  });
  document.getElementById('zoomFit').addEventListener('click', () => {
    userZoomed = false;
    zoomPct = fitZoomToView();
    applyZoom();
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if(!userZoomed) zoomPct = fitZoomToView();
      applyZoom();
    }, 150);
  });

  /* =======================================================================
     STATS BAR
     ======================================================================= */
  function renderStats(){
    const total = EPICS.length;
    const avgPct = Math.round(EPICS.reduce((s,e) => s+e.pct, 0) / total);
    const criticalCount = EPICS.filter(e => e.critical).length;
    const blockedCount = EPICS.filter(e => e.blocked).length;
    const endDate = fmtDate(addDays(PROGRAMME_START, projectEnd));

    const projectCount = new Set(EPICS.map(e => e.project)).size;

    const stats = [
      { label:'Total epics', val: total },
      { label:'Projects', val: projectCount },
      { label:'Overall progress', val: avgPct+'%' },
      { label:'Critical path', val: projectEnd+'d', cls:'crit' },
      { label:'On critical path', val: criticalCount+' epics', cls:'crit' },
      { label:'Blocked', val: blockedCount, cls: blockedCount ? 'warn' : '' },
      { label:'Projected finish', val: endDate },
    ];
    document.getElementById('statsRow').innerHTML = stats.map(s => `
      <div class="stat ${s.cls||''}">
        <div class="val">${s.val}</div>
        <div class="lbl">${s.label}</div>
      </div>`).join('');
  }

  const dataNote = document.getElementById('dataNote');
  if(dataNote){
    const excludedNote = excludedCount ? ` (${excludedCount} other epic${excludedCount===1?'':'s'} fetched but excluded — missing a 'key epic' or 'programme theme' tag)` : '';
    const projectList = data.source && data.source.projects ? data.source.projects.join(', ') : Object.keys(PROJECTS).join(', ');
    dataNote.innerHTML = (data.source
      ? `Rendering <b>${EPICS.length} epics</b> under <b>${THEME_ITEMS.length} themes</b> across <b>${projectList}</b> from Azure DevOps — <b>${data.source.org}</b>, fetched ${data.source.generatedAt}.`
      : `Rendering <b>${EPICS.length} epics</b> under <b>${THEME_ITEMS.length} themes</b> across <b>${projectList}</b>.`) + excludedNote;
  }

  document.getElementById('loadingState')?.remove();
  document.getElementById('app').style.display = 'flex';

  renderStats();
  renderGantt();
  renderTree();
  applyState();

  zoomPct = fitZoomToView();
  applyZoom();
}
