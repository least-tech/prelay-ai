import { chownSync } from 'node:fs';

// A hosted mount can arrive owned by root even when the image defaults to node.
if (process.getuid?.() === 0) {
  const nodeUid = 1000;
  const nodeGid = 1000;
  chownSync('/data',nodeUid,nodeGid);
  process.setgid(nodeGid);
  process.setuid(nodeUid);
}
await import('../dist/src/server.mjs');
