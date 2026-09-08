// Point the single-node replica set at its compose service name.
//
// Idempotent: exits immediately when the member already carries the right host,
// so a restart of the stack is a no-op.
const TARGET = 'mongodb:27017';

for (let i = 0; i < 60 && !rs.isMaster().ismaster; i++) sleep(1000);
if (!rs.isMaster().ismaster) {
  print('replica set has no primary after 60s — leaving the config alone');
  quit(1);
}

const conf = rs.conf();
if (conf.members[0].host === TARGET) {
  print(`member already advertises ${TARGET} — nothing to do`);
  quit(0);
}

conf.members[0].host = TARGET;
conf.version += 1;
rs.reconfig(conf);
print(`member now advertises ${TARGET}`);
