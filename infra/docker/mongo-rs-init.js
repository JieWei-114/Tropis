// Initialise a single-node replica set so MongoDB supports transactions and
// change streams. Runs once on first container start via the entrypoint's
// /docker-entrypoint-initdb.d hook.
//
// The member is seeded as `localhost:27017` because that is the only address
// that works here: the initdb phase runs a temporary mongod bound to loopback
// only, so any other host fails the "isSelf" check ("No host described in new
// configuration maps to this node") and the container exits. That applies to
// `rs.reconfig` in this script too, not just to `rs.initiate`.
//
// A set that advertises `localhost` is only usable by clients that skip
// topology discovery (`directConnection=true`). The `mongo-rs-reconfig`
// service moves the member to the compose service name once the real mongod is
// listening — see the comment on that service in docker-compose.yml.
rs.initiate({
  _id: 'rs0',
  members: [{ _id: 0, host: 'localhost:27017' }],
});
