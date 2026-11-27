import { bootstrap, database, get, run, seed, settings } from '../src/db.mjs';

const command = process.argv[2];
process.umask(0o077);
const db = database(settings().dbPath);
try {
  if (command === 'migrate') console.log('Database migrations applied.');
  else if (command === 'bootstrap') {
    const {user} = await bootstrap(db,process.env.BOOTSTRAP_EMAIL,process.env.BOOTSTRAP_PASSWORD,process.env.BOOTSTRAP_WORKSPACE);
    if (process.env.BOOTSTRAP_AUDIT_TESTER === '1') run(db,'INSERT INTO audit_testers VALUES (?)',user);
    console.log('First owner created.');
  } else if (command === 'seed') {
    const email = (process.env.BOOTSTRAP_EMAIL || '').toLowerCase().trim();
    const owner = get(db,"SELECT m.* FROM members m JOIN accounts a ON a.id=m.user_id WHERE a.email=? AND m.role='owner' ORDER BY m.workspace_id LIMIT 1",email);
    if (!owner) throw new Error('Set BOOTSTRAP_EMAIL to an existing owner email.');
    seed(db,owner.workspace_id,owner.user_id);
    console.log('Fictional sample installed.');
  } else if (command === 'audit-tester') {
    const [email,operation='grant'] = process.argv.slice(3);
    if (!email || !['grant','revoke'].includes(operation)) throw new Error('Use audit-tester EMAIL grant|revoke.');
    const account = get(db,'SELECT id FROM accounts WHERE email=?',email.toLowerCase().trim());
    if (!account) throw new Error('Create the intended account first and verify its ownership.');
    if (operation==='grant') run(db,'INSERT INTO audit_testers VALUES (?) ON CONFLICT DO NOTHING',account.id);
    else run(db,'DELETE FROM audit_testers WHERE user_id=?',account.id);
    console.log('Report preview access '+(operation==='grant' ? 'granted.' : 'revoked.'));
  } else throw new Error('Use migrate, bootstrap, seed, or audit-tester.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { db.close(); }
