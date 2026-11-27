import { readFileSync } from 'node:fs';
import { authenticate, cookie, registerAudit, sessionFor, switchWorkspace } from './auth.mjs';
import { generate as openAI } from './ai.mjs';
import { connectOpenAI, importAudit, maxImport, sampleReport, saveSnapshot, snapshot, sources } from './audit.mjs';
import { auditView, connectView, landing, registerView } from './audit-views.mjs';
import { billed, checkStripeSignature, checkout, paid, portal, reconcile, tester } from './billing.mjs';
import { all, get, requireOwner, run, seed } from './db.mjs';
import { bad, field, notFound, now, number, Problem } from './domain.mjs';
import { changeWorkflow, createInvite, importUsage, makeRun, makeWorkflow, review, runFor, saveBaseline, textId, workflowFor } from './work.mjs';
import { authView, errorView, inviteView, layout, newWorkflow, resultsView, runView, settingsView, workflowList, workflowView } from './views.mjs';

const assets = new Map([
  ['/assets/audit.css',['text/css; charset=utf-8',readFileSync(new URL('../public/audit.css',import.meta.url))]],
  ['/assets/app.css',['text/css; charset=utf-8',readFileSync(new URL('../public/app.css',import.meta.url))]],
  ['/assets/app.js',['text/javascript; charset=utf-8',readFileSync(new URL('../public/app.js',import.meta.url))]]
]);

function sameOrigin(request,config) {
  if (request.headers.origin !== config.origin) throw new Problem(403,'Open the app at its configured address, then try again.');
}

function requireType(request,type) {
  if (request.headers['content-type']?.split(';')[0] !== type) throw new Problem(415,'Unsupported request format.');
}

async function readBody(request,limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({destroyOnReturn:false})) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      throw new Problem(413,'This request is too large.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readForm(request,config) {
  sameOrigin(request,config);
  requireType(request,'application/x-www-form-urlencoded');
  return new URLSearchParams((await readBody(request,1_100_000)).toString('utf8'));
}

const requestedSource = (value,fallback='api') => sources.includes(value) ? value : fallback;
const modeFor = params => ['free','full'].includes(params.get('view')) ? params.get('view') : undefined;
const logTemplate = [{event_id:'sample-001',timestamp:'2026-11-20T12:00:00Z',prompt:'Extract public event dates into JSON.',model:'gpt-6.2-sol',
  topic:'Summaries & extraction',input_tokens:1200,output_tokens:80,latency_ms:1300,active_ms:20000,cost_usd:0.0032,public_data:true}];

export function createHandler(db,config,{generate=openAI, logger=console, fetcher=fetch}={}) {
  const imports = new Set();
  const uploads = new Set();
  return async function handle(request,response) {
    response.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com; base-uri 'none'; frame-ancestors 'none'");
    response.setHeader('Referrer-Policy','same-origin');
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('X-Frame-Options','DENY');
    response.setHeader('Cache-Control','no-store');
    if (config.production) response.setHeader('Strict-Transport-Security','max-age=31536000');
    const reply = (status, type, body) => {
      response.statusCode = status;
      response.setHeader('Content-Type',type);
      response.end(body);
    };
    const redirect = (location) => {
      response.statusCode = 303;
      response.setHeader('Location',location);
      response.end();
    };
    let session = null;
    const render = (title,section,html,status=200) => reply(status,'text/html; charset=utf-8',layout(config,session,title,section,html));
    try {
      const url = new URL(request.url,config.origin);
      const path = url.pathname;
      if (request.method === 'GET' && path === '/healthz') {
        get(db,'SELECT 1');
        return reply(200,'text/plain; charset=utf-8','ok');
      }
      const asset = assets.get(path);
      if (request.method === 'GET' && asset) return reply(200,...asset);
      if (request.method==='POST' && path==='/billing/webhook') {
        if (!config.billing) notFound();
        const raw = await readBody(request,524288);
        if (!checkStripeSignature(raw,request.headers['stripe-signature'],config.billing.webhook)) throw new Problem(400,'Invalid webhook signature.');
        let event;
        try { event = JSON.parse(raw.toString('utf8')); } catch { bad('Malformed billing event.'); }
        if (!event || typeof event!=='object' || typeof event.type!=='string') bad('Malformed billing event.');
        await reconcile(db,config.billing,event,fetcher);
        return reply(200,'text/plain; charset=utf-8','ok');
      }
      session = sessionFor(db,request);
      if (request.method==='GET' && path==='/') return session ? redirect('/audit') : render('AI usage audit','audit',landing(config,session));
      if (request.method==='GET' && path==='/audit/demo') return render('Sample audit','audit',auditView(config,session,{
        report:sampleReport(),source:'logs',available:[],full:modeFor(url.searchParams)==='full',demo:true
      }));
      if (request.method==='GET' && path==='/register' && config.publicSignup) return session ? redirect('/audit') : render('Create account','audit',registerView());
      if (request.method==='POST' && path==='/actions/register' && config.publicSignup) {
        const form = await readForm(request,config);
        response.setHeader('Set-Cookie',cookie(config,await registerAudit(db,request,form)));
        return redirect('/audit/connect');
      }
      if (request.method === 'GET' && path === '/join') return render('Join workspace','',authView(true));
      if (request.method === 'GET' && path === '/login') return session ? redirect('/audit') : render('Sign in','',authView(false,config.publicSignup));
      if (request.method === 'POST' && ['/actions/login','/actions/join'].includes(path)) {
        const form = await readForm(request,config);
        response.setHeader('Set-Cookie',cookie(config,await authenticate(db,request,form,path.endsWith('/join'))));
        return redirect(path.endsWith('/join') ? '/workflows' : '/audit');
      }
      if (!session) return request.method === 'GET' ? redirect('/login') : render('Sign in','',authView(false),401);
      const workspace = session.workspace_id;
      const user = session.user_id;
      if (request.method==='POST' && ['/audit/import/chat','/audit/import/logs'].includes(path)) {
        sameOrigin(request,config);
        requireType(request,'application/json');
        if (uploads.has(user) || uploads.size>=4) throw new Problem(429,'An upload is already running or the server is busy.');
        uploads.add(user);
        try {
          const report = importAudit(path.split('/').at(-1),(await readBody(request,maxImport)).toString('utf8'));
          saveSnapshot(db,user,report);
          return reply(200,'application/json; charset=utf-8',JSON.stringify({url:'/audit?source='+report.source}));
        } finally { uploads.delete(user); }
      }
      if (request.method === 'GET') {
        if (path==='/audit/log-template') {
          response.setHeader('Content-Disposition','attachment; filename="sample-request-logs.json"');
          return reply(200,'application/json; charset=utf-8',JSON.stringify(logTemplate,null,2));
        }
        if (path==='/audit/connect') {
          const source = requestedSource(url.searchParams.get('source'));
          return render('Connect AI usage','audit',connectView(source,get(db,'SELECT 1 FROM audit_snapshots WHERE user_id=? AND source=?',user,source)));
        }
        if (path==='/audit') {
          const available = all(db,'SELECT source FROM audit_snapshots WHERE user_id=? ORDER BY imported DESC',user).map(item=>item.source);
          const source = requestedSource(url.searchParams.get('source'),available[0]);
          const mode = modeFor(url.searchParams);
          return render('AI usage report','audit',auditView(config,session,{
            report:snapshot(db,user,source),source,available,full:paid(db,session,mode),
            test:tester(db,user),mode,actualPaid:billed(db,user),
            customer:get(db,'SELECT customer FROM audit_billing WHERE user_id=?',user)?.customer,
            billing:url.searchParams.get('billing')
          }));
        }
        if (path === '/workflows') return render('Workflows','workflows',workflowList(db,session));
        if (path === '/workflows/new') return render('New workflow','workflows',newWorkflow());
        const workflowPath = path.match(/^\/workflows\/([a-f0-9-]{36})$/);
        if (workflowPath) return render('Workflow','workflows',workflowView(db,config,session,workflowFor(db,workspace,workflowPath[1])));
        const runPath = path.match(/^\/runs\/([a-f0-9-]{36})(\/export)?$/);
        if (runPath) {
          const entry = runFor(db,workspace,runPath[1]);
          if (runPath[2]) {
            if (entry.status !== 'approved') notFound();
            response.setHeader('Content-Disposition','attachment; filename="approved-'+entry.id+'.txt"');
            return reply(200,'text/plain; charset=utf-8',entry.approved_output);
          }
          return render('Review run','workflows',runView(db,config,session,entry,workflowFor(db,workspace,entry.workflow_id)));
        }
        const list = all(db,'SELECT * FROM workflows WHERE workspace_id=? ORDER BY fictional,name',workspace);
        if (path === '/settings') return render('Settings','settings',settingsView(db,session,list));
        if (path === '/results') {
          const workflow = url.searchParams.get('workflow');
          const selected = workflow ? workflowFor(db,workspace,workflow) : list[0];
          const imported = url.searchParams.get('imported');
          const duplicates = url.searchParams.get('duplicates');
          const notice = /^\d{1,3}$/.test(imported || '') && /^\d{1,3}$/.test(duplicates || '')
            ? 'Imported '+imported+' usage events. Skipped '+duplicates+' duplicates.' : '';
          const workspaceUsage = url.searchParams.get('usage_scope')==='workspace' && !selected?.fictional;
          return render('Results','results',resultsView(db,session,list,selected,notice,workspaceUsage));
        }
        notFound();
      }
      if (request.method !== 'POST') throw new Problem(405,'This method is unavailable.');
      if (!path.startsWith('/actions/')) notFound();
      const form = await readForm(request,config);
      const action = path.slice('/actions/'.length);
      if (action==='audit-connect') {
        if (imports.has(user) || imports.size>=8) throw new Problem(429,'An import is already running or the server is busy. Try again shortly.');
        imports.add(user);
        try { saveSnapshot(db,user,await connectOpenAI(form.get('key'),fetcher)); }
        finally { imports.delete(user); }
        return redirect('/audit?source=api');
      }
      if (action==='audit-delete') {
        const source = requestedSource(form.get('source'),null);
        if (!source) bad('Choose a source to delete.');
        if (source==='api' ? imports.has(user) : uploads.has(user)) throw new Problem(409,'Wait for the current import to finish before deleting it.');
        run(db,'DELETE FROM audit_snapshots WHERE user_id=? AND source=?',user,source);
        return redirect('/audit');
      }
      if (action==='audit-checkout') return redirect(await checkout(db,config,user,form.get('plan'),fetcher));
      if (action==='audit-portal') return redirect(await portal(db,config,user,fetcher));
      if (action === 'logout') {
        run(db,'DELETE FROM sessions WHERE digest=?',session.digest);
        response.setHeader('Set-Cookie',cookie(config,''));
        return redirect('/login');
      }
      if (action === 'switch') {
        response.setHeader('Set-Cookie',cookie(config,switchWorkspace(db,request,session,textId(form,'workspace'))));
        return redirect('/workflows');
      }
      if (action === 'new-workflow') return redirect('/workflows/'+makeWorkflow(db,session,form));
      if (['duplicate','version','publish','delete-example'].includes(action)) return redirect('/workflows/'+changeWorkflow(db,session,form,action));
      if (action === 'run') return redirect('/runs/'+await makeRun(db,config,session,form,generate));
      if (['approve','save-review','request-changes','delete-run'].includes(action)) {
        const entry = review(db,session,form,action);
        return redirect(entry ? '/runs/'+entry : '/workflows');
      }
      if (action === 'import') {
        const workflow = workflowFor(db,workspace,textId(form,'workflow'));
        const {imported,duplicates} = importUsage(db,session,form.get('csv'));
        return redirect('/results?workflow='+workflow.id+'&imported='+imported+'&duplicates='+duplicates);
      }
      if (action === 'invite') {
        const code = createInvite(db,session,form);
        return render('Invite created','settings',inviteView(config.origin+'/join#'+code,form.get('email')));
      }
      requireOwner(session);
      if (action === 'revoke') {
        const revoked = run(db,'UPDATE invites SET revoked=? WHERE workspace_id=? AND id=? AND consumed IS NULL AND revoked IS NULL',now(),workspace,textId(form,'invite'));
        if (!revoked.changes) notFound();
      } else if (action === 'baseline') saveBaseline(db,session,form);
      else if (action === 'rate' || action === 'delete-rate') {
        const model = field(form.get('model'),'Model ID',120);
        if (action === 'delete-rate') run(db,'DELETE FROM rates WHERE workspace_id=? AND model=?',workspace,model);
        else {
          const amount = key => number(form.get(key),key+' rate',{max:100000,optional:false});
          run(db,'INSERT INTO rates VALUES (?,?,?,?) ON CONFLICT(workspace_id,model) DO UPDATE SET input_usd=excluded.input_usd,output_usd=excluded.output_usd',workspace,model,amount('input'),amount('output'));
        }
      } else if (action === 'seed') return redirect('/results?workflow='+seed(db,workspace,session.user_id));
      else notFound();
      return redirect('/settings');
    } catch (error) {
      if (!(error instanceof Problem)) logger.error('Application request failed.');
      if (!response.writableEnded && request.url?.startsWith('/audit/import/')) {
        return reply(error instanceof Problem ? error.status : 500,'application/json; charset=utf-8',
          JSON.stringify({error:error instanceof Problem ? error.message : 'The report could not be generated.'}));
      }
      if (!response.writableEnded) return render('Request error','',errorView(error instanceof Problem ? error.message : 'An unexpected error occurred.',session ? '/audit' : '/login'),error instanceof Problem ? error.status : 500);
    }
  };
}
