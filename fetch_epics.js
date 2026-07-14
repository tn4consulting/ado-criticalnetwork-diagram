#!/usr/bin/env node
/**
 * fetch_epics.js
 * --------------
 * Pulls Epic work items out of Azure DevOps and writes them to epics.json in
 * the shape the visualizer (src/index.html + src/app.js, or the bundled
 * epic-network.html) expects. This is step 1 of the two-step pipeline:
 *
 *   fetch_epics.js  -->  epics.json  -->  build.js  -->  epic-network.html
 *   (download from ADO)   (data file)    (bundle)       (shareable standalone file)
 *
 * For local iteration you can also skip build.js and open src/index.html via
 * a local web server (it fetches ./epics.json directly), e.g.
 *   npx http-server src -p 8080
 *
 * WHY THIS RUNS LOCALLY, NOT INSIDE CLAUDE
 * Claude's sandbox has no outbound network access and there's no Azure
 * DevOps connector configured, so it can't call dev.azure.com directly. Run
 * this on your own machine (or a CI runner) with your own PAT. Requires
 * Node 18+ (uses the built-in fetch()) and no npm dependencies.
 *
 * MULTI-PROJECT PROGRAMMES
 * A programme's Epics are rarely all in one ADO project — typically there's
 * a top-level programme project (Strategic Themes, shared platform epics)
 * plus several product projects underneath it. This script queries every
 * project you pass it and merges the results into a single epics.json, all
 * via ADO's *organization*-level WIQL/work item endpoints (no per-project
 * base URL needed — Epic ids are unique across the whole org). Because the
 * merge happens before dependsOn/parentId are resolved, a link that crosses
 * project boundaries (e.g. a product epic's parentId pointing at a Strategic
 * Theme that lives in the programme project) is preserved exactly like an
 * in-project one — see PROJECT_TREE below for how the project hierarchy
 * itself gets described (ADO has no native concept of it).
 *
 * WHAT IT PULLS PER EPIC
 *   System.Title                          -> title
 *   System.AreaPath (leaf segment)        -> workstream key/label
 *   System.State                          -> state (canonicalized to
 *                                             New / In Progress / Done)
 *   System.Tags                           -> tags (raw, semicolon-split) and
 *                                             blocked = "Blocked" tag present
 *   Microsoft.VSTS.Scheduling.StartDate   -> startDate
 *   Microsoft.VSTS.Scheduling.TargetDate  -> targetDate
 *   System.LinkTypes.Dependency-Reverse   -> dependsOn (predecessor epic ids)
 *   System.LinkTypes.Hierarchy-Reverse    -> parentId (parent Epic id, e.g.
 *                                            a Strategic Theme or Programme
 *                                            Epic — kept as long as the
 *                                            parent is itself an Epic in the
 *                                            combined multi-project fetch
 *                                            set, even if it's in a
 *                                            different ADO project)
 *   (the ADO project it was queried from) -> project
 *
 * WHICH EPICS ACTUALLY SHOW UP IN THE TOOL
 *   This script fetches and writes every Epic the WIQL query returns, but
 *   the frontend (app.js) is the one that decides what's in scope, purely
 *   from System.Tags:
 *     "key epic"        -> a real workstream epic (Network/Gantt/Tree)
 *     "programme theme" -> a Strategic Theme (Tree view only, one level
 *                          above workstream epics; also gets a generated
 *                          `color` field here since ADO has no color concept)
 *     (neither)          -> dropped by the frontend, not part of this
 *                           programme (e.g. old unrelated prototype work)
 *   Tag your Epics in ADO accordingly — nothing here enforces it.
 *
 * PERCENT COMPLETE
 *   Epics don't have a standard rollup field, so this script computes one:
 *   for each epic, it looks at direct child work items (System.LinkTypes.
 *   Hierarchy-Forward) and computes (children in a "done" state) / (total
 *   children) * 100. Epics with no children fall back to 100% if the epic
 *   itself is Done, else 0%.
 *
 * SETUP
 *   export ADO_ORG=your-org            # https://dev.azure.com/<ADO_ORG>
 *   export ADO_PROJECTS="bdm"          # comma-separated; a single project is fine
 *   export ADO_PAT=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *
 *   PAT scope required: Work Items (Read).
 *
 *   Any project you pass just works — you don't need to touch this file for
 *   a single-project fetch. Only edit PROJECT_TREE below if you want a real
 *   multi-project programme hierarchy (Tree view breadcrumb, project filter
 *   chips grouped under a shared root) instead of every project showing as
 *   its own standalone root. Each entry's `adoProject` is the literal ADO
 *   project name to query (only needs to differ from the short code when
 *   the two aren't the same string, e.g. TPLAT -> "Technology Platform").
 *
 * USAGE
 *   node fetch_epics.js                                # ADO_PROJECTS env, writes epics.json
 *   node fetch_epics.js --project BDM --project BAD     # repeatable flag instead of env
 *   node fetch_epics.js --out custom/path.json
 *   npm run fetch
 */

import fs from 'node:fs';
import path from 'node:path';

const API_VERSION = '7.1';

// Describes how the ADO projects that make up this programme nest under the
// top-level programme project. ADO itself has no cross-project hierarchy
// concept, so this is hand-maintained — keep it in sync with reality.
// `label` is what the UI shows. The key is our short display/filter code —
// pass it to --project / ADO_PROJECTS. `adoProject` is the *literal* ADO
// project name to query — it only needs to differ from the key when the
// short code isn't itself a real ADO project name (e.g. TPLAT here is our
// code for the "Technology Platform" ADO project).
const PROJECT_TREE = {
  BDM: { label: 'BDM', parent: null, adoProject: 'BDM' },
  BAD: { label: 'Benefit Delivery', parent: 'BDM', adoProject: 'BAD' },
  DECD: { label: 'Digital', parent: 'BDM', adoProject: 'DECD' },
  BDM2: { label: 'Common Platform', parent: 'BDM', adoProject: 'BDM2' },
  TPLAT: { label: 'Technology Platform', parent: 'BDM', adoProject: 'Technology Platform' },
};

// Any project you pass that isn't already in PROJECT_TREE above still works
// — it's auto-registered as a standalone root (its own label, no parent),
// so a single-project fetch (the common case) never needs this file edited
// first. Edit PROJECT_TREE yourself only when you want a real multi-project
// breadcrumb/hierarchy in the Tree view.
function resolveProjectTree(projects) {
  const tree = { ...PROJECT_TREE };
  const autoRegistered = [];
  for (const code of projects) {
    if (!tree[code]) {
      tree[code] = { label: code, parent: null, adoProject: code };
      autoRegistered.push(code);
    }
  }
  if (autoRegistered.length) {
    console.log(`  ${autoRegistered.join(', ')} not in PROJECT_TREE — treating as standalone root project(s). `
      + `Edit PROJECT_TREE in fetch_epics.js if you want a real programme hierarchy/breadcrumb for them.`);
  }
  return tree;
}

function adoProjectName(code, tree) { return (tree[code] && tree[code].adoProject) || code; }

// Same canonical buckets the visualizer's statusClass() expects. Different
// ADO process templates name Epic states differently (Scrum: New/In
// Progress/Done, Agile: New/Active/Resolved/Closed, Basic: To Do/Doing/
// Done) — map whatever comes back onto one of these three.
const STATE_BUCKETS = {
  'New': 'New', 'To Do': 'New', 'Proposed': 'New', 'Backlog': 'New',
  'In Progress': 'In Progress', 'Active': 'In Progress', 'Doing': 'In Progress', 'Committed': 'In Progress',
  'Done': 'Done', 'Closed': 'Done', 'Resolved': 'Done', 'Completed': 'Done',
};

// States that count as "finished" when rolling up child work item completion.
const DONE_CHILD_STATES = new Set(['done', 'closed', 'resolved', 'completed']);

// Cycled deterministically across distinct workstreams (Area Path leaves)
// found in the data — ADO has no concept of a workstream "color".
const PALETTE = [
  '#7C9CBF', '#C98A4B', '#8E7CC3', '#4FB0A5', '#B3B25A', '#8A8F98',
  '#D97757', '#5B9BD5', '#A0C878', '#C97C7C', '#7CC9BE', '#B08CC9',
];

function canonicalState(rawState) {
  const bucket = STATE_BUCKETS[rawState];
  if (!bucket) {
    console.warn(`  WARNING: unrecognized Epic state '${rawState}', bucketing as 'In Progress'. `
      + `Edit STATE_BUCKETS in fetch_epics.js to map it properly.`);
    return 'In Progress';
  }
  return bucket;
}

function wsKeyFor(areaPath, project) {
  // Area Path looks like "Project\Sub\Leaf" — the leaf segment is the workstream.
  const parts = (areaPath || '').split('\\');
  let leaf = parts.length ? parts[parts.length - 1] : areaPath;
  if (leaf === project) leaf = 'General';
  return leaf;
}

// Single organization-scoped client — Epic ids are unique across the whole
// ADO org, so once we have ids (from a per-project WIQL query) every
// subsequent lookup (full work item fetch, child state rollup) can hit the
// org-level endpoints regardless of which project an id actually lives in.
// This is what makes merging multiple projects' epics, and preserving the
// dependsOn/parentId links between them, straightforward.
class AdoClient {
  constructor(org, pat) {
    this.org = org;
    this.base = `https://dev.azure.com/${org}/_apis`;
    this.authHeader = 'Basic ' + Buffer.from(`:${pat}`).toString('base64');
  }

  async _request(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
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

  async queryEpicIds(project) {
    const url = `${this.base}/wit/wiql?api-version=${API_VERSION}`;
    const projectEscaped = project.replace(/'/g, "''");
    const query = {
      query: (
        'SELECT [System.Id] FROM WorkItems WHERE '
        + `[System.TeamProject]='${projectEscaped}' AND `
        + "[System.WorkItemType]='Epic' "
        + 'ORDER BY [System.Id]'
      ),
    };
    const result = await this._request('POST', url, query);
    return (result.workItems || []).map((item) => item.id);
  }

  /** GET .../wit/workitems?ids=...  in batches of <=200, optionally with relations. */
  async getWorkItems(ids, { fields, expandRelations = false } = {}) {
    if (!ids.length) return [];
    const items = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const params = new URLSearchParams({ ids: chunk.join(','), 'api-version': API_VERSION });
      if (expandRelations) {
        // ADO rejects $expand combined with fields ("ConflictingParametersException") —
        // fetch full field set instead and just pick out what we need below.
        params.set('$expand', 'relations');
      } else if (fields) {
        params.set('fields', fields.join(','));
      }
      const url = `${this.base}/wit/workitems?${params.toString()}`;
      const result = await this._request('GET', url);
      items.push(...(result.value || []));
    }
    return items;
  }
}

function extractRelations(relations) {
  const predecessorIds = [];
  const childIds = [];
  let parentId = null;
  for (const rel of relations || []) {
    const relType = rel.rel;
    const url = rel.url || '';
    const targetId = parseInt(url.replace(/\/+$/, '').split('/').pop(), 10);
    if (Number.isNaN(targetId)) continue;
    if (relType === 'System.LinkTypes.Dependency-Reverse') predecessorIds.push(targetId);
    else if (relType === 'System.LinkTypes.Hierarchy-Forward') childIds.push(targetId);
    // Hierarchy-Reverse = "this work item's parent" — an Epic normally has at
    // most one, so the first hit wins. This is how Programme-level Epics
    // (with Workstream Epics nested under them, possibly in another
    // project) are represented in ADO.
    else if (relType === 'System.LinkTypes.Hierarchy-Reverse' && parentId === null) parentId = targetId;
  }
  return { predecessorIds, childIds, parentId };
}

function parseArgs(argv) {
  const envProjects = (process.env.ADO_PROJECTS || process.env.ADO_PROJECT || '')
    .split(',').map((p) => p.trim()).filter(Boolean);
  const args = { org: process.env.ADO_ORG, projects: envProjects, pat: process.env.ADO_PAT, out: 'epics.json' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--org') args.org = argv[++i];
    else if (a === '--project') args.projects.push(argv[++i]);
    else if (a === '--pat') args.pat = argv[++i];
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

// Walk PROJECT_TREE parent pointers so an ancestor project that wasn't
// explicitly fetched (e.g. the programme project, if you only passed the
// product projects) still ends up in the output `projects` block — the Tree
// view breadcrumb needs the whole chain, not just the leaves. Only `label`/
// `parent` are emitted — `adoProject` is an internal fetch-time detail the
// frontend has no use for.
function projectTreeClosure(projects, tree) {
  const out = {};
  const add = (code) => {
    if (out[code] || !tree[code]) return;
    out[code] = { label: tree[code].label, parent: tree[code].parent };
    if (tree[code].parent) add(tree[code].parent);
  };
  projects.forEach(add);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.org || !args.projects.length || !args.pat) {
    console.error('Missing config. Set ADO_ORG, ADO_PROJECTS (comma-separated), ADO_PAT '
      + '(env vars, or --org/--project (repeatable)/--pat).');
    process.exit(1);
  }
  const tree = resolveProjectTree(args.projects);

  const client = new AdoClient(args.org, args.pat);

  console.log(`Querying Epics in https://dev.azure.com/${args.org} across ${args.projects.length} `
    + `project(s): ${args.projects.join(', ')} ...`);
  const idToProject = new Map();
  for (const project of args.projects) {
    const ids = await client.queryEpicIds(adoProjectName(project, tree));
    console.log(`  ${project}: found ${ids.length} epics`);
    ids.forEach((id) => idToProject.set(id, project));
  }
  const epicIds = [...idToProject.keys()];
  if (!epicIds.length) {
    console.error('No Epics found in any of the given projects.');
    process.exit(1);
  }

  const rawEpics = await client.getWorkItems(epicIds, { expandRelations: true });
  const epicIdSet = new Set(epicIds);

  console.log('Resolving child work items for % complete rollup ...');
  const parsed = new Map();
  const allChildIds = new Set();
  let droppedParents = 0;
  for (const item of rawEpics) {
    const wid = item.id;
    const f = item.fields;
    const project = idToProject.get(wid);
    const { predecessorIds, childIds, parentId } = extractRelations(item.relations);
    // Only keep a parent link if the parent is itself an Epic somewhere in
    // the combined multi-project fetch set — a parent of a different work
    // item type, or in a project we didn't fetch, can't be rendered, so
    // drop it rather than pointing the tree view at an id it knows nothing
    // about. (A parent in a *different fetched* project is fine and kept.)
    if (parentId !== null && !epicIdSet.has(parentId)) droppedParents += 1;
    const tags = (f['System.Tags'] || '').split(';').map((t) => t.trim()).filter(Boolean);
    parsed.set(wid, {
      id: String(wid),
      title: f['System.Title'] || `Epic ${wid}`,
      ws: wsKeyFor(f['System.AreaPath'], adoProjectName(project, tree)),
      project,
      state: canonicalState(f['System.State'] || 'New'),
      blocked: tags.some((t) => t.toLowerCase() === 'blocked'),
      tags,
      startDate: f['Microsoft.VSTS.Scheduling.StartDate'] || null,
      targetDate: f['Microsoft.VSTS.Scheduling.TargetDate'] || null,
      // keep only predecessors that are also Epics in the combined fetch set
      dependsOn: predecessorIds.filter((p) => epicIdSet.has(p)).map(String),
      parentId: (parentId !== null && epicIdSet.has(parentId)) ? String(parentId) : null,
      _childIds: childIds,
    });
    childIds.forEach((c) => allChildIds.add(c));
  }

  if (droppedParents) {
    console.log(`  ${droppedParents} epic(s) have a parent work item outside the fetched project set `
      + `(different type, or a project not passed to this script) — they'll show as top-level in the tree view.`);
  }

  const childStates = new Map();
  if (allChildIds.size) {
    const childItems = await client.getWorkItems([...allChildIds], { fields: ['System.State'] });
    for (const c of childItems) {
      childStates.set(c.id, c.fields['System.State'] || '');
    }
  }

  const missingDates = [];
  for (const e of parsed.values()) {
    const children = e._childIds;
    delete e._childIds;
    if (children.length) {
      const done = children.filter((c) => DONE_CHILD_STATES.has((childStates.get(c) || '').toLowerCase())).length;
      e.pct = Math.round((done / children.length) * 100);
    } else {
      e.pct = e.state === 'Done' ? 100 : 0;
    }
    if (!e.startDate || !e.targetDate) missingDates.push(e.id);
  }

  if (missingDates.length) {
    console.warn(`  WARNING: ${missingDates.length} epic(s) missing Start/Target dates `
      + `(ids: ${missingDates.join(', ')}). The CPM engine needs both to compute `
      + `duration — set them in ADO or the network/gantt view will fall back to a 1-day duration.`);
  }

  // workstreams: distinct ws keys in the order first seen, colors cycled from
  // PALETTE — derived only from 'key epic'-tagged items, so a theme sitting
  // in some incidental Area Path doesn't produce a stray, empty filter chip.
  const workstreams = {};
  for (const e of parsed.values()) {
    if (!e.tags.some((t) => t.toLowerCase() === 'key epic')) continue;
    if (!workstreams[e.ws]) {
      const color = PALETTE[Object.keys(workstreams).length % PALETTE.length];
      workstreams[e.ws] = { label: e.ws, color };
    }
  }

  // ADO has no concept of a theme "color" — assign one for display, cycling
  // a palette independent of the workstream one so themes read as a
  // distinct tier in the Tree view rather than blending into a workstream.
  let themeCount = 0;
  let keyEpicCount = 0;
  for (const e of parsed.values()) {
    if (e.tags.some((t) => t.toLowerCase() === 'programme theme')) {
      e.color = PALETTE[(PALETTE.length - 1 - themeCount) % PALETTE.length];
      themeCount += 1;
    } else if (e.tags.some((t) => t.toLowerCase() === 'key epic')) {
      keyEpicCount += 1;
    }
  }
  const excludedCount = parsed.size - themeCount - keyEpicCount;
  console.log(`  ${keyEpicCount} 'key epic', ${themeCount} 'programme theme', `
    + `${excludedCount} excluded (missing either tag)`);

  const out = {
    source: {
      org: args.org,
      projects: args.projects,
      generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z',
    },
    projects: projectTreeClosure(args.projects, tree),
    workstreams,
    epics: [...parsed.values()],
  };

  fs.writeFileSync(path.resolve(args.out), JSON.stringify(out, null, 2));
  console.log(`Wrote ${parsed.size} epics to ${args.out}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
