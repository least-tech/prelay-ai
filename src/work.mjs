import { all, createWorkflow, get, id, modelCost, option, requireOwner, reserveAi, run, transaction } from './db.mjs';
import { bad, day, deriveInstructions, emailAddress, field, inputFrom, instructions, notFound, now, number, Problem, sha, token } from './domain.mjs';
import { usageRows } from './csv.mjs';

export const origins = ['ChatGPT', 'Claude', 'Gemini', 'Other'];
export const textId = (form, key) => field(form.get(key),key,36);
export function workflowFor(db, workspace, workflow) {
  return get(db,'SELECT * FROM workflows WHERE workspace_id=? AND id=?',workspace,workflow) || notFound();
}
export function runFor(db, workspace, runId) {
  return get(db,'SELECT * FROM runs WHERE workspace_id=? AND id=?',workspace,runId) || notFound();
}
export const manages = (session,workflow) => workflow.creator_id === session.user_id || session.role === 'owner';
export const editsRun = (session, entry, workflow) => entry.user_id === session.user_id || manages(session,workflow);

export function makeWorkflow(db, session, form) {
  const name = field(form.get('name'),'Workflow name',80);
  const examples = field(form.get('examples'),'Examples',12000,false);
  return transaction(db,() => {
    const workflow = createWorkflow(db,session.workspace_id,session.user_id,name,examples ? deriveInstructions(examples) : instructions);
    if (examples && form.has('retain')) run(db,'INSERT INTO examples VALUES (?,?,?,?)',id(),workflow,examples,session.user_id);
    return workflow;
  });
}

export function changeWorkflow(db, session, form, action) {
  const workflow = workflowFor(db,session.workspace_id,textId(form,'workflow'));
  const workspace = session.workspace_id;
  if (action === 'duplicate') {
    const name = field(form.get('name'),'Workflow name',80);
    return transaction(db,() => {
      const version = get(db,'SELECT instructions FROM versions WHERE workflow_id=? AND number=?',workflow.id,workflow.published);
      return createWorkflow(db,workspace,session.user_id,name,version.instructions);
    });
  }
  if (!manages(session,workflow)) throw new Problem(403,'Only the workflow creator or a workspace owner can manage versions.');
  transaction(db,() => {
    if (action === 'version') {
      const body = field(form.get('instructions'),'Workflow instructions',8000);
      const next = get(db,'SELECT MAX(number)+1 AS number FROM versions WHERE workflow_id=?',workflow.id).number;
      run(db,'INSERT INTO versions VALUES (?,?,?,?)',workflow.id,next,body,now());
    }
    if (action === 'publish') {
      const version = number(form.get('version'),'Version',{integer:true,optional:false});
      const matched = get(db,'SELECT 1 FROM versions WHERE workflow_id=? AND number=?',workflow.id,version);
      if (!matched) notFound();
      run(db,'UPDATE workflows SET published=? WHERE workspace_id=? AND id=?',version,workspace,workflow.id);
    }
    if (action === 'delete-example') run(db,'DELETE FROM examples WHERE workflow_id=? AND id=?',workflow.id,textId(form,'example'));
  });
  return workflow.id;
}

export async function makeRun(db, config, session, form, generate) {
  const workspace = session.workspace_id;
  const workflow = workflowFor(db,workspace,textId(form,'workflow'));
  const mode = option(form,'mode',['paste','ai']);
  let inputs;
  let version = workflow.published;
  let comparison = null;
  if (form.get('comparison')) {
    if (!manages(session,workflow)) throw new Problem(403,'Only the workflow creator or a workspace owner can compare versions.');
    comparison = runFor(db,workspace,textId(form,'comparison'));
    if (comparison.workflow_id !== workflow.id || comparison.comparison_of) bad('Choose an original run from this workflow.');
    version = number(form.get('version'),'Version',{integer:true,optional:false});
    if (version === comparison.version) bad('Choose a different version to compare.');
    inputs = JSON.parse(comparison.input_json);
  } else inputs = inputFrom(form);
  const versionRow = get(db,'SELECT instructions FROM versions WHERE workflow_id=? AND number=?',workflow.id,version);
  if (!versionRow) notFound();
  const created = now();
  let completion = null;
  let output;
  let origin;
  if (mode === 'ai') {
    if (!config.aiKey) bad('AI is unavailable until a provider key is configured. You can paste an output.');
    reserveAi(db,workspace,config);
    completion = await generate(config,versionRow.instructions,inputs);
    output = completion.output;
    origin = 'OpenAI';
  } else {
    output = field(form.get('output'),'Pasted output',30000);
    origin = option(form,'origin',origins);
  }
  return transaction(db, () => {
    if (comparison) runFor(db,workspace,comparison.id);
    const entry = id();
    run(db,"INSERT INTO runs (id,workspace_id,workflow_id,version,user_id,input_json,original,current_output,status,origin,created,comparison_of,fictional) VALUES (?,?,?,?,?,?,?,?,'draft',?,?,?,?)",
      entry,workspace,workflow.id,version,session.user_id,JSON.stringify(inputs),output,output,origin,created,comparison?.id || null,workflow.fictional);
    if (completion) {
      const cost = modelCost(db,workspace,completion.model,completion.inputTokens,completion.outputTokens);
      run(db,"INSERT INTO usage VALUES (?,?,'openai','Relay','workflow execution',?,?,?,?,?,?,'in-app')",
        workspace,entry,completion.model,completion.inputTokens,completion.outputTokens,completion.latency,cost,cost == null ? null : 'estimated');
    }
    return entry;
  });
}

export function review(db, session, form, action) {
  return transaction(db,() => {
    const workspace = session.workspace_id;
    const entry = runFor(db,workspace,textId(form,'run'));
    const workflow = workflowFor(db,workspace,entry.workflow_id);
    if (!editsRun(session,entry,workflow)) throw new Problem(403,'Only the run author, workflow creator or a workspace owner can review or delete this output.');
    if (action === 'delete-run') {
      run(db,'DELETE FROM runs WHERE workspace_id=? AND id=?',workspace,entry.id);
      return null;
    }
    if (Number(form.get('sequence')) !== entry.edit_sequence || entry.status === 'approved') {
      throw new Problem(409,'This result was already approved or updated. Reload it before making changes.');
    }
    const output = field(form.get('output'),'Edited output',30000);
    const note = field(form.get('note'),'Review note',2000,false);
    const minutes = number(form.get('minutes'),'Active staff minutes',{max:100000});
    if (action === 'approve' && !['confirmed','unavailable'].includes(form.get('time_confirmation'))) bad('Confirm the active staff time or mark it unavailable.');
    if (action === 'approve' && form.get('time_confirmation') === 'confirmed' && minutes == null) bad('Enter the active staff minutes.');
    if (action === 'request-changes' && !note) bad('Add a note explaining the requested changes.');
    const approved = action === 'approve';
    const storedMinutes = approved && form.get('time_confirmation') === 'unavailable' ? null : minutes;
    const status = approved ? 'approved' : action === 'request-changes' ? 'changes requested' : 'draft';
    const revision = output !== entry.current_output || action === 'request-changes' ? 1 : 0;
    const reviewed = approved || action === 'request-changes' || entry.reviewed ? 1 : 0;
    run(db,'UPDATE runs SET current_output=?,note=?,active_minutes=?,status=?,approved_output=?,approved_at=?,revisions=revisions+?,reviewed=?,edit_sequence=edit_sequence+1 WHERE workspace_id=? AND id=?',
      output,note,storedMinutes,status,approved ? output : null,approved ? now() : null,revision,reviewed,workspace,entry.id);
    return entry.id;
  });
}

export function createInvite(db, session, form) {
  requireOwner(session);
  const address = emailAddress(form.get('email'));
  const duration = number(form.get('days'),'Days',{max:30,integer:true,optional:false});
  if (duration < 1) bad('Expiry must be between 1 and 30 days.');
  const value = token();
  run(db,'INSERT INTO invites (id,digest,workspace_id,email,expires) VALUES (?,?,?,?,?)',id(),sha(value),session.workspace_id,address,now()+duration*day);
  return value;
}

export function saveBaseline(db, session, form) {
  requireOwner(session);
  const workspace = session.workspace_id;
  const workflow = workflowFor(db,workspace,textId(form,'workflow'));
  const label = field(form.get('label'),'Job label',100);
  const minutes = number(form.get('minutes'),'Active minutes',{max:100000});
  const revisions = number(form.get('revisions'),'Revisions',{integer:true,max:10000});
  const elapsed = number(form.get('elapsed'),'Elapsed minutes',{max:1e7});
  const approved = option(form,'approved',['0','1']);
  run(db,'INSERT INTO baselines VALUES (?,?,?,?,?,?,?,?,?)',id(),workspace,workflow.id,label,minutes,revisions,Number(approved),elapsed,workflow.fictional);
}

export function importUsage(db, session, body) {
  const rows = usageRows(body);
  const workspace = session.workspace_id;
  return transaction(db,() => {
    let imported = 0;
    for (const row of rows) {
      const entry = runFor(db,workspace,row.runId);
      if (session.role !== 'owner' && entry.user_id !== session.user_id) throw new Problem(403,'Members can import usage for their own runs.');
      const cost = row.cost ?? modelCost(db,workspace,row.model,row.input,row.output);
      const type = row.cost != null ? 'imported' : cost != null ? 'estimated' : null;
      imported += run(db,"INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?,?,?,'csv') ON CONFLICT(workspace_id,run_id,fingerprint) DO NOTHING",
        workspace,row.runId,row.fingerprint,row.agent,row.category,row.model,row.input,row.output,row.latency,cost,type).changes;
    }
    return {imported, duplicates:rows.length-imported};
  });
}

export function reportData(db, session, selected, workspaceUsage = false) {
  const workspace = session.workspace_id;
  const condition = 'workspace_id=? AND workflow_id=?';
  const jobs = selected ? all(db,'SELECT * FROM runs WHERE '+condition+' AND comparison_of IS NULL ORDER BY created DESC LIMIT 501',workspace,selected.id) : [];
  const baseline = selected ? all(db,'SELECT * FROM baselines WHERE '+condition+' ORDER BY rowid DESC LIMIT 501',workspace,selected.id) : [];
  const usageFilter = workspaceUsage ? 'AND w.fictional=0' : 'AND r.workflow_id=?';
  const usageParams = workspaceUsage ? [workspace] : [workspace,selected?.id];
  const usage = selected ? all(db,`SELECT u.*,a.email,w.name AS workflow,r.version FROM usage u
    JOIN runs r ON r.id=u.run_id AND r.workspace_id=u.workspace_id JOIN accounts a ON a.id=r.user_id
    JOIN workflows w ON w.id=r.workflow_id
    WHERE u.workspace_id=? ${usageFilter} ORDER BY u.rowid DESC LIMIT 1001`,...usageParams) : [];
  const runCosts = selected ? all(db,`SELECT r.id,COUNT(u.fingerprint) AS events,
    COUNT(u.cost_usd) AS cost_events, SUM(u.cost_usd) AS cost, SUM(u.cost_type='estimated') AS estimates
    FROM runs r LEFT JOIN usage u ON u.run_id=r.id AND u.workspace_id=r.workspace_id
    WHERE r.workspace_id=? AND r.workflow_id=? AND r.comparison_of IS NULL
    GROUP BY r.id ORDER BY r.created DESC LIMIT 500`,workspace,selected.id) : [];
  return {
    jobs:jobs.slice(0,500), baseline:baseline.slice(0,500), usage:usage.slice(0,1000), runCosts,
    truncated:jobs.length>500 || baseline.length>500 || usage.length>1000
  };
}
