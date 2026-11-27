import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { connectOpenAI, importAudit } from '../src/audit.mjs';
import { billed, checkStripeSignature, checkout, paid, portal, reconcile } from '../src/billing.mjs';
import { bootstrap, database, get, run } from '../src/db.mjs';

test('ChatGPT export follows the selected branch and labels estimated data',()=>{
  const clock = Date.parse('2026-11-27T00:00:00Z');
  const at = clock/1000-3600;
  const node = (id,parent,role,text,create_time=at) => ({parent,message:{id,author:{role},create_time,content:{parts:[text]}}});
  const json = JSON.stringify([{current_node:'answer',mapping:{
    root:{}, old:node('old','root','user','Older prompt',at-40*86400),
    question:node('question','old','user','Translate a public announcement into Traditional Chinese.'),
    answer:node('answer','question','assistant','公開公告',at+1.4),
    alternate:node('alternate','question','assistant','Discarded branch',at+40)
  }}]);
  const report = importAudit('chat',json,clock);
  assert.equal(report.requests,1);
  assert.equal(report.cost,null);
  assert.ok(Math.abs(report.time-1400)<0.01);
  assert.equal(report.promptDetails[0].topic,'Localization');
  assert.equal(report.promptDetails[0].route,'gpt-6-luna');
  assert.ok(report.tokens>0);
});

test('missing logged fields stay unknown and costs are never inferred into recorded totals',()=>{
  const report = importAudit('logs',JSON.stringify([
    {event_id:'1',timestamp:'2026-11-22T10:00:00Z',prompt:'Extract customer list',model:'gpt-6.2-astra',input_tokens:20,output_tokens:3,public_data:true},
    {event_id:'2',timestamp:'2026-11-23T11:00:00Z',prompt:'Extract customer list',model:'gpt-6.2-astra',time:null,cost_usd:0,output_tokens:2,public_data:true}
  ]));
  assert.equal(report.requests,2);
  assert.equal(report.cost,0);
  assert.equal(report.coverage.cost,1);
  assert.equal(report.coverage.tokens,1);
  assert.equal(report.time,null);
  assert.equal(report.promptDetails[0].gemini,false);
  assert.equal(report.promptDetails[0].savings,null);
});

test('a failed OpenAI endpoint blocks connection confirmation',async ()=>{
  await assert.rejects(connectOpenAI('sk-admin-fictional-audit-key',async url=>url.pathname.endsWith('/costs') ?
    new Response('',{status:403}) : Response.json({data:[]})),{status:422});
});

test('checkout validates the plan and signed subscription reconciliation drives access',async ()=>{
  const db = database(':memory:');
  try {
    const {user} = await bootstrap(db,'payer@example.test','A sufficiently long test phrase','Workspace');
    const billing = {secret:'sk_test_mock',webhook:'whsec_mock',prices:{monthly:'price_month',annual:'price_year'},live:false};
    const config = {billing,origin:'https://pilot.example'};
    const session = {user_id:user};
    let status = 'active';
    const fetcher = async (url,options)=>{
      assert.equal(new URL(url).hostname,'api.stripe.com');
      assert.equal(options.headers.Authorization,'Bearer sk_test_mock');
      if (url.endsWith('prices/price_month')) return Response.json({id:'price_month',active:true,currency:'usd',unit_amount:1200,recurring:{interval:'month',interval_count:1}});
      if (url.endsWith('checkout/sessions')) {
        assert.equal(options.body.get('success_url'),'https://pilot.example/audit?billing=pending');
        assert.equal(options.body.get('subscription_data[metadata][audit_user]'),user);
        return Response.json({status:'open',url:'https://checkout.stripe.com/s/example'});
      }
      if (url.endsWith('billing_portal/sessions')) return Response.json({url:'https://billing.stripe.com/p/example'});
      const checkoutId = get(db,'SELECT checkout FROM audit_billing WHERE user_id=?',user).checkout;
      return Response.json({id:'sub_123',customer:'cus_123',metadata:{audit_user:user,audit_checkout:checkoutId},
        status,items:{data:[{price:{id:'price_month'},current_period_end:Math.floor(Date.now()/1000)+86400}]}});
    };
    await assert.rejects(checkout(db,config,user,'constructor',fetcher),{status:400});
    assert.equal(await checkout(db,config,user,'monthly',fetcher),'https://checkout.stripe.com/s/example');
    assert.equal(paid(db,session,'full'),false);
    assert.equal(billed(db,user),false);
    const event = {type:'checkout.session.completed',livemode:false,data:{object:{client_reference_id:user,subscription:'sub_123'}}};
    const raw = Buffer.from(JSON.stringify(event));
    const t = Math.floor(Date.now()/1000);
    const sig = createHmac('sha256',billing.webhook).update(t+'.').update(raw).digest('hex');
    assert.equal(checkStripeSignature(raw,'t='+t+',v1='+sig,billing.webhook),true);
    assert.equal(checkStripeSignature(raw,'t='+t+',v1='+sig,billing.webhook,Date.now()+3600000),false);
    assert.equal(checkStripeSignature(Buffer.from('other'),'t='+t+',v1='+sig,billing.webhook),false);
    await reconcile(db,billing,event,fetcher);
    assert.equal(billed(db,user),true);
    assert.equal(await portal(db,config,user,fetcher),'https://billing.stripe.com/p/example');
    run(db,'INSERT INTO audit_testers VALUES (?)',user);
    assert.equal(paid(db,session,'free'),false);
    assert.equal(paid(db,session,'full'),true);
    status = 'canceled';
    await reconcile(db,billing,{type:'customer.subscription.deleted',livemode:false,data:{object:{id:'sub_123',metadata:{audit_user:user}}}},fetcher);
    await reconcile(db,billing,event,fetcher);
    assert.equal(billed(db,user),false);
    assert.equal(paid(db,session,'full'),true);
  } finally { db.close(); }
});
