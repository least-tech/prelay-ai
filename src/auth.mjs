import { id, get, provisionWorkspace, run, transaction } from './db.mjs';
import { bad, day, emailAddress, field, hashPassword, now, passwordMatches, Problem, sha, token } from './domain.mjs';

export function sessionFor(db, request) {
  const cookie = (request.headers.cookie || '').match(/(?:^|;\s*)relay_session=([A-Za-z0-9_-]{43})(?:;|$)/);
  if (!cookie) return null;
  return get(db,"SELECT s.digest,s.user_id,s.workspace_id,a.email,m.role,w.name AS workspace_name FROM sessions s JOIN accounts a ON a.id=s.user_id JOIN members m ON m.workspace_id=s.workspace_id AND m.user_id=s.user_id JOIN workspaces w ON w.id=s.workspace_id WHERE s.digest=? AND s.expires>?",sha(cookie[1]),now()) || null;
}

function setSession(db, request, user, workspace) {
  const value = token();
  const previous = sessionFor(db,request);
  if (previous) run(db,'DELETE FROM sessions WHERE digest=?',previous.digest);
  run(db,'DELETE FROM sessions WHERE expires<=?',now());
  run(db,'INSERT INTO sessions VALUES (?,?,?,?)',sha(value),user,workspace,now()+7*day);
  return value;
}

function attempt(db, email) {
  // The global bucket also caps scrypt work regardless of source or email rotation.
  const window = Math.floor(now()/600_000);
  transaction(db, () => {
    run(db,'DELETE FROM auth_attempts WHERE window<?',window-1);
    for (const [key,limit] of [['email:'+email,10],['installation',200]]) {
      const bucket = sha(key);
      const previous = get(db,'SELECT attempts,window FROM auth_attempts WHERE bucket=?',bucket);
      if (previous?.window === window && previous.attempts >= limit) throw new Problem(429,'Too many sign-in attempts. Try again in a few minutes.');
      run(db,'INSERT INTO auth_attempts VALUES (?,?,1) ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN window=excluded.window THEN attempts+1 ELSE 1 END, window=excluded.window',bucket,window);
    }
  });
}

function validInvite(db, value) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) bad('This invite is invalid, expired, revoked, or already used.');
  const invite = get(db,'SELECT * FROM invites WHERE digest=?',sha(value));
  if (!invite || invite.consumed || invite.revoked || invite.expires <= now()) bad('This invite is invalid, expired, revoked, or already used.');
  return invite;
}

export async function authenticate(db, request, form, joining) {
  const inviteCode = joining ? field(form.get('invite'),'Invite code',100) : '';
  const email = emailAddress(form.get('email'));
  const password = form.get('password');
  attempt(db,email);
  const invite = joining ? validInvite(db,inviteCode) : null;
  if (invite && invite.email !== email) bad('Use the email address that received the invite.');
  let account = get(db,'SELECT * FROM accounts WHERE email=?',email);
  let newHash = null;
  if (account || !invite) {
    if (!(await passwordMatches(password,account?.password))) throw new Problem(401,'The email or password is incorrect.');
  } else newHash = await hashPassword(password);
  return transaction(db, () => {
    if (invite) {
      validInvite(db,inviteCode);
      if (!account) {
        if (get(db,'SELECT id FROM accounts WHERE email=?',email)) throw new Problem(409,'This account was created while you were joining. Reopen the link and enter its existing password.');
        account = {id:id()};
        run(db,'INSERT INTO accounts VALUES (?,?,?)',account.id,email,newHash);
      }
      run(db,"INSERT INTO members VALUES (?,?,'member') ON CONFLICT DO NOTHING",invite.workspace_id,account.id);
      run(db,'UPDATE invites SET consumed=? WHERE id=?',now(),invite.id);
    }
    const workspace = invite?.workspace_id || get(db,"SELECT workspace_id FROM members WHERE user_id=? ORDER BY role='owner' DESC,workspace_id LIMIT 1",account.id)?.workspace_id;
    if (!workspace) throw new Problem(403,'Your account needs a workspace invitation.');
    return setSession(db,request,account.id,workspace);
  });
}

export async function registerAudit(db,request,form) {
  const email = emailAddress(form.get('email'));
  attempt(db,email);
  const hash = await hashPassword(form.get('password'));
  return transaction(db,()=>{
    if (get(db,'SELECT id FROM accounts WHERE email=?',email)) {
      throw new Problem(409,'An account already exists for this email. Sign in to continue.');
    }
    const {user,workspace} = provisionWorkspace(db,email,hash,'Personal workspace');
    return setSession(db,request,user,workspace);
  });
}

export function switchWorkspace(db, request, session, workspace) {
  if (!get(db,'SELECT 1 FROM members WHERE workspace_id=? AND user_id=?',workspace,session.user_id)) throw new Problem(403,'This workspace is unavailable.');
  return transaction(db,() => setSession(db,request,session.user_id,workspace));
}

export function cookie(config, value) {
  return 'relay_session='+value+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+(value ? 604800 : 0)
    +(config.production || config.origin.startsWith('https:') ? '; Secure' : '');
}
