import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHandler } from '../src/app.mjs';
import { bootstrap, database, get, provisionWorkspace, run, settings } from '../src/db.mjs';
import { hashPassword, metrics, sha } from '../src/domain.mjs';
import { usageRows } from '../src/csv.mjs';
import { generate } from '../src/ai.mjs';

const config = settings({APP_ORIGIN:'https://pilot.example',DATABASE_PATH:':memory:',NODE_ENV:'production'});
const password = 'Long fictional test passphrase';
const ownerEmail = 'owner@example.test';
const pilotEmail = 'pilot@example.test';
const fields = {
  source:'Two seats for $18 on Friday! <script>window.fail=true</script>',
  audience:'Hong Kong film fans',tone:'Warm',terms:'Friday 7 pm, USD 18 for two seats',
  language:['English','Traditional Chinese','Simplified Chinese','Korean']
};

function client(handler) {
  let session = '';
  return async function request(path,{form,raw,extra={},origin=config.origin}={}) {
    const encoded = new URLSearchParams();
    for (const [key,value] of Object.entries(form || {})) {
      for (const entry of Array.isArray(value) ? value : [value]) encoded.append(key,entry);
    }
    const request = Readable.from(raw!==undefined ? [Buffer.from(raw)] : form ? [Buffer.from(encoded.toString())] : []);
    request.method = form || raw!==undefined ? 'POST' : 'GET';
    request.url = path;
    request.headers = {origin,cookie:session,'content-type':raw!==undefined?'application/json':'application/x-www-form-urlencoded',...extra};
    const headers = new Map();
    const response = {
      statusCode:200,writableEnded:false,body:'',
      setHeader(name,value) {headers.set(name.toLowerCase(),value);},
      end(body='') {this.body = String(body);this.writableEnded = true;}
    };
    await handler(request,response);
    if (headers.has('set-cookie')) session = headers.get('set-cookie').split(';')[0];
    return {status:response.statusCode,body:response.body,redirect:headers.get('location'),headers};
  };
}
const failUnexpected = {error() { assert.fail('Unexpected application error'); }};
const post = (client,action,form) => client('/actions/'+action,{form});
const invite = (body) => body.match(/\/join#([A-Za-z0-9_-]{43})/)[1];
const segment = location => location.split('/').at(-1);

test('fresh invite-only pilot, workspace access, approvals, reporting, CSV and persistence',async () => {
  const directory = mkdtempSync(join(tmpdir(),'relay-test-'));
  const path = join(directory,'pilot.sqlite');
  let db = database(path);
  try {
    const org = await bootstrap(db,ownerEmail,password,'Film Club');
    await assert.rejects(bootstrap(db,'other@example.test',password,'Duplicate'),{status:409});
    const unrelated = 'unrelated@example.test';
    const other = provisionWorkspace(db,unrelated,await hashPassword(password),'Other Team');
    const handler = createHandler(db,config,{logger:failUnexpected});
    const owner = client(handler);
    const member = client(handler);
    const stranger = client(handler);
    assert.equal((await member('/healthz')).status,200);
    assert.equal((await member('/assets/app.css')).status,200);
    assert.match((await member('/')).body,/Know where your AI spend goes/);
    const signIn = await member('/login');
    assert.match(signIn.body,/New pilot users need/);
    assert.equal(signIn.headers.get('referrer-policy'),'same-origin');
    assert.equal((await post(member,'login',{email:pilotEmail,password})).status,401);
    assert.equal((await post(member,'join',{email:pilotEmail,password,invite:'invalid'})).status,400);
    const login = await post(owner,'login',{email:ownerEmail,password});
    assert.equal(login.status,303);
    assert.match(login.headers.get('set-cookie'),/HttpOnly; SameSite=Lax;.*Secure/);
    assert.match((await owner('/settings')).body,/Pilot invites/);
    assert.equal((await owner('/actions/invite',{form:{email:pilotEmail,days:7},origin:'https://other.example'})).status,403);

    const revokedCode = invite((await post(owner,'invite',{email:'revoked@example.test',days:7})).body);
    const revoked = get(db,'SELECT id FROM invites WHERE digest=?',sha(revokedCode));
    assert.equal((await post(owner,'revoke',{invite:revoked.id})).status,303);
    assert.equal((await post(member,'join',{email:'revoked@example.test',password,invite:revokedCode})).status,400);
    const expiredCode = invite((await post(owner,'invite',{email:'expired@example.test',days:1})).body);
    run(db,'UPDATE invites SET expires=0 WHERE digest=?',sha(expiredCode));
    assert.equal((await post(member,'join',{email:'expired@example.test',password,invite:expiredCode})).status,400);

    const liveCode = invite((await post(owner,'invite',{email:pilotEmail,days:7})).body);
    assert.equal((await post(member,'join',{email:'wrong@example.test',password,invite:liveCode})).status,400);
    assert.equal((await post(member,'join',{email:pilotEmail,password,invite:liveCode})).status,303);
    assert.equal((await post(client(handler),'join',{email:pilotEmail,password,invite:liveCode})).status,400);
    assert.match((await member('/workflows')).body,/Campaign localization/);
    assert.doesNotMatch((await member('/settings')).body,/Pilot invites/);
    assert.equal((await post(member,'invite',{email:'new@example.test',days:7})).status,403);

    const baseline = {workflow:org.workflow,label:'Comparable Friday offer',approved:1,minutes:15,revisions:0,elapsed:30};
    assert.equal((await post(owner,'baseline',baseline)).status,303);
    assert.equal((await post(member,'baseline',baseline)).status,403);
    const start = {workflow:org.workflow,...fields,origin:'ChatGPT',output:'English: Friday offer\n繁體中文：星期五優惠'};
    assert.equal((await post(member,'run',{...start,mode:'ai'})).status,400);
    const draft = await post(member,'run',{...start,mode:'paste'});
    assert.equal(draft.status,303);
    const runPath = draft.redirect;
    const runId = segment(runPath);
    assert.match((await member(runPath)).body,/Korean/);
    assert.match((await member(runPath)).body,/&lt;script&gt;/);
    assert.equal((await member(runPath+'/export')).status,404);

    const review = {run:runId,sequence:0,output:'English: Friday, 7 pm. Two seats for USD 18.\n繁體中文：星期五晚上七點，雙人門票 US$18。',minutes:6.5};
    assert.equal((await post(owner,'request-changes',{...review,output:start.output,note:'Include time and full offer.'})).status,303);
    assert.match((await member(runPath)).body,/changes requested/);
    assert.equal((await post(member,'save-review',review)).status,409);
    assert.equal((await post(member,'save-review',{...review,sequence:1})).status,303);
    assert.equal((await post(member,'approve',{...review,sequence:2})).status,400);
    assert.equal((await post(member,'approve',{...review,sequence:2,time_confirmation:'confirmed'})).status,303);
    assert.equal((await post(member,'approve',{...review,sequence:2,time_confirmation:'confirmed'})).status,409);
    assert.match((await member(runPath)).body,/Approved output/);
    assert.match((await member(runPath)).body,/星期五優惠/);
    assert.equal((await member(runPath+'/export')).body,review.output);
    const resultsPath = '/results?workflow='+org.workflow;
    assert.match((await member(resultsPath)).body,/<strong>6\.5<\/strong>/);
    assert.match((await member(resultsPath)).body,/Comparable Friday offer/);
    assert.match((await member(resultsPath)).body,/1 pilot run has no metered usage/);

    await post(stranger,'login',{email:unrelated,password});
    for (const target of [runPath,runPath+'/export','/workflows/'+org.workflow,resultsPath]) assert.equal((await stranger(target)).status,404);
    assert.equal((await post(stranger,'delete-run',{run:runId})).status,404);
    assert.equal((await post(stranger,'switch',{workspace:org.workspace})).status,403);

    const header = 'run_id,agent,prompt_category,model,input_tokens,output_tokens,latency_ms,cost_usd,event_id\n';
    const csv = header + runId+',localizer,translate,test-model,70,30,120,0.005,a\n';
    const usage = (actor,workflow,contents) => post(actor,'import',{workflow,csv:contents});
    assert.equal((await usage(member,org.workflow,'bad,csv\n1,2')).status,400);
    assert.equal((await usage(member,org.workflow,csv+runId+',x,y,m,-1,0,1,,b')).status,400);
    assert.equal(get(db,'SELECT COUNT(*) AS count FROM usage').count,0);
    assert.equal((await usage(stranger,other.workflow,csv)).status,404);
    assert.match((await usage(member,org.workflow,csv)).redirect,/imported=1&duplicates=0/);
    assert.match((await usage(member,org.workflow,csv)).redirect,/imported=0&duplicates=1/);
    assert.equal((await post(owner,'rate',{model:'test-model',input:1,output:2})).status,303);
    const second = header+runId+',"second, agent",review,test-model,100,50,200,,b';
    assert.match((await usage(owner,org.workflow,second)).redirect,/imported=1/);
    const dashboard = await member(resultsPath);
    assert.match(dashboard.body,/US\$0\.005/);
    assert.match(dashboard.body,/US\$0\.0002/);
    assert.match(dashboard.body,/US\$0\.0052<\/strong> mean recorded AI cost per approved result · n=1/);
    assert.match(dashboard.body,/second, agent/);
    assert.match((await member(resultsPath+'&usage_scope=workspace')).body,/second, agent/);

    assert.equal((await post(member,'version',{workflow:org.workflow,instructions:'Unauthorized version'})).status,403);
    assert.equal((await post(owner,'version',{workflow:org.workflow,instructions:'Use compact copy and a shorter headline.'})).status,303);
    const compare = await post(owner,'run',{workflow:org.workflow,comparison:runId,version:2,mode:'paste',origin:'Claude',output:'A second localization.'});
    assert.equal(compare.status,303);
    assert.match((await owner(compare.redirect)).body,/Version comparison/);
    assert.equal(get(db,'SELECT input_json FROM runs WHERE id=?',runId).input_json,get(db,'SELECT input_json FROM runs WHERE id=?',segment(compare.redirect)).input_json);
    assert.equal((await post(owner,'publish',{workflow:org.workflow,version:2})).status,303);
    assert.equal(get(db,'SELECT version FROM runs WHERE id=?',runId).version,1);
    assert.equal(get(db,'SELECT published FROM workflows WHERE id=?',org.workflow).published,2);

    const example = await post(member,'new-workflow',{name:'Fan event email',examples:'Offers:\n- One bullet\n- Two bullets ✨',retain:'on'});
    assert.equal(example.status,303);
    assert.match((await member(example.redirect)).body,/Use short bullets/);
    const workflow = segment(example.redirect);
    const saved = get(db,'SELECT id FROM examples WHERE workflow_id=?',workflow);
    assert.equal((await post(member,'delete-example',{workflow,example:saved.id})).status,303);
    assert.equal(get(db,'SELECT id FROM examples WHERE workflow_id=?',workflow),undefined);
    assert.equal((await post(member,'duplicate',{workflow,name:'Partner email'})).status,303);
    const sample = await post(owner,'seed',{});
    assert.equal(sample.status,303);
    assert.match((await owner(sample.redirect)).body,/Fictional walkthrough data/);
    assert.equal((await post(owner,'seed',{})).redirect,sample.redirect);

    // Refresh above issues fresh GETs. Reopening SQLite also verifies restart persistence.
    db.close();
    db = database(path);
    const afterRestart = client(createHandler(db,config,{logger:failUnexpected}));
    assert.equal((await post(afterRestart,'login',{email:pilotEmail,password})).status,303);
    assert.equal((await afterRestart(runPath+'/export')).body,review.output);
    assert.equal(get(db,'SELECT COUNT(*) AS count FROM usage').count,2);
    assert.equal((await post(afterRestart,'delete-run',{run:runId})).status,303);
    assert.equal((await afterRestart(runPath)).status,404);
    assert.equal(get(db,'SELECT COUNT(*) AS count FROM usage').count,0);
    assert.equal(get(db,'SELECT COUNT(*) AS count FROM runs WHERE comparison_of=?',runId).count,0);
  } finally {
    db.close();
    rmSync(directory,{force:true,recursive:true});
  }
});

test('AI output and metering use exact rates and daily limits',async () => {
  const db = database(':memory:');
  try {
    const org = await bootstrap(db,ownerEmail,password,'AI quota test');
    let calls = 0;
    const owner = client(createHandler(db,{...config,aiKey:'test-key',workspaceLimit:1,installationLimit:2},{
      logger:failUnexpected,
      async generate(config,instructions,input) {
        calls++;
        assert.match(instructions,/Localize/);
        assert.deepEqual(input.languages,fields.language);
        return {output:'Localized text',model:'fixture-model',inputTokens:100,outputTokens:50,latency:12};
      }
    }));
    await post(owner,'login',{email:ownerEmail,password});
    await post(owner,'rate',{model:'fixture-model',input:2,output:4});
    const payload = {mode:'ai',workflow:org.workflow,...fields};
    assert.equal((await post(owner,'run',payload)).status,303);
    assert.equal((await post(owner,'run',payload)).status,429);
    const usage = get(db,'SELECT * FROM usage');
    assert.equal(usage.cost_type,'estimated');
    assert.equal(usage.cost_usd,0.0004);
    assert.equal(usage.input_tokens,100);
    assert.equal(usage.latency_ms,12);
    assert.equal(calls,1);
  } finally { db.close(); }
});

test('CSV parsing and metrics keep missing measurements distinct from zero',() => {
  const header = 'run_id,agent,prompt_category,model,input_tokens,output_tokens,latency_ms,cost_usd';
  const [row] = usageRows(header+'\r\nid,"two ""quotes""",,model,0,,,,'.slice(0,-1));
  assert.equal(row.input,0);
  assert.equal(row.output,null);
  assert.equal(row.agent,'two "quotes"');
  assert.throws(()=>usageRows(header+'\nid,"unclosed'),{status:400});
  assert.equal(metrics([]).average,null);
  assert.equal(metrics([{approved:true,minutes:0,revisions:0,reviewed:true}]).average,0);
  assert.equal(metrics([{approved:true,minutes:5,revisions:0,reviewed:true}]).firstPass,1);
});

test('real OpenAI Responses API', {skip:process.env.RELAY_TEST_LIVE_AI!=='1' || !process.env.OPENAI_API_KEY}, async () => {
  const db = database(':memory:');
  try {
    const org = await bootstrap(db,ownerEmail,password,'Real OpenAI test');
    const owner = client(createHandler(db,{
      ...config,aiKey:process.env.OPENAI_API_KEY,aiModel:process.env.OPENAI_MODEL || 'gpt-4.1-mini'
    },{generate,logger:failUnexpected}));
    await post(owner,'login',{email:ownerEmail,password});
    const response = await post(owner,'run',{...fields,source:'Fictional offer: two seats for $18.',language:'English',mode:'ai',workflow:org.workflow});
    assert.equal(response.status,303);
    const usage = get(db,'SELECT * FROM usage');
    assert.ok(usage.model && usage.input_tokens > 0 && usage.output_tokens > 0 && usage.latency_ms >= 0);
    assert.equal(usage.cost_usd,null);
  } finally { db.close(); }
});

test('audit onboarding, OpenAI pagination, secret handling, tester previews and private snapshots',async ()=>{
  const db = database(':memory:');
  try {
    const apiKey = 'sk-admin-fictional-audit-key';
    const visits = [];
    const fetcher = async (url,options)=>{
      visits.push(url.href);
      assert.equal(options.headers.Authorization,'Bearer '+apiKey);
      assert.equal(url.hostname,'api.openai.com');
      const day = Number(url.searchParams.get('start_time'));
      if (url.pathname.endsWith('/costs')) {
        assert.equal(url.searchParams.get('group_by'),'line_item');
        return Response.json({data:[{start_time:day,results:[{amount:{value:4.75,currency:'usd'},line_item:'Completion billed cost'}]}]});
      }
      assert.equal(url.searchParams.get('group_by'),'model');
      const next = url.searchParams.has('page');
      return Response.json({data:[{start_time:day,results:[{model:next?'gpt-6-luna':'gpt-6.2-astra',
        input_tokens:next?500:3500,output_tokens:500,input_cached_tokens:100,num_model_requests:3}]}],has_more:!next,next_page:next?null:'page02'});
    };
    const handler = createHandler(db,{...config,publicSignup:true},{fetcher,logger:failUnexpected});
    const owner = client(handler);
    const outsider = client(handler);
    assert.match((await owner('/audit/demo?view=full')).body,/Prompt breakdown and recommendations/);
    assert.equal((await post(owner,'register',{email:ownerEmail,password})).redirect,'/audit/connect');
    assert.match((await owner('/audit/connect')).body,/Admin API keys/);
    assert.equal((await post(owner,'audit-connect',{key:'sk-proj-not-admin'})).status,400);
    assert.equal((await post(owner,'audit-connect',{key:apiKey})).redirect,'/audit?source=api');
    assert.equal(visits.length,3);
    const free = await owner('/audit?source=api&view=full');
    assert.match(free.body,/OpenAI API connected/);
    assert.match(free.body,/\$4\.75/);
    assert.match(free.body,/5,000/);
    assert.doesNotMatch(free.body,/Completion billed cost|Tokens by model/);
    const user = get(db,'SELECT id FROM accounts WHERE email=?',ownerEmail).id;
    assert.doesNotMatch(get(db,'SELECT report FROM audit_snapshots WHERE user_id=?',user).report,new RegExp(apiKey));
    run(db,'INSERT INTO audit_testers VALUES (?)',user);
    assert.match((await owner('/audit?source=api&view=full')).body,/Completion billed cost/);
    assert.doesNotMatch((await owner('/audit?source=api&view=free')).body,/Completion billed cost/);
    const raw = JSON.stringify(Array.from({length:3},(_,i)=>({
      event_id:'event-'+i,timestamp:'2026-11-23T16:01:00Z',model:'gpt-6.2-astra',
      prompt:'Extract public fixture dates into JSON. <script>hidden</script>',
      input_tokens:3000,output_tokens:600,latency_ms:1250,cost_usd:0.05,public_data:true
    })));
    assert.equal((await owner('/audit/import/logs',{raw,origin:'https://outside.example'})).status,403);
    assert.equal((await owner('/audit/import/logs',{raw:'broken'})).status,400);
    assert.equal((await owner('/audit/import/logs',{raw})).status,200);
    assert.doesNotMatch((await owner('/audit?source=logs')).body,/fixture dates/);
    const full = await owner('/audit?source=logs&view=full');
    for (const expected of [/Luna/,/Gemini Free/,/Automation candidate/,/\$0\.15/,/3\.8 sec/,/&lt;script&gt;hidden/]) assert.match(full.body,expected);
    assert.doesNotMatch(full.body,/<script>hidden/);
    await post(outsider,'register',{email:'unrelated@example.test',password});
    assert.doesNotMatch((await outsider('/audit?source=logs&view=full')).body,/fixture dates/);
    await post(owner,'audit-delete',{source:'logs'});
    assert.doesNotMatch((await owner('/audit?source=logs&view=full')).body,/fixture dates/);
  } finally { db.close(); }
});
