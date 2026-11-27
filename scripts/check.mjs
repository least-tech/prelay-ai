import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { database, all, get } from '../src/db.mjs';

const mode = process.argv[2];
if (mode === 'lint') {
  const directories = ['src','scripts','public','test','migrations'];
  for (const directory of directories) {
    for (const file of readdirSync(directory,{recursive:true}).filter(name=>/\.(?:mjs|js|sql)$/.test(name))) {
      const path = join(directory,file);
      const source = readFileSync(path,'utf8');
      assert.ok(!source.includes('\t'),path+' contains a tab');
      assert.ok(source.endsWith('\n'),path+' must end in a newline');
      assert.ok(!source.split(/\r?\n/).some(line=>/[ \t]+$/.test(line)),path+' contains trailing whitespace');
      if (!file.endsWith('.sql')) {
        const checked = spawnSync(process.execPath,['--check',path],{stdio:'inherit'});
        assert.equal(checked.status,0,path+' failed the syntax check');
      }
    }
  }
  console.log('Source syntax and whitespace checks passed.');
} else if (mode === 'typecheck') {
  // This JavaScript app uses runtime types at HTTP, CSV, configuration and SQLite boundaries.
  const db = database(':memory:');
  try {
    const expected = {
      accounts:{id:'TEXT',email:'TEXT',password:'TEXT'},
      sessions:{digest:'TEXT',expires:'INTEGER'},
      invites:{expires:'INTEGER',revoked:'INTEGER',consumed:'INTEGER'},
      versions:{number:'INTEGER',instructions:'TEXT'},
      runs:{version:'INTEGER',input_json:'TEXT',status:'TEXT',active_minutes:'REAL',revisions:'INTEGER',approved_at:'INTEGER'},
      baselines:{minutes:'REAL',revisions:'INTEGER',approved:'INTEGER',elapsed_minutes:'REAL'},
      usage:{input_tokens:'INTEGER',output_tokens:'INTEGER',latency_ms:'INTEGER',cost_usd:'REAL',cost_type:'TEXT'},
      ai_quota:{calls:'INTEGER'},
      audit_snapshots:{user_id:'TEXT',source:'TEXT',imported:'INTEGER',report:'TEXT'},
      audit_billing:{entitled:'INTEGER',entitlement_until:'INTEGER',revision:'INTEGER'},
      audit_testers:{user_id:'TEXT'}
    };
    for (const [table,fields] of Object.entries(expected)) {
      assert.equal(get(db,'SELECT strict FROM pragma_table_list WHERE name=?',table).strict,1);
      const byName = Object.fromEntries(all(db,'SELECT name,type FROM pragma_table_info(?)',table).map(column=>[column.name,column.type]));
      for (const [field,type] of Object.entries(fields)) assert.equal(byName[field],type,table+'.'+field);
    }
    assert.equal(get(db,'PRAGMA foreign_keys').foreign_keys,1);
    assert.deepEqual(all(db,'PRAGMA foreign_key_check'),[]);
    assert.equal(get(db,'PRAGMA quick_check').quick_check,'ok');
  } finally { db.close(); }
  console.log('Strict database type contracts passed. Request, CSV and response types are exercised in tests.');
} else throw new Error('Pass lint or typecheck.');
