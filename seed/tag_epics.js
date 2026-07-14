#!/usr/bin/env node
/**
 * tag_epics.js
 * ------------
 * Bulk-adds one or more tags to a list of *existing* Azure DevOps work
 * items, without touching anything else on them (title, state, other
 * tags, links — all left exactly as-is; the new tag is merged into
 * whatever System.Tags already has).
 *
 * WHY THIS EXISTS
 * seed/seed_ado_epics.js only tags items it creates — if a work item with that
 * title already exists, it's skipped untouched (see its Step 2 log line
 * "skipping (already exists)"). That leaves no way to retroactively tag
 * epics you created by hand (or before this tool existed) as 'key epic' /
 * 'programme theme', which is what fetch_epics.js / the frontend need to
 * treat them as in-scope. This script is that missing bulk-tag step.
 *
 * WHY THIS RUNS LOCALLY, NOT INSIDE CLAUDE
 * Claude's sandbox has no outbound network access and there's no Azure
 * DevOps connector configured, so it can't call dev.azure.com directly. Run
 * this on your own machine (or a CI runner) with your own PAT. Requires
 * Node 18+ (uses the built-in fetch()) and no npm dependencies.
 *
 * SETUP
 *   export ADO_ORG=your-org
 *   export ADO_PAT=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *
 *   PAT scope required: Work Items (Read, write, & manage).
 *
 * USAGE
 *   node seed/tag_epics.js --ids 191,192,193 --tag "key epic"          # dry run — prints the plan, writes nothing
 *   node seed/tag_epics.js --ids 191,192,193 --tag "key epic" --apply  # actually tags them
 *   node seed/tag_epics.js --ids 191,192 --tag "key epic" --tag "Foundational" --apply   # multiple tags at once
 *   npm run tag -- --ids 191,192,193 --tag "key epic" --apply
 */

const API_VERSION = '7.1';

class AdoClient {
  constructor(org, pat, dryRun) {
    this.org = org;
    this.dryRun = dryRun;
    this.base = `https://dev.azure.com/${org}/_apis`;
    this.authHeader = 'Basic ' + Buffer.from(`:${pat}`).toString('base64');
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

  async getWorkItem(id) {
    const url = `${this.base}/wit/workitems/${id}?fields=System.Title,System.Tags&api-version=${API_VERSION}`;
    return this._request('GET', url);
  }

  async setTags(id, tagsString) {
    const url = `${this.base}/wit/workitems/${id}?api-version=${API_VERSION}`;
    const doc = [{ op: 'add', path: '/fields/System.Tags', value: tagsString }];
    if (this.dryRun) return;
    await this._request('PATCH', url, doc, 'application/json-patch+json');
  }
}

function parseArgs(argv) {
  const args = { org: process.env.ADO_ORG, pat: process.env.ADO_PAT, ids: [], tags: [], apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--org') args.org = argv[++i];
    else if (a === '--pat') args.pat = argv[++i];
    else if (a === '--apply') args.apply = true;
    else if (a === '--ids') args.ids.push(...argv[++i].split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--tag') args.tags.push(argv[++i]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.org || !args.pat || !args.ids.length || !args.tags.length) {
    console.error('Missing config. Set ADO_ORG, ADO_PAT (env vars or --org/--pat), and pass '
      + '--ids <comma-separated work item ids> plus at least one --tag "<name>".');
    process.exit(1);
  }

  const dryRun = !args.apply;
  const client = new AdoClient(args.org, args.pat, dryRun);

  console.log(`${dryRun ? 'DRY RUN — ' : ''}Tagging ${args.ids.length} work item(s) in `
    + `https://dev.azure.com/${args.org} with: ${args.tags.join(', ')}\n`);

  let tagged = 0;
  let alreadyTagged = 0;
  for (const id of args.ids) {
    let item;
    try {
      item = await client.getWorkItem(id);
    } catch (err) {
      console.log(`  #${id}: FAILED to fetch — ${err.message}`);
      continue;
    }
    const existingTags = (item.fields['System.Tags'] || '').split(';').map((t) => t.trim()).filter(Boolean);
    const existingLower = new Set(existingTags.map((t) => t.toLowerCase()));
    const toAdd = args.tags.filter((t) => !existingLower.has(t.toLowerCase()));

    if (!toAdd.length) {
      console.log(`  #${id} "${item.fields['System.Title']}": already has all requested tags, skipping`);
      alreadyTagged += 1;
      continue;
    }

    const merged = [...existingTags, ...toAdd].join('; ');
    if (dryRun) {
      console.log(`  [dry-run] #${id} "${item.fields['System.Title']}": `
        + `"${existingTags.join('; ') || '(none)'}" -> "${merged}"`);
    } else {
      await client.setTags(id, merged);
      console.log(`  #${id} "${item.fields['System.Title']}": tagged -> "${merged}"`);
    }
    tagged += 1;
  }

  console.log(`\n${tagged} tagged, ${alreadyTagged} already had the tag(s).`);
  if (dryRun) {
    console.log('\nThis was a dry run — nothing was written to ADO. Re-run with --apply to actually tag them.');
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
