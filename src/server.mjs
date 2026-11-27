import { createServer } from 'node:http';
import { bootstrap, database, get, run, settings } from './db.mjs';
import { billingSettings } from './billing.mjs';
import { createHandler } from './app.mjs';

process.umask(0o077);
const config = {...settings(),billing:billingSettings(process.env)};
const db = database(config.dbPath);
if (process.env.BOOTSTRAP_ON_START === '1' && !get(db,'SELECT id FROM workspaces LIMIT 1')) {
  const {user} = await bootstrap(db,process.env.BOOTSTRAP_EMAIL,process.env.BOOTSTRAP_PASSWORD,process.env.BOOTSTRAP_WORKSPACE);
  if (process.env.BOOTSTRAP_AUDIT_TESTER === '1') run(db,'INSERT INTO audit_testers VALUES (?)',user);
  console.log('First owner created. Remove bootstrap credentials.');
}
const server = createServer({requestTimeout:60_000, headersTimeout:15_000, maxHeaderSize:12_288},createHandler(db,config));
server.listen(config.port,config.host,() => console.log('Relay listening on port '+config.port+'.'));
for (const signal of ['SIGTERM','SIGINT']) {
  process.once(signal,() => server.close(() => db.close()));
}
