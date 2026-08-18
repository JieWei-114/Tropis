// Initialise a single-node replica set so MongoDB supports transactions and
// change streams. Runs once on first container start via the entrypoint's
// /docker-entrypoint-initdb.d hook.
//
// Host is `localhost:27017` (not the compose service name): during the initdb
// phase the node only knows itself as localhost, so `mongodb:27017` fails the
// "isSelf" check ("No host described in new configuration maps to this node")
// and the container exits. With `--bind_ip_all` the node also listens on
// localhost, and a single-node RS reached via `directConnection=true` does not
// need a routable member hostname.
rs.initiate({
  _id: 'rs0',
  members: [{ _id: 0, host: 'localhost:27017' }],
});
