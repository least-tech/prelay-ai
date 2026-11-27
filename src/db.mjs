import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bad, emailAddress, field, hashPassword, instructions, now, Problem } from './domain.mjs';

export const id = randomUUID;
export function settings(env = process.env) {
  const production = env.NODE_ENV === 'production';
  if (production && (!env.APP_ORIGIN || !env.DATABASE_PATH)) throw new Error('Set APP_ORIGIN and DATABASE_PATH.');
  const origin = new URL(env.APP_ORIGIN || 'http://localhost:3000');
  if (origin.origin !== origin.href.slice(0,-1) || !['https:', 'http:'].includes(origin.protocol)
      || (production && origin.protocol !== 'https:')) throw new Error('APP_ORIGIN must be an exact origin using HTTPS in production.');
  const boundedInteger = (key, fallback, maximum) => {
    const limit = Number(env[key] || fallback);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new Error('Invalid ' + key);
    return limit;
  };
  return {
    name: field(env.APP_NAME || 'Relay','App name',60), origin: origin.origin, production, publicSignup:env.AUDIT_PUBLIC_SIGNUP === '1',
    dbPath: env.DATABASE_PATH || './data/relay.sqlite',
    port: boundedInteger('PORT',3000,65535), host: env.HOST || '127.0.0.1',
    aiKey: env.OPENAI_API_KEY, aiModel: env.OPENAI_MODEL || 'gpt-4.1-mini',
    workspaceLimit: boundedInteger('AI_WORKSPACE_DAILY_LIMIT',20,10000),
    installationLimit: boundedInteger('AI_INSTALLATION_DAILY_LIMIT',100,10000)
  };
}

export function database(path) {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (file TEXT PRIMARY KEY) STRICT');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations).filter(file => /^\d+_.+\.sql$/.test(file)).sort()) {
    transaction(db, () => {
      if (get(db,'SELECT file FROM schema_migrations WHERE file=?',file)) return;
      db.exec(readFileSync(new URL(file,migrations),'utf8'));
      run(db,'INSERT INTO schema_migrations VALUES (?)',file);
    });
  }
  return db;
}
export const get = (db,sql,...params) => db.prepare(sql).get(...params);
export const all = (db,sql,...params) => db.prepare(sql).all(...params);
export const run = (db,sql,...params) => db.prepare(sql).run(...params);

export function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function createWorkflow(db, workspace, user, name, body = instructions, fictional = 0) {
  const workflow = id();
  run(db,'INSERT INTO workflows VALUES (?,?,?,?,1,?)',workflow,workspace,user,name,fictional);
  run(db,'INSERT INTO versions VALUES (?,1,?,?)',workflow,body,now());
  return workflow;
}

export async function bootstrap(db, email, password, name) {
  const address = emailAddress(email);
  const hash = await hashPassword(password);
  const label = field(name || 'Pilot Workspace','Workspace name',80);
  return transaction(db, () => {
    if (get(db,'SELECT id FROM workspaces LIMIT 1')) throw new Problem(409,'The first owner has already been created.');
    return provisionWorkspace(db,address,hash,label);
  });
}

// Operator-only provisioning also lets integration tests create an unrelated tenant.
export function provisionWorkspace(db, email, hash, label) {
  const user = id();
  const workspace = id();
  run(db,'INSERT INTO accounts VALUES (?,?,?)',user,email,hash);
  run(db,'INSERT INTO workspaces VALUES (?,?)',workspace,label);
  run(db,"INSERT INTO members VALUES (?,?,'owner')",workspace,user);
  const workflow = createWorkflow(db,workspace,user,'Campaign localization');
  return { workspace, user, workflow };
}

export function seed(db, workspace, user) {
  return transaction(db, () => {
    const existing = get(db,'SELECT id FROM workflows WHERE workspace_id=? AND fictional=1',workspace);
    if (existing) return existing.id;
    const workflow = createWorkflow(db,workspace,user,'Sample · Harbor Film Club',instructions,1);
    const input = JSON.stringify({
      source:'Bring a friend to Harbor Film Club this Friday. Two seats for USD 18.',
      audience:'Local film fans', tone:'Warm and direct',
      terms:'Friday, 7 pm. Two seats for USD 18. Limited availability.',
      languages:['English','Traditional Chinese']
    });
    const original = 'English\nSee you Friday!\n\n繁體中文\n星期五見！';
    const output = 'English\nBring a friend to Harbor Film Club this Friday at 7 pm. Two seats for USD 18. Limited availability.\n\n繁體中文\n今個星期五晚上 7 點，約朋友一齊嚟 Harbor Film Club！雙人門票 US$18，名額有限。';
    const stamp = now();
    run(db,`INSERT INTO runs (id,workspace_id,workflow_id,version,user_id,input_json,original,current_output,approved_output,
      status,origin,created,approved_at,active_minutes,revisions,reviewed,fictional)
      VALUES (?,?,?,1,?,?,?,?,?,'approved','Pasted',?,?,7,1,1,1)`,id(),workspace,workflow,user,input,original,output,output,stamp-1_200_000,stamp);
    run(db,'INSERT INTO baselines VALUES (?,?,?,?,?,?,?,?,1)',id(),workspace,workflow,'Fictional prior localization',18,1,1,50);
    return workflow;
  });
}

export function reserveAi(db, workspace, config) {
  const today = new Date().toISOString().slice(0,10);
  transaction(db, () => {
    for (const [scope,limit] of [['installation',config.installationLimit],[workspace,config.workspaceLimit]]) {
      const previous = get(db,'SELECT calls FROM ai_quota WHERE scope=? AND day=?',scope,today);
      if (previous && previous.calls >= limit) throw new Problem(429,'The daily AI limit has been reached. You can still paste an output.');
      run(db,'INSERT INTO ai_quota VALUES (?,?,1) ON CONFLICT(scope,day) DO UPDATE SET calls=calls+1',scope,today);
    }
    run(db,'DELETE FROM ai_quota WHERE day<?',new Date(now()-172_800_000).toISOString().slice(0,10));
  });
}

export function requireOwner(session) {
  if (session.role !== 'owner') throw new Problem(403,'Only workspace owners can do that.');
}

export function modelCost(db, workspace, model, input, output) {
  const rate = get(db,'SELECT * FROM rates WHERE workspace_id=? AND model=?',workspace,model);
  return rate && input != null && output != null ? (input*rate.input_usd + output*rate.output_usd)/1e6 : null;
}

export function option(form, name, valid) {
  const value = form.get(name);
  if (!valid.includes(value)) bad('Choose a valid ' + name + '.');
  return value;
}
