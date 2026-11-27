import { all, get } from './db.mjs';
import { languages, metrics } from './domain.mjs';
import { editsRun, manages, origins, reportData } from './work.mjs';

export const e = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const hidden = (name,value) => `<input type="hidden" name="${name}" value="${e(value)}">`;
const form = (action,body,classes='') => `<form class="${classes}" method="post" action="/actions/${action}">${body}</form>`;
const button = (label,classes='primary',attrs='') => `<button class="button ${classes}" ${attrs}>${label}</button>`;
const link = (label,url,classes='secondary') => `<a class="button ${classes}" href="${e(url)}">${label}</a>`;
const input = (label,name,attrs='',value='') => `<label>${label}<input name="${name}" value="${e(value)}" ${attrs}></label>`;
const area = (label,name,value='',rows=4,attrs='') => `<label>${label}<textarea name="${name}" rows="${rows}" ${attrs}>${e(value)}</textarea></label>`;
const select = (label,name,options,selected) => `<label>${label}<select name="${name}">${options.map(([value,text])=>`<option value="${e(value)}" ${value===selected?'selected':''}>${e(text)}</option>`).join('')}</select></label>`;
const panel = (title,body) => `<section class="panel"><h2>${title}</h2>${body}</section>`;
const details = (title,body) => `<details class="panel"><summary>${title}</summary><div class="details-body">${body}</div></details>`;
const head = (title,desc='',actions='') => `<header class="page-head"><div><h1>${e(title)}</h1>${desc ? `<p>${e(desc)}</p>` : ''}</div>${actions}</header>`;
const path = (workflow) => '/workflows/'+workflow;
const status = (value) => `<span class="badge ${value==='approved'?'positive':value==='changes requested'?'pending':''}">${e(value)}</span>`;
const lines = (value) => `<pre class="output" tabindex="0">${e(value)}</pre>`;

export function layout(config,session,title,section,content) {
  const navigation = [['audit','Usage audit','bars'],['workflows','Workflows','layers'],['results','Results','bars'],['settings','Workspace Settings','gear']];
  const icons = {
    layers:'M3 8 12 3l9 5-9 5-9-5Zm0 5 9 5 9-5M3 18l9 5 9-5',
    bars:'M4 20h16M7 16v-4m5 4V8m5 8V4',
    gear:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1'
  };
  const brand = `<a class="brand" href="/"><span class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></span>${e(config.name)}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)} · ${e(config.name)}</title><link rel="stylesheet" href="/assets/app.css"><link rel="stylesheet" href="/assets/audit.css"><script defer src="/assets/app.js"></script></head><body>
    ${session ? `<aside class="sidebar">${brand}<div class="workspace"><span class="avatar" aria-hidden="true">${e(session.workspace_name.slice(0,1).toUpperCase())}</span><div><strong>${e(session.workspace_name)}</strong><small>${e(session.role)}</small></div></div>
      <nav aria-label="Main">${navigation.map(([key,label,icon])=>`<a href="/${key}" ${section===key?'aria-current="page"':''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${icons[icon]}"/></svg>${label}</a>`).join('')}</nav>
      <div class="profile"><span>${e(session.email)}</span>${form('logout',button('Sign out','quiet'))}</div></aside>` : ''}
    <main id="main" class="${session?'main':'welcome'}">${session?'':brand}${content}</main></body></html>`;
}

export function authView(join,publicSignup=false) {
  const title = join ? 'Join your workspace' : 'Pick up where you left off';
  return `<div class="welcome-grid"><div class="welcome-copy"><h1>Find out where your AI spend goes.</h1><p>Review your AI usage, then turn recurring tasks into workflows your team can reuse.</p><div class="motif" aria-hidden="true"></div></div>
  ${panel(title,`<p>${join ? 'Use the email address on your invitation. Choose a password if this is your first visit, or enter your existing password.' : publicSignup ? 'Sign in to view your report.' : 'Sign in with your workspace account. New pilot users need a workspace invitation.'}</p>
    ${form(join?'join':'login',`${join ? input('Invite code','invite','required maxlength="100" data-invite autocomplete="off"') : ''}
    ${input('Email','email','type="email" required autocomplete="email" maxlength="254"')}
    ${input('Password','password','type="password" required maxlength="256" autocomplete="current-password"')}
    ${button(join?'Join workspace':'Sign in')}`,'stack')+(!join && publicSignup ? '<p><a href="/register">Create a free account</a></p>' : '')}`)}</div>`;
}

export const errorView = (message,back) => head('Action could not be completed')+panel('Try again',`<p role="alert">${e(message)}</p><div class="actions"><button class="button primary" data-back>Go back</button>${link('Return to app',back)}</div>`);

export function workflowList(db,session) {
  const items = all(db,'SELECT w.*, (SELECT COUNT(*) FROM runs r WHERE r.workflow_id=w.id AND r.comparison_of IS NULL) AS runs FROM workflows w WHERE workspace_id=? ORDER BY fictional,name',session.workspace_id);
  return head('Workflows','Create, run, and refine instructions your team can reuse.',link('New workflow','/workflows/new','primary'))
    + `<div class="cards">${items.map(item=>`<a class="panel workflow-card" href="${path(item.id)}"><span class="tile-icon" aria-hidden="true">✦</span><h2>${e(item.name)}</h2><p>${item.fictional?'Fictional example':'Reusable text workflow'}</p><div class="card-footer"><span>Version ${item.published} · ${item.runs} runs</span><span aria-hidden="true">↗</span></div></a>`).join('')}</div>`;
}

export function newWorkflow() {
  return head('New workflow','Start with the localization template or draft instructions from examples.')
    + panel('Workflow details',form('new-workflow',input('Name','name','required maxlength="80"')+
    area('Example chats or approved outputs (optional)','examples','',7,'maxlength="12000"')
    + '<p class="hint">Relay detects formatting and style cues locally. You can edit the draft under Versions before publishing an update.</p><label class="check"><input type="checkbox" name="retain"> Save a copy of these examples in this workflow</label>'
    + button('Create workflow'),'stack'));
}

function outputControls(config,prefix='') {
  return `<div class="output-entry">${select('External tool','origin',origins.map(item=>[item,item]))}
    ${area(prefix+'Paste an output','output','',6,'maxlength="30000"')}
    <div class="actions">${button('Save pasted output','primary','name="mode" value="paste"')}
    ${config.aiKey ? button('Generate with OpenAI','secondary','name="mode" value="ai"') : '<span class="hint">OpenAI generation is disabled. You can paste a result from any tool.</span>'}</div></div>`;
}

export function workflowView(db,config,session,workflow) {
  const versions = all(db,'SELECT * FROM versions WHERE workflow_id=? ORDER BY number DESC',workflow.id);
  const published = versions.find(item=>item.number===workflow.published);
  const history = all(db,'SELECT id,version,status,origin,created FROM runs WHERE workspace_id=? AND workflow_id=? AND comparison_of IS NULL ORDER BY created DESC LIMIT 50',session.workspace_id,workflow.id);
  const managed = manages(session,workflow);
  const examples = managed ? all(db,'SELECT * FROM examples WHERE workflow_id=?',workflow.id) : [];
  return head(workflow.name, 'Published version '+workflow.published+(workflow.fictional?' · Fictional example':''),link('All workflows','/workflows'))
    + `<div class="split"><div class="stack">
    ${panel('Start a run',form('run',hidden('workflow',workflow.id)+
      area('Source copy','source','',5,'required maxlength="12000"')+
      '<div class="fields">'+input('Audience','audience','required maxlength="1000"')+input('Brand tone','tone','required maxlength="1000"')+'</div>'+
      area('Required facts or offer terms','terms','',3,'maxlength="3000"')+
      `<fieldset><legend>Target languages</legend><div class="choices">${languages.map(lang=>`<label class="check"><input type="checkbox" name="language" value="${e(lang)}" ${lang==='English'?'checked':''}>${e(lang)}</label>`).join('')}</div></fieldset>`
      + `<div><button type="button" class="button secondary" data-prompt>Copy prompt for an external AI tool</button><span class="hint" role="status" data-prompt-status></span></div>`
      + outputControls(config),'stack'))}
    ${panel('Recent runs',history.length ? `<ul class="entries">${history.map(item=>`<li><a href="/runs/${item.id}">${e(item.origin)} · v${item.version}<small>${date(item.created)}</small></a>${status(item.status)}</li>`).join('')}</ul>` : '<p>No runs yet.</p>')}
    </div><div class="stack">
    ${panel('Published instructions',`<div id="published-instructions">${lines(published.instructions)}</div><p class="hint">Runs retain the version used when they were created.</p>`)}
    ${managed ? panel('Versions',`<ul class="entries">${versions.map(item=>`<li><details><summary>Version ${item.number} ${item.number===workflow.published?'· Published':''}</summary>${lines(item.instructions)}${item.number!==workflow.published ? form('publish',hidden('workflow',workflow.id)+hidden('version',item.number)+button('Publish version','secondary')) : ''}</details></li>`).join('')}</ul>`
      +form('version',hidden('workflow',workflow.id)+area('Draft instructions','instructions',published.instructions,7,'required maxlength="8000"')+button('Save new version','secondary'),'stack')
      + '<p class="hint">To test a draft version with the same inputs, open an existing run and select Compare versions.</p>') : ''}
    ${managed && examples.length ? details('Saved examples',examples.map(item=>lines(item.body)+form('delete-example',hidden('workflow',workflow.id)+hidden('example',item.id)+button('Delete example','danger','data-confirm="Delete this saved example?"'))).join('')) : ''}
    ${details('Duplicate workflow',form('duplicate',hidden('workflow',workflow.id)+input('New name','name','required maxlength="80"',workflow.name.slice(0,72)+' copy')+button('Duplicate','secondary'),'stack'))}
    </div></div>`;
}

function runOutput(entry) {
  return entry.approved_output ?? entry.current_output;
}

export function runView(db,config,session,entry,workflow) {
  const original = entry.comparison_of ? get(db,'SELECT * FROM runs WHERE id=? AND workspace_id=?',entry.comparison_of,session.workspace_id) : null;
  const comparisons = original ? [] : all(db,'SELECT * FROM runs WHERE comparison_of=? AND workspace_id=? ORDER BY created DESC LIMIT 25',entry.id,session.workspace_id);
  const alternatives = all(db,'SELECT number,instructions FROM versions WHERE workflow_id=? AND number<>? ORDER BY number DESC',workflow.id,entry.version);
  const inputs = JSON.parse(entry.input_json);
  const allow = editsRun(session,entry,workflow);
  const review = entry.status === 'approved'
    ? panel('Approved output',`<div id="approved">${lines(entry.approved_output)}</div><div class="actions">${button('Copy output','secondary','data-copy="approved"')}${link('Download text','/runs/'+entry.id+'/export')}</div><p class="hint">Approved ${date(entry.approved_at)} · ${fmt(entry.active_minutes)} active staff minutes · ${entry.revisions} revisions</p>`)
    : panel('Review output',allow ? form('save-review',
      hidden('run',entry.id)+hidden('sequence',entry.edit_sequence)+area('Editable output','output',entry.current_output,12,'required maxlength="30000"')+
      area('Review note','note',entry.note,3,'maxlength="2000"')+
      '<div class="fields">'+input('Active staff minutes','minutes','type="number" min="0" max="100000" step="any"',entry.active_minutes)+select('Time confirmation for approval','time_confirmation',[['','Choose…'],['confirmed','I confirm the total'],['unavailable','Time unavailable']])+'</div>'
      +'<p class="hint">Include active time writing prompts, editing, and reviewing across everyone who worked on the result. Exclude idle and waiting time.</p>'
      +`<div class="actions">${button('Approve','primary','formaction="/actions/approve"')}${button('Save draft','secondary')}${button('Request changes','secondary','formaction="/actions/request-changes"')}</div>`,'stack')
      : lines(entry.current_output));
  return head(workflow.name, 'Run · version '+entry.version+' · '+entry.origin,link('Back to workflow',path(workflow.id)))
    + `<div class="run-meta">${status(entry.status)} <span>Run ID</span> <code id="run-id">${entry.id}</code> ${button('Copy ID','quiet','data-copy="run-id"')}</div>`
    + (original ? panel('Version comparison',`<p>Both runs use the saved inputs from version ${original.version}.</p><div class="fields"><div><h3>Version ${original.version}</h3>${lines(runOutput(original))}</div><div><h3>Version ${entry.version}</h3>${lines(runOutput(entry))}</div></div>
      ${manages(session,workflow) ? form('publish',hidden('workflow',workflow.id)+select('Preferred version','version',[[original.version,'Version '+original.version],[entry.version,'Version '+entry.version]],entry.version)+button('Publish preferred version','secondary'),'stack') : ''}`) : '')
    + `<div class="split"><div class="stack">
      ${review}
      ${details('Original output',lines(entry.original))}
      ${allow ? form('delete-run',hidden('run',entry.id)+button('Delete run and output','danger','data-confirm="Permanently delete this run, its output, and any linked comparisons or usage?"')) : ''}
    </div><div class="stack">
      ${panel('Saved inputs',`<dl><dt>Source copy</dt><dd>${e(inputs.source)}</dd><dt>Audience</dt><dd>${e(inputs.audience)}</dd><dt>Brand tone</dt><dd>${e(inputs.tone)}</dd><dt>Required facts or offer terms</dt><dd>${e(inputs.terms || 'None')}</dd><dt>Languages</dt><dd>${e(inputs.languages.join(', '))}</dd></dl>`)}
      ${!original && alternatives.length && manages(session,workflow) ? details('Compare versions',form('run',hidden('workflow',workflow.id)+hidden('comparison',entry.id)+select('Comparison version','version',alternatives.map(item=>[item.number,'Version '+item.number]))+
        '<p class="hint">Relay reuses the exact saved inputs. For a pasted comparison, run the selected instructions externally first.</p>'+alternatives.map(item=>`<details><summary>Version ${item.number} instructions</summary>${lines(item.instructions)}</details>`).join('')+outputControls(config),'stack')) : ''}
      ${comparisons.length ? panel('Comparisons',`<ul class="entries">${comparisons.map(item=>`<li><a href="/runs/${item.id}">Compare v${entry.version} with v${item.version}</a>${status(item.status)}</li>`).join('')}</ul>`) : ''}
      ${entry.note && (entry.status==='approved' || !allow) ? panel('Review note',lines(entry.note)) : ''}
    </div></div>`;
}

const fmt = (value,digits=1) => value == null ? 'Unavailable' : new Intl.NumberFormat('en',{maximumFractionDigits:digits}).format(value);
const date = (value) => value == null ? 'Unavailable' : new Date(value).toISOString().slice(0,16).replace('T',' ')+' UTC';
const money = (value) => value == null ? 'Unavailable' : 'US$'+fmt(value,9);
const percent = (value) => value == null ? 'Unavailable' : fmt(value*100,1)+'%';

function breakdown(rows,key) {
  const groups = new Map();
  for (const row of rows) {
    const label = row[key] || 'Unavailable';
    const group = groups.get(label) || {count:0,input:null,output:null,latency:null,latencyCount:0,estimated:null,imported:null,unknown:0};
    group.count++;
    for (const [target,source] of [['input','input_tokens'],['output','output_tokens'],['latency','latency_ms']]) {
      if (row[source] != null) group[target] = (group[target] ?? 0)+row[source];
    }
    if (row.latency_ms != null) group.latencyCount++;
    if (row.cost_type) group[row.cost_type] = (group[row.cost_type] ?? 0)+row.cost_usd;
    else group.unknown++;
    groups.set(label,group);
  }
  return `<div class="table-scroll"><table><thead><tr><th>Group</th><th>Events</th><th>Input tokens</th><th>Output tokens</th><th>Avg latency (ms)</th><th>Imported</th><th>Estimated</th><th>Cost unavailable</th></tr></thead><tbody>
  ${[...groups].map(([label,group])=>`<tr><th scope="row">${e(label)}</th><td>${group.count}</td><td>${fmt(group.input,0)}</td><td>${fmt(group.output,0)}</td><td>${fmt(group.latencyCount ? group.latency/group.latencyCount : null,0)}</td><td>${money(group.imported)}</td><td>${money(group.estimated)}</td><td>${group.unknown}</td></tr>`).join('')}</tbody></table></div>`;
}

export function resultsView(db,session,workflows,selected,notice='',workspaceUsage=false) {
  if (!selected) return head('Results')+panel('No workflows',link('Create a workflow','/workflows/new','primary'));
  const {jobs,baseline,usage,runCosts,truncated} = reportData(db,session,selected,workspaceUsage);
  const pilot = metrics(jobs.map(job=>({minutes:job.active_minutes, approved:job.status==='approved', reviewed:job.reviewed, revisions:job.revisions, elapsed:job.approved_at==null ? null : (job.approved_at-job.created)/60000})));
  const prior = metrics(baseline.map(job=>({minutes:job.minutes, approved:job.approved, reviewed:true, revisions:job.revisions, elapsed:job.elapsed_minutes})));
  const stats = [
    ['Staff minutes per approved result',fmt(pilot.average),fmt(prior.average),pilot.measured,prior.measured],
    ['First-pass approval rate',percent(pilot.firstPass),percent(prior.firstPass),pilot.reviewed,prior.reviewed],
    ['Elapsed minutes to approval',fmt(pilot.elapsed),fmt(prior.elapsed),pilot.elapsedCount,prior.elapsedCount],
    ['Sample size',String(pilot.total),String(prior.total),null,null]
  ];
  const costs = new Map(runCosts.map(row=>[row.id,row]));
  const unmetered = runCosts.filter(row=>row.events===0);
  const measuredCosts = jobs.filter(job=>job.status==='approved').map(job=>costs.get(job.id))
    .filter(row=>row?.events && row.events===row.cost_events);
  const averageCost = measuredCosts.length ? measuredCosts.reduce((sum,row)=>sum+row.cost,0)/measuredCosts.length : null;
  return head('Results','Compare approved work with prior jobs and inspect measured AI usage.')
    + `<form class="filter actions" action="/results">${select('Workflow','workflow',workflows.map(item=>[item.id,item.name]),selected.id)}${button('View results','secondary')}</form>
    ${notice ? `<p class="notice" role="status">${e(notice)}</p>` : ''}
    ${selected.fictional ? '<p class="notice">Fictional walkthrough data.</p>' : ''}
    ${truncated ? '<p class="notice">Showing up to 500 recent pilot runs, 500 baselines, and 1,000 usage events for this workflow.</p>' : ''}
    <div class="stats">${stats.map(([label,current,previous,sample,baseSample])=>`<section class="panel metric"><h2>${label}</h2><strong>${current}</strong><span>Pilot${sample==null?'':' · n='+sample}</span><p>Baseline <b>${previous}</b>${baseSample==null?'':' · n='+baseSample}</p></section>`).join('')}</div>
    <p class="hint">First-pass approval uses reviewed jobs with a known revision count. Active and elapsed averages use approved jobs with the relevant measurement. For pasted output, elapsed time starts when the draft is saved. Comparison runs are excluded from these metrics.</p>
    ${panel('Pilot runs',jobs.length ? `<div class="table-scroll"><table><thead><tr><th>Run</th><th>Status</th><th>Active min</th><th>Elapsed min</th><th>Revisions</th><th>Recorded AI cost</th></tr></thead><tbody>${jobs.map(job=>`<tr><th scope="row"><a href="/runs/${job.id}">${e(job.origin)} · v${job.version}</a><small>${date(job.created)}</small></th><td>${status(job.status)}</td><td>${fmt(job.active_minutes)}</td><td>${fmt(job.approved_at==null?null:(job.approved_at-job.created)/60000)}</td><td>${job.revisions}</td><td>${runCost(costs.get(job.id))}</td></tr>`).join('')}</tbody></table></div>` : '<p>No pilot runs yet.</p>')}
    ${details('Comparable baseline jobs',baseline.length ? `<div class="table-scroll"><table><thead><tr><th>Job</th><th>Status</th><th>Active min</th><th>Elapsed min</th><th>Revisions</th></tr></thead><tbody>${baseline.map(job=>`<tr><th scope="row">${e(job.label)}</th><td>${job.approved?'Approved':'Unapproved'}</td><td>${fmt(job.minutes)}</td><td>${fmt(job.elapsed_minutes)}</td><td>${fmt(job.revisions,0)}</td></tr>`).join('')}</tbody></table></div>` : '<p>No comparable baseline jobs yet. A workspace owner can enter one in Settings.</p>')}
    ${panel('Usage and cost',`<p><strong>${money(averageCost)}</strong> mean recorded AI cost per approved result · n=${measuredCosts.length}. Includes results with a recorded cost for every usage event.</p>
      <p>${unmetered.length} pilot ${unmetered.length===1?'run has':'runs have'} no metered usage. Cost for those runs is unavailable.</p>
      <p class="hint">Imported costs come from CSV. Estimates use the model rates configured at capture time. Token and latency summaries use available values.</p>
      ${selected.fictional ? '' : `<form class="filter actions" action="/results">${hidden('workflow',selected.id)}${select('Usage scope','usage_scope',[['workflow','Selected workflow'],['workspace','All workspace workflows']],workspaceUsage?'workspace':'workflow')}${button('Apply scope','secondary')}</form>`}
      ${usage.length ? [['model','Model'],['email','User'],['workflow','Workflow'],['agent','Agent'],['category','Prompt category'],['version','Template version']].map(([key,label])=>`<details><summary>By ${label.toLowerCase()}</summary>${breakdown(usage,key)}</details>`).join('') : '<p>No metered usage recorded for this workflow.</p>'}`)}
    ${details('Import usage CSV',form('import',hidden('workflow',selected.id)+'<p class="hint">Use the Run ID from the result page. Include a USD cost or leave it blank. Optional event IDs distinguish separate calls with identical values.</p><pre class="output">run_id,agent,prompt_category,model,input_tokens,output_tokens,latency_ms,cost_usd,event_id</pre><label>Choose a CSV file<input type="file" accept=".csv,text/csv" data-csv></label>'+area('CSV contents','csv','',5,'required maxlength="110000"')+button('Import CSV'),'stack'))}`;
}

function runCost(row) {
  if (row?.cost == null) return 'Unavailable';
  const type = row.estimates===row.cost_events ? 'estimated' : row.estimates ? 'imported + estimated' : 'imported';
  const coverage = row.cost_events===row.events ? '' : ' · partial';
  return money(row.cost)+`<small>${type+coverage}</small>`;
}

export function settingsView(db,session,workflows) {
  const workspace = session.workspace_id;
  const memberships = all(db,'SELECT w.id,w.name,m.role FROM members m JOIN workspaces w ON w.id=m.workspace_id WHERE user_id=? ORDER BY w.name',session.user_id);
  const people = all(db,'SELECT a.email,m.role FROM members m JOIN accounts a ON a.id=m.user_id WHERE workspace_id=? ORDER BY m.role DESC,a.email',workspace);
  const isOwner = session.role==='owner';
  const invites = isOwner ? all(db,'SELECT * FROM invites WHERE workspace_id=? ORDER BY rowid DESC LIMIT 50',workspace) : [];
  const rates = isOwner ? all(db,'SELECT * FROM rates WHERE workspace_id=? ORDER BY model',workspace) : [];
  return head('Workspace Settings',session.workspace_name)
    + `<div class="split"><div class="stack">
      ${memberships.length>1 ? panel('Switch workspace',form('switch',select('Workspace','workspace',memberships.map(item=>[item.id,item.name]),workspace)+button('Switch workspace','secondary'),'stack')) : ''}
      ${panel('Members',`<ul class="entries">${people.map(person=>`<li><span>${e(person.email)}</span>${status(person.role)}</li>`).join('')}</ul>`)}
      ${isOwner ? panel('Pilot invites',form('invite',input('Pilot email','email','type="email" required maxlength="254"')+input('Expires after days','days','type="number" min="1" max="30" required',7)+button('Create invite link'),'stack')+
        `<ul class="entries">${invites.map(item=>`<li><div>${e(item.email)}<small>Expires ${date(item.expires)}</small></div>${item.consumed ? status('used') : item.revoked ? status('revoked') : item.expires<=Date.now() ? status('expired') : form('revoke',hidden('invite',item.id)+button('Revoke','danger'))}</li>`).join('')}</ul>`) : ''}
    </div><div class="stack">
      ${isOwner ? panel('Add a comparable prior job',form('baseline',
        select('Workflow','workflow',workflows.map(item=>[item.id,item.name]))+input('Job label','label','required maxlength="100"')+
        select('Approval status','approved',[['1','Approved'],['0','Unapproved']])+
        input('Active staff minutes','minutes','type="number" min="0" max="100000" step="any"')+
        input('Revisions','revisions','type="number" min="0" max="10000"')+
        input('Elapsed minutes to approval','elapsed','type="number" min="0" max="10000000" step="any"')+
        '<p class="hint">Use comparable prior jobs. Leave unknown measurements blank.</p>'+button('Save baseline','secondary'),'stack')) : ''}
      ${isOwner ? panel('Model rates',`<p class="hint">USD per million tokens. Enter the exact model ID reported by the provider. Rate updates apply to future usage.</p>${form('rate',input('Model ID','model','required maxlength="120"')+
        '<div class="fields">'+input('Input USD','input','type="number" min="0" step="any" required')+input('Output USD','output','type="number" min="0" step="any" required')+'</div>'+button('Save rate','secondary'),'stack')}
        <ul class="entries">${rates.map(rate=>`<li><div>${e(rate.model)}<small>In ${money(rate.input_usd)} · Out ${money(rate.output_usd)}</small></div>${form('delete-rate',hidden('model',rate.model)+button('Remove','danger'))}</li>`).join('')}</ul>`) : ''}
      ${isOwner ? panel('Fictional walkthrough',`<p>Load a separate example workflow with an approved result and a comparable baseline.</p>${form('seed',button('Load sample','secondary'))}`) : ''}
    </div></div>`;
}

export function inviteView(url,email) {
  return head('Invite link created','Send this privately to '+email+'.')+panel('Copy your invite link',`<p>This link is single-use and bound to the email on the invitation. Copy it before leaving the page.</p><code class="invite-url" id="invite-url">${e(url)}</code><div class="actions">${button('Copy link','primary','data-copy="invite-url"')}${link('Return to settings','/settings')}</div>`);
}
