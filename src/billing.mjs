import { createHmac, timingSafeEqual } from 'node:crypto';
import { get, id, run, transaction } from './db.mjs';
import { now, Problem } from './domain.mjs';
import { pricing } from './audit.mjs';

export const tester = (db,user) => Boolean(get(db,'SELECT 1 FROM audit_testers WHERE user_id=?',user));
export const billed = (db,user) => Boolean(get(db,'SELECT 1 FROM audit_billing WHERE user_id=? AND entitled=1 AND entitlement_until>?',user,now()));
export const paid = (db,session,mode) => mode && tester(db,session.user_id) ? mode==='full' : billed(db,session.user_id);

export function billingSettings(env) {
  const secret = env.STRIPE_SECRET_KEY;
  const webhook = env.STRIPE_WEBHOOK_SECRET;
  const monthly = env.STRIPE_MONTHLY_PRICE;
  const annual = env.STRIPE_ANNUAL_PRICE;
  if (![secret,webhook,monthly,annual].some(Boolean)) return null;
  if (!/^(sk|rk)_(live|test)_\S+$/.test(secret || '') || !/^whsec_\S+$/.test(webhook || '')
      || [monthly,annual].some(value=>!/^price_\w+$/.test(value || '')) || monthly===annual) {
    throw new Error('Configure the Stripe secret, webhook signing secret, and two distinct recurring price IDs.');
  }
  return {secret,webhook,prices:{monthly,annual},live:secret.includes('_live_')};
}

async function stripe(config,path,fetcher,fields,key) {
  const headers = {Authorization:'Bearer '+config.secret};
  if (key) headers['Idempotency-Key'] = key;
  try {
    const response = await fetcher('https://api.stripe.com/v1/'+path,{
      method:fields ? 'POST' : 'GET',headers,body:fields ? new URLSearchParams(fields) : undefined,
      redirect:'error',signal:AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error('Stripe request failed');
    return await response.json();
  } catch {
    throw new Problem(502,'Billing is temporarily unavailable. Please try again.');
  }
}

function billingUrl(value, hostname) {
  let url;
  try { url = new URL(value); } catch { throw new Problem(502,'Stripe did not return a checkout link.'); }
  if (url.protocol !== 'https:' || url.hostname !== hostname || url.username || url.password || url.port) {
    throw new Problem(502,'Stripe did not return a supported billing link.');
  }
  return url.href;
}

const stripeId = (value,prefix) => typeof value==='string' && new RegExp('^'+prefix+'_\\w+$').test(value);

export async function checkout(db,config,user,plan,fetcher=fetch) {
  const settings = config.billing;
  if (!settings) throw new Problem(503,'Checkout is currently unavailable.');
  if (!Object.hasOwn(pricing,plan)) throw new Problem(400,'Choose a membership plan.');
  const price = settings.prices[plan];
  const product = await stripe(settings,'prices/'+price,fetcher);
  const expected = pricing[plan];
  if (product.id!==price || product.active!==true || product.currency!=='usd' || product.unit_amount!==expected.amount
      || product.recurring?.interval!==expected.interval || product.recurring?.interval_count!==1) {
    throw new Problem(503,'This billing plan is temporarily unavailable.');
  }
  const next = transaction(db,()=>{
    run(db,'INSERT INTO audit_billing(user_id) VALUES (?) ON CONFLICT DO NOTHING',user);
    const item = get(db,'SELECT * FROM audit_billing WHERE user_id=?',user);
    if (item.subscription) throw new Problem(409,'Manage your membership in the billing portal.');
    if (item.checkout_until>now()) return item.checkout;
    const nonce = plan+'_'+id();
    run(db,'UPDATE audit_billing SET checkout=?,checkout_until=? WHERE user_id=?',nonce,now()+24*3600_000,user);
    return nonce;
  });
  if (!next.startsWith(plan+'_')) throw new Problem(409,'You already started checkout for the other plan. Reopen that plan to continue.');
  const customer = get(db,'SELECT customer FROM audit_billing WHERE user_id=?',user).customer;
  const fields = {
    mode:'subscription', 'line_items[0][price]':price, 'line_items[0][quantity]':'1',
    success_url:config.origin+'/audit?billing=pending',cancel_url:config.origin+'/audit?billing=cancelled',
    client_reference_id:user,'subscription_data[metadata][audit_user]':user,
    'subscription_data[metadata][audit_checkout]':next
  };
  if (customer) fields.customer = customer;
  const session = await stripe(settings,'checkout/sessions',fetcher,fields,next);
  if (session.status!=='open') throw new Problem(409,'Checkout has ended. Refresh the report to check your billing status.');
  return billingUrl(session.url,'checkout.stripe.com');
}

export async function portal(db,config,user,fetcher=fetch) {
  const row = get(db,'SELECT customer FROM audit_billing WHERE user_id=?',user);
  if (!config.billing || !row?.customer) throw new Problem(404,'Your account has no billing profile yet.');
  const session = await stripe(config.billing,'billing_portal/sessions',fetcher,{customer:row.customer,return_url:config.origin+'/audit'});
  return billingUrl(session.url,'billing.stripe.com');
}

export function checkStripeSignature(raw,header,secret,clock=now()) {
  const parts = typeof header==='string' ? header.split(',') : [];
  const timestamp = parts.find(part=>part.startsWith('t='))?.slice(2);
  if (!/^\d{1,12}$/.test(timestamp || '') || Math.abs(clock/1000-Number(timestamp))>300) return false;
  const digest = createHmac('sha256',secret).update(timestamp+'.').update(raw).digest();
  return parts.some(part=>/^v1=[a-f0-9]{64}$/i.test(part) && timingSafeEqual(digest,Buffer.from(part.slice(3),'hex')));
}

export async function reconcile(db,config,event,fetcher=fetch) {
  const data = event.data?.object;
  if (!data || event.livemode!==config.live) return;
  if (event.type==='checkout.session.expired') {
    const user = data.client_reference_id;
    if (typeof user!=='string' || data.mode!=='subscription' || !stripeId(data.id,'cs')) return;
    const item = get(db,'SELECT checkout FROM audit_billing WHERE user_id=?',user);
    if (!item?.checkout) return;
    // The stored deadline matches Stripe's default checkout lifetime. Older expiration events cannot clear a fresh attempt.
    if (Number.isFinite(data.expires_at) && data.expires_at*1000<=now()) {
      run(db,'UPDATE audit_billing SET checkout_until=0 WHERE user_id=? AND checkout=? AND checkout_until<=?',
        user,item.checkout,data.expires_at*1000);
    }
    return;
  }
  const subscriptionEvents = new Set(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','customer.subscription.paused','customer.subscription.resumed']);
  const checkoutEvents = new Set(['checkout.session.completed','checkout.session.async_payment_succeeded']);
  const isSubscription = subscriptionEvents.has(event.type);
  if (!isSubscription && !checkoutEvents.has(event.type)) return;
  const subscription = isSubscription ? data.id : data.subscription;
  const user = isSubscription ? data.metadata?.audit_user : data.client_reference_id;
  if (!stripeId(subscription,'sub') || typeof user!=='string') return;
  // Read Stripe's current state to make retries and out-of-order deliveries converge.
  for (let attempt=0;attempt<4;attempt++) {
    const row = get(db,'SELECT * FROM audit_billing WHERE user_id=?',user);
    if (!row) return;
    const current = await stripe(config,'subscriptions/'+subscription,fetcher);
    if (current.id!==subscription || current.metadata?.audit_user!==user || !stripeId(current.customer,'cus')
        || (row.customer && row.customer!==current.customer)
        || (row.subscription!==subscription && (!row.checkout || row.checkout!==current.metadata?.audit_checkout))) return;
    const eligible = current.items?.data?.find(item=>Object.values(config.prices).includes(item.price?.id));
    const entitled = Number(Boolean(eligible) && ['active','trialing'].includes(current.status));
    const periodEnd = eligible?.current_period_end ?? current.current_period_end;
    if (entitled && (!Number.isSafeInteger(periodEnd) || periodEnd<=0 || periodEnd>4.1e9)) throw new Problem(502,'Stripe did not provide a billing period.');
    const terminal = ['canceled','incomplete_expired'].includes(current.status);
    const result = run(db,`UPDATE audit_billing SET customer=?,subscription=?,entitled=?,entitlement_until=?,
      checkout=NULL,checkout_until=0,revision=revision+1 WHERE user_id=? AND revision=? AND checkout IS ?`,
      current.customer,terminal ? null : subscription,entitled,entitled ? periodEnd*1000 : 0,user,row.revision,row.checkout);
    if (result.changes) return;
  }
  throw new Problem(503,'Billing status changed during processing. Retry this event.');
}
