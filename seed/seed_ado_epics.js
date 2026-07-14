#!/usr/bin/env node
/**
 * seed_ado_epics.js
 * ------------------
 * Pushes the Helios Transformation Programme mock epics (the same ones used
 * in the original epic-network.html mock data, now spread across a small
 * tree of ADO projects instead of one) into real Azure DevOps projects as
 * Epic work items, wired together with native "Dependency" and hierarchy
 * links — so the network/Gantt/tree tool can be driven from live ADO data
 * via fetch_epics.js instead of mock data.
 *
 * WHY THIS RUNS LOCALLY, NOT INSIDE CLAUDE
 * Claude's sandbox has no outbound network access and there's no Azure DevOps
 * connector configured, so it can't call dev.azure.com directly. This script
 * is meant to be run on your own machine (or a CI runner) with your own PAT.
 * Requires Node 18+ (uses the built-in fetch()) and no npm dependencies.
 *
 * MULTI-PROJECT PROGRAMME
 * Real programmes usually aren't one flat ADO project — there's a top-level
 * programme project (holding Strategic Themes and shared platform epics)
 * and several product projects underneath it. PROJECTS below describes that
 * tree; each mock epic/theme in MOCK_EPICS/MOCK_THEMES carries a `project`
 * key saying which one it's seeded into. Work item ids are unique across
 * the whole ADO org, so dependency/hierarchy links between epics in
 * different projects work exactly like same-project ones — this script
 * creates each epic via its own project's endpoint, but wires up links via
 * the org-level work item endpoint so the project boundary never matters
 * for linking.
 *
 * WHAT IT CREATES PER EPIC
 *   System.Title                          -> epic title
 *   System.WorkItemType                   -> "Epic"
 *   System.AreaPath                       -> "<Project>\<Workstream>" (omitted
 *                                             for Strategic Themes, which
 *                                             have no workstream)
 *   System.State                          -> New | In Progress | Done
 *   System.Tags                           -> "key epic" or "programme theme"
 *                                             (plus "Blocked" and any extra
 *                                             descriptive tags from the
 *                                             epic's `tags`, if applicable)
 *   Microsoft.VSTS.Scheduling.StartDate   -> ISO date
 *   Microsoft.VSTS.Scheduling.TargetDate  -> ISO date
 *   System.Description                    -> "Progress: NN% complete (seeded mock data)"
 *
 * Then, in later passes, it adds:
 *   - a System.LinkTypes.Dependency-Reverse relation from each epic to every
 *     epic it depends on (i.e. "this is blocked by that"), matching the
 *     dependsOn structure of the original mock data;
 *   - a System.LinkTypes.Hierarchy-Reverse relation from each epic to its
 *     parent Strategic Theme.
 *
 * NOTE ON % COMPLETE
 * Epics don't have a standard "percent complete" field out of the box — most
 * orgs either roll it up from child Features/PBIs, or add a custom field.
 * This script writes it into the Description as a placeholder so the mock
 * data isn't lost. (fetch_epics.js computes a real rollup from child work
 * items when reading epics back out.)
 *
 * SETUP
 *   export ADO_ORG=your-org            # https://dev.azure.com/<ADO_ORG>
 *   export ADO_PAT=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *
 *   PAT scope required: Work Items (Read, write, & manage), and Project and
 *   Team (Read) if you want the script to auto-create Area Paths. The five
 *   ADO projects named in PROJECTS below (BDM, BAD, DECD, BDM2, TPLAT) must
 *   already exist — this script does not create projects, only epics/area
 *   paths within them.
 *
 * USAGE
 *   node seed_ado_epics.js                 # dry run — prints the plan, writes nothing
 *   node seed_ado_epics.js --apply         # actually creates work items + links
 *   node seed_ado_epics.js --apply --skip-area-paths   # if area paths already exist
 *   npm run seed -- --apply
 *
 * OUTPUT
 *   ado_id_map.json — maps mock ids (E1..E18, T1..T3) to the real ADO work
 *   item ids/urls/projects that got created, so you can re-run safely.
 */

import fs from 'node:fs';

const API_VERSION = '7.1';

// The ADO project tree this programme's epics get seeded into. `parent` is
// display-only metadata (mirrors PROJECT_TREE in fetch_epics.js / the
// `projects` block in epics.json) — ADO has no native cross-project
// hierarchy, so nothing here affects how work items actually get created.
// `adoProject` is the *literal* ADO project name to hit via the API — it
// only needs to differ from the key when the short display code isn't
// itself a real ADO project name (e.g. TPLAT is our code for the
// "Technology Platform" ADO project; BDM/BAD/DECD/BDM2 happen to be both).
const PROJECTS = {
  BDM: { parent: null, adoProject: 'BDM' },
  BAD: { parent: 'BDM', adoProject: 'BAD' },
  DECD: { parent: 'BDM', adoProject: 'DECD' },
  BDM2: { parent: 'BDM', adoProject: 'BDM2' },
  TPLAT: { parent: 'BDM', adoProject: 'Technology Platform' },
};

function adoProjectName(code) { return (PROJECTS[code] && PROJECTS[code].adoProject) || code; }

const WORKSTREAMS = {
  PLAT: 'Core Platform',
  DATA: 'Data Migration',
  PORT: 'Customer Portal',
  PAY: 'Payments',
  RPT: 'Reporting and Analytics',
  DEC: 'Legacy Decommission',
};

// Azure DevOps classification node (Area/Iteration Path) names cannot contain
// any of: $ ? : * " / \ < > | ; # %  — and can't start/end with a space or be
// "." / "..". Applied defensively in case labels change later.
const INVALID_NODE_CHARS = new Set('$?:*"/\\<>|;#%&'.split(''));

function sanitizeNodeName(name) {
  const cleaned = [...name].filter((ch) => !INVALID_NODE_CHARS.has(ch)).join('');
  return cleaned.split(/\s+/).filter(Boolean).join(' '); // collapse whitespace, trim ends
}

// Different ADO process templates name Epic states differently
// (Scrum: New/In Progress/Done, Agile: New/Active/Resolved/Closed,
// Basic: To Do/Doing/Done). MOCK_EPICS/MOCK_THEMES below are written in
// Scrum-style canonical names; STATE_SYNONYMS maps each canonical name to
// the candidate real names we'll look for, in priority order. State names
// can differ per-project (different process templates), so the resolved
// mapping is cached per project, not globally.
const STATE_SYNONYMS = {
  'New': ['New', 'To Do', 'Proposed', 'Backlog'],
  'In Progress': ['In Progress', 'Active', 'Doing', 'Committed'],
  'Done': ['Done', 'Closed', 'Resolved', 'Completed'],
};

// Strategic Themes — one level above workstream epics, Tree-view only, no
// dependsOn/dates/pct of their own. `color` mirrors what fetch_epics.js
// would otherwise have to invent, so the mock data matches a real fetch.
const MOCK_THEMES = [
  { id: 'T1', title: 'Cloud & Platform Modernization', project: 'BDM', color: '#5B9BD5' },
  { id: 'T2', title: 'Customer & Digital Experience', project: 'BDM', color: '#C97C7C' },
  { id: 'T3', title: 'Reporting, Compliance & Decommissioning', project: 'BDM', color: '#A0C878' },
];

// Same shape as the original epic-network.html mock data, plus `project`
// (which of the PROJECTS this epic is seeded into) and `parent` (which
// Strategic Theme it rolls up under). Several of these dependsOn/parent
// links now cross project boundaries on purpose, e.g. E3 (BDM2) depends on
// E1 (BDM), E7 (DECD) depends on E2 (BDM) — that's the whole point of the
// multi-project structure, and fetch_epics.js/app.js are built to follow it.
// `tags` are extra descriptive tags beyond the 'key epic'/'Blocked' ones
// createEpic() always adds — mirrors the same enrichment applied to the
// local epics.json test data (same titles, same tags) so a real seed+fetch
// round trip through an actual ADO org gives the Tag filter real substance
// too, not just the hand-authored test file. E14 deliberately has none, to
// exercise the "Untagged" bucket; E8/E9 deliberately carry two tags each,
// to exercise OR-match when only one of several tags is toggled off.
const MOCK_EPICS = [
  { id: 'E1', title: 'Cloud Landing Zone Setup', ws: 'PLAT', project: 'BDM', parent: 'T1', state: 'Done', pct: 100, blocked: false, tags: ['Foundational'], start: '2026-01-05', target: '2026-02-04', dependsOn: [] },
  { id: 'E2', title: 'Identity & Access Platform', ws: 'PLAT', project: 'BDM', parent: 'T1', state: 'Done', pct: 100, blocked: false, tags: ['Security'], start: '2026-02-04', target: '2026-03-01', dependsOn: ['E1'] },
  { id: 'E3', title: 'Data Platform Foundations', ws: 'DATA', project: 'BDM2', parent: 'T1', state: 'Done', pct: 100, blocked: false, tags: ['Foundational'], start: '2026-02-04', target: '2026-03-11', dependsOn: ['E1'] },
  { id: 'E4', title: 'Legacy Data Extraction', ws: 'DATA', project: 'BDM2', parent: 'T1', state: 'In Progress', pct: 88, blocked: false, tags: ['Legacy'], start: '2026-03-11', target: '2026-04-20', dependsOn: ['E3'] },
  { id: 'E5', title: 'Data Migration — Wave 1', ws: 'DATA', project: 'BDM2', parent: 'T1', state: 'In Progress', pct: 60, blocked: false, tags: ['Migration Wave 1'], start: '2026-04-20', target: '2026-06-04', dependsOn: ['E4'] },
  { id: 'E6', title: 'Data Migration — Wave 2', ws: 'DATA', project: 'BDM2', parent: 'T1', state: 'In Progress', pct: 20, blocked: true, tags: ['Migration Wave 2'], start: '2026-06-04', target: '2026-07-09', dependsOn: ['E5'] },
  { id: 'E7', title: 'Portal Design System', ws: 'PORT', project: 'DECD', parent: 'T2', state: 'Done', pct: 100, blocked: false, tags: ['Customer Facing'], start: '2026-03-01', target: '2026-03-21', dependsOn: ['E2'] },
  { id: 'E8', title: 'Customer Portal MVP', ws: 'PORT', project: 'DECD', parent: 'T2', state: 'In Progress', pct: 45, blocked: false, tags: ['Customer Facing', 'Executive Visibility'], start: '2026-06-04', target: '2026-07-04', dependsOn: ['E7', 'E5'] },
  { id: 'E9', title: 'Customer Portal GA', ws: 'PORT', project: 'DECD', parent: 'T2', state: 'New', pct: 0, blocked: false, tags: ['Customer Facing', 'Executive Visibility'], start: '2026-07-04', target: '2026-07-29', dependsOn: ['E8'] },
  { id: 'E10', title: 'Payments Gateway Integration', ws: 'PAY', project: 'BAD', parent: 'T2', state: 'Done', pct: 100, blocked: false, tags: ['Regulatory'], start: '2026-03-01', target: '2026-03-21', dependsOn: ['E2'] },
  { id: 'E11', title: 'Payments Reconciliation Engine', ws: 'PAY', project: 'BAD', parent: 'T2', state: 'In Progress', pct: 35, blocked: false, tags: ['Regulatory'], start: '2026-06-04', target: '2026-07-04', dependsOn: ['E10', 'E5'] },
  { id: 'E12', title: 'Payments Go-Live', ws: 'PAY', project: 'BAD', parent: 'T2', state: 'New', pct: 0, blocked: false, tags: ['Regulatory', 'Customer Facing'], start: '2026-07-04', target: '2026-07-24', dependsOn: ['E11'] },
  { id: 'E13', title: 'Reporting Data Warehouse', ws: 'RPT', project: 'TPLAT', parent: 'T3', state: 'In Progress', pct: 50, blocked: false, tags: ['Foundational'], start: '2026-06-04', target: '2026-06-29', dependsOn: ['E5'] },
  { id: 'E14', title: 'Executive Dashboards', ws: 'RPT', project: 'TPLAT', parent: 'T3', state: 'New', pct: 0, blocked: false, tags: [], start: '2026-06-29', target: '2026-07-19', dependsOn: ['E13'] },
  { id: 'E15', title: 'Legacy System Freeze', ws: 'DEC', project: 'TPLAT', parent: 'T3', state: 'New', pct: 0, blocked: false, tags: ['Legacy'], start: '2026-07-24', target: '2026-08-08', dependsOn: ['E6', 'E12'] },
  { id: 'E16', title: 'Legacy Decommission', ws: 'DEC', project: 'TPLAT', parent: 'T3', state: 'New', pct: 0, blocked: false, tags: ['Legacy'], start: '2026-08-08', target: '2026-08-28', dependsOn: ['E15'] },
  { id: 'E17', title: 'Non-Prod Environment Hardening', ws: 'PLAT', project: 'BDM', parent: 'T1', state: 'New', pct: 0, blocked: false, tags: ['Security'], start: '2026-02-04', target: '2026-02-19', dependsOn: ['E1'] },
  { id: 'E18', title: 'Regulatory Reporting Pack', ws: 'RPT', project: 'TPLAT', parent: 'T3', state: 'In Progress', pct: 30, blocked: false, tags: ['Regulatory'], start: '2026-06-29', target: '2026-07-14', dependsOn: ['E13'] },

  // E19+ — deliberately exercises fetch_epics.js's multi-project hierarchy
  // handling: `parent` below points at another *Epic* (not just a Strategic
  // Theme), and several of these sub-epics live in a different ADO project
  // than their parent. That's the case fetch_epics.js's extractRelations()/
  // droppedParents logic is built for — a Hierarchy-Reverse link whose
  // target is an Epic in a project outside the fetched set gets dropped
  // with a warning; inside the set (even cross-project) it's kept. E29/E30
  // are plain extra siblings under T1/T2 (more items directly under a
  // parent, no extra depth).
  { id: 'E19', title: 'Wave 1 — Schema Mapping', ws: 'DATA', project: 'BDM2', parent: 'E5', state: 'In Progress', pct: 55, blocked: false, tags: [], start: '2026-04-20', target: '2026-05-12', dependsOn: [] },
  { id: 'E20', title: 'Wave 1 — Data Validation', ws: 'DATA', project: 'BDM2', parent: 'E5', state: 'New', pct: 0, blocked: false, tags: [], start: '2026-05-12', target: '2026-06-04', dependsOn: ['E19'] },
  { id: 'E21', title: 'Schema Mapping — Field Crosswalk QA', ws: 'DATA', project: 'TPLAT', parent: 'E19', state: 'New', pct: 25, blocked: false, tags: [], start: '2026-04-20', target: '2026-05-12', dependsOn: [] },
  { id: 'E22', title: 'Portal MVP — Auth Flow', ws: 'PORT', project: 'DECD', parent: 'E8', state: 'In Progress', pct: 40, blocked: false, tags: [], start: '2026-06-04', target: '2026-06-19', dependsOn: [] },
  { id: 'E23', title: 'Portal MVP — Account Dashboard', ws: 'PORT', project: 'DECD', parent: 'E8', state: 'New', pct: 0, blocked: false, tags: [], start: '2026-06-19', target: '2026-07-04', dependsOn: ['E22'] },
  { id: 'E24', title: 'Auth Flow — MFA Enrollment', ws: 'PORT', project: 'BAD', parent: 'E22', state: 'New', pct: 10, blocked: false, tags: [], start: '2026-06-04', target: '2026-06-19', dependsOn: [] },
  { id: 'E25', title: 'Reconciliation — Matching Engine', ws: 'PAY', project: 'BAD', parent: 'E11', state: 'In Progress', pct: 35, blocked: false, tags: [], start: '2026-06-04', target: '2026-06-19', dependsOn: [] },
  { id: 'E26', title: 'Reconciliation — Exception Handling', ws: 'PAY', project: 'BAD', parent: 'E11', state: 'New', pct: 0, blocked: false, tags: [], start: '2026-06-19', target: '2026-07-04', dependsOn: ['E25'] },
  { id: 'E27', title: 'DW — Ingestion Pipeline', ws: 'RPT', project: 'TPLAT', parent: 'E13', state: 'In Progress', pct: 45, blocked: false, tags: [], start: '2026-06-04', target: '2026-06-17', dependsOn: [] },
  { id: 'E28', title: 'DW — Star Schema Design', ws: 'RPT', project: 'TPLAT', parent: 'E13', state: 'New', pct: 0, blocked: false, tags: [], start: '2026-06-17', target: '2026-06-29', dependsOn: ['E27'] },
  { id: 'E29', title: 'Platform Observability Rollout', ws: 'PLAT', project: 'BDM', parent: 'T1', state: 'New', pct: 0, blocked: false, tags: ['Foundational'], start: '2026-02-19', target: '2026-03-11', dependsOn: ['E2'] },
  { id: 'E30', title: 'Customer Support Tooling', ws: 'PORT', project: 'DECD', parent: 'T2', state: 'New', pct: 0, blocked: false, tags: ['Customer Facing'], start: '2026-03-21', target: '2026-04-15', dependsOn: ['E7'] },
];

class AdoClient {
  constructor(org, pat, dryRun = true) {
    this.org = org;
    this.dryRun = dryRun;
    this.authHeader = 'Basic ' + Buffer.from(`:${pat}`).toString('base64');
    this._stateMaps = new Map(); // project -> canonical -> real state name
  }

  projectBase(project) { return `https://dev.azure.com/${this.org}/${encodeURIComponent(project)}/_apis`; }
  // Work item read/update/link endpoints also work at the org level and
  // don't require knowing which project an id lives in — used for anything
  // that might reach across a project boundary (dependency/hierarchy links).
  orgBase() { return `https://dev.azure.com/${this.org}/_apis`; }

  // ---- state name mapping (per project — process templates can differ) ----
  async getEpicStateMap(project) {
    if (this._stateMaps.has(project)) return this._stateMaps.get(project);
    if (this.dryRun) {
      const identity = Object.fromEntries(Object.keys(STATE_SYNONYMS).map((k) => [k, k]));
      this._stateMaps.set(project, identity);
      return identity;
    }
    const url = `${this.projectBase(adoProjectName(project))}/wit/workitemtypes/Epic/states?api-version=${API_VERSION}`;
    const result = await this._request('GET', url);
    const realNames = (result.value || []).map((s) => s.name);
    const realLower = new Map(realNames.map((n) => [n.toLowerCase(), n]));
    const mapping = {};
    for (const [canonical, candidates] of Object.entries(STATE_SYNONYMS)) {
      const match = candidates.map((c) => realLower.get(c.toLowerCase())).find(Boolean);
      if (!match) {
        throw new Error(`Can't map canonical state '${canonical}' to any of ${project}'s Epic `
          + `states ${JSON.stringify(realNames)}. Edit STATE_SYNONYMS in seed_ado_epics.js.`);
      }
      mapping[canonical] = match;
    }
    console.log(`  [${project}] State mapping: ${JSON.stringify(mapping)}`);
    this._stateMaps.set(project, mapping);
    return mapping;
  }

  async _request(method, url, body, contentType = 'application/json') {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        'Content-Type': contentType,
        Accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${url} -> ${res.status}: ${text}`);
    }
    return text ? JSON.parse(text) : {};
  }

  // ---- area paths ----
  // `project` is our short display code (e.g. TPLAT) — resolved to the
  // literal ADO project name for the actual API call.
  async ensureAreaPath(project, name) {
    const adoName = adoProjectName(project);
    const cleanName = sanitizeNodeName(name);
    const url = `${this.projectBase(adoName)}/wit/classificationnodes/Areas?api-version=${API_VERSION}`;
    if (this.dryRun) {
      console.log(`  [dry-run] would ensure Area Path exists: ${adoName}\\${cleanName}`);
      return;
    }
    try {
      await this._request('POST', url, { name: cleanName });
      console.log(`  created Area Path: ${adoName}\\${cleanName}`);
    } catch (err) {
      const msg = String(err.message).toLowerCase();
      if (msg.includes('already exists') || msg.includes('duplicatename') || msg.includes('already in use')) {
        console.log(`  Area Path already exists: ${adoName}\\${cleanName}`);
      } else {
        throw err;
      }
    }
  }

  // ---- lookup for idempotency ----
  async findEpicByTitle(project, title) {
    if (this.dryRun) return null;
    const adoName = adoProjectName(project);
    const url = `${this.orgBase()}/wit/wiql?api-version=${API_VERSION}`;
    const titleEscaped = title.replace(/'/g, "''");
    const projectEscaped = adoName.replace(/'/g, "''");
    const query = {
      query: (
        'SELECT [System.Id] FROM WorkItems WHERE '
        + "[System.WorkItemType]='Epic' AND "
        + `[System.TeamProject]='${projectEscaped}' AND `
        + `[System.Title]='${titleEscaped}'`
      ),
    };
    const result = await this._request('POST', url, query);
    const items = result.workItems || [];
    return items.length ? items[0].id : null;
  }

  // ---- create epic or theme (ws === null -> Strategic Theme, no Area Path) ----
  async createEpic(item) {
    const adoName = adoProjectName(item.project);
    const areaPath = item.ws ? `${adoName}\\${sanitizeNodeName(WORKSTREAMS[item.ws])}` : null;
    const tags = [item.isTheme ? 'programme theme' : 'key epic', item.blocked ? 'Blocked' : null, ...(item.tags || [])]
      .filter(Boolean).join('; ');
    const stateMap = await this.getEpicStateMap(item.project);
    const initialState = stateMap['New'];
    // Strategic Themes (MOCK_THEMES) have no `state` of their own — they
    // aren't scheduled work, so they just stay wherever the workflow starts
    // (matches epics.json, which always has themes at "New").
    const targetState = item.isTheme ? initialState : stateMap[item.state];

    // ADO's $Epic *creation* endpoint only accepts the workflow's initial
    // state (e.g. "New") in System.State — anything else (e.g. "Closed")
    // is rejected as "not in the list of supported values" even though
    // it's a perfectly valid state for an update. So create at the
    // initial state, then move it with a follow-up PATCH if needed.
    const doc = [
      { op: 'add', path: '/fields/System.Title', value: item.title },
      { op: 'add', path: '/fields/System.Tags', value: tags },
    ];
    if (areaPath) doc.push({ op: 'add', path: '/fields/System.AreaPath', value: areaPath });
    if (item.start) doc.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StartDate', value: item.start });
    if (item.target) doc.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.TargetDate', value: item.target });
    if (item.pct !== undefined && item.pct !== null) {
      doc.push({ op: 'add', path: '/fields/System.Description', value: `Progress: ${item.pct}% complete (seeded mock data)` });
    }

    const url = `${this.projectBase(adoName)}/wit/workitems/$Epic?api-version=${API_VERSION}`;
    if (this.dryRun) {
      console.log(`  [dry-run] would create ${item.isTheme ? 'Strategic Theme' : 'Epic'} '${item.title}' `
        + `in ${adoName}${areaPath ? ` (${areaPath})` : ''} (state ${initialState} -> ${targetState})`);
      return { id: `DRYRUN-${item.id}`, url: null };
    }
    const result = await this._request('PATCH', url, doc, 'application/json-patch+json');
    console.log(`  created [${item.project}] #${result.id}: ${item.title}`);

    if (targetState !== initialState) {
      await this._setState(result.id, targetState);
    }
    return result;
  }

  async _setState(workItemId, state) {
    const url = `${this.orgBase()}/wit/workitems/${workItemId}?api-version=${API_VERSION}`;
    const doc = [{ op: 'add', path: '/fields/System.State', value: state }];
    try {
      await this._request('PATCH', url, doc, 'application/json-patch+json');
      console.log(`    -> set State: ${state}`);
    } catch (err) {
      console.log(`    WARNING: created #${workItemId} but couldn't set State to `
        + `'${state}' (left at initial state). You may need to set it manually, `
        + `or the process may require an intermediate transition / a Reason `
        + `field. Error: ${err.message}`);
    }
  }

  // ---- link a dependency or hierarchy relation (org-level: works across projects) ----
  async addLink(dependentId, targetId, targetUrl, relType, comment) {
    const doc = [{
      op: 'add',
      path: '/relations/-',
      value: { rel: relType, url: targetUrl, attributes: { comment } },
    }];
    const url = `${this.orgBase()}/wit/workitems/${dependentId}?api-version=${API_VERSION}`;
    if (this.dryRun) {
      console.log(`  [dry-run] would link #${dependentId} (${relType}) -> #${targetId}`);
      return;
    }
    await this._request('PATCH', url, doc, 'application/json-patch+json');
    console.log(`  linked #${dependentId} (${relType}) -> #${targetId}`);
  }
}

function parseArgs(argv) {
  const args = {
    apply: false,
    skipAreaPaths: false,
    org: process.env.ADO_ORG,
    pat: process.env.ADO_PAT,
    out: null, // resolved below once we know --apply, unless explicitly overridden
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--skip-area-paths') args.skipAreaPaths = true;
    else if (a === '--org') args.org = argv[++i];
    else if (a === '--pat') args.pat = argv[++i];
    else if (a === '--out') args.out = argv[++i];
  }
  // A dry run writes placeholder "DRYRUN-*" ids — defaulting its output to
  // the same file --apply uses would silently clobber a real id map from a
  // previous --apply run with those placeholders. Only --apply (or an
  // explicit --out) touches ado_id_map.json.
  if (!args.out) args.out = args.apply ? 'ado_id_map.json' : 'ado_id_map.dry-run.json';
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.org || !args.pat) {
    console.error('Missing config. Set ADO_ORG, ADO_PAT (env vars or --org/--pat). '
      + 'The target projects are the keys of PROJECTS in this script (BDM, BAD, DECD, BDM2, TPLAT) '
      + 'and must already exist in the org.');
    process.exit(1);
  }

  const dryRun = !args.apply;
  const client = new AdoClient(args.org, args.pat, dryRun);
  const allItems = [...MOCK_THEMES.map((t) => ({ ...t, isTheme: true })), ...MOCK_EPICS.map((e) => ({ ...e, isTheme: false }))];

  console.log(`${dryRun ? 'DRY RUN — ' : ''}Target: https://dev.azure.com/${args.org} `
    + `(projects: ${Object.keys(PROJECTS).join(', ')})\n`);

  if (!args.skipAreaPaths) {
    console.log('Step 1/4 — Area Paths');
    const seen = new Set();
    for (const epic of MOCK_EPICS) {
      const key = `${epic.project} ${epic.ws}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await client.ensureAreaPath(epic.project, WORKSTREAMS[epic.ws]);
    }
    console.log();
  }

  console.log('Step 2/4 — Strategic Themes + Epics');
  const idMap = {};
  for (const item of allItems) {
    const existingId = await client.findEpicByTitle(item.project, item.title);
    if (existingId) {
      console.log(`  skipping (already exists) [${item.project}] #${existingId}: ${item.title}`);
      idMap[item.id] = {
        id: existingId,
        project: item.project,
        url: `https://dev.azure.com/${args.org}/${encodeURIComponent(adoProjectName(item.project))}/_apis/wit/workItems/${existingId}`,
      };
      continue;
    }
    const result = await client.createEpic(item);
    idMap[item.id] = { id: result.id, project: item.project, url: result.url };
  }
  console.log();

  console.log('Step 3/4 — Dependency links');
  for (const epic of MOCK_EPICS) {
    if (!epic.dependsOn.length) continue;
    const dependent = idMap[epic.id];
    for (const depMockId of epic.dependsOn) {
      const predecessor = idMap[depMockId];
      await client.addLink(dependent.id, predecessor.id, predecessor.url || '',
        'System.LinkTypes.Dependency-Reverse', 'Predecessor per programme plan (seeded)');
    }
  }
  console.log();

  console.log('Step 4/4 — Parent (Strategic Theme) links');
  for (const epic of MOCK_EPICS) {
    if (!epic.parent) continue;
    const dependent = idMap[epic.id];
    const theme = idMap[epic.parent];
    await client.addLink(dependent.id, theme.id, theme.url || '',
      'System.LinkTypes.Hierarchy-Reverse', 'Strategic theme per programme plan (seeded)');
  }
  console.log();

  fs.writeFileSync(args.out, JSON.stringify(idMap, null, 2));
  console.log(`Mapping written to ${args.out}${dryRun ? ' (dry-run — ids are placeholders)' : ''}`);

  if (dryRun) {
    console.log('\nThis was a dry run — nothing was written to ADO. Re-run with --apply to create the work items.');
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
