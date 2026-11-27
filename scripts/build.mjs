import { cpSync, mkdirSync } from 'node:fs';
import { database } from '../src/db.mjs';
import { createHandler } from '../src/app.mjs';

const db = database(':memory:');
try {
  createHandler(db,{origin:'https://pilot.example',name:'Relay',production:true});
  const output = new URL('../dist/',import.meta.url);
  mkdirSync(output,{recursive:true});
  for (const item of ['src','public','migrations']) {
    cpSync(new URL('../'+item,import.meta.url),new URL(item+'/',output),{recursive:true});
  }
  console.log('Release built in dist/.');
} finally { db.close(); }
