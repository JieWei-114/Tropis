// Initialise a single-node replica set so MongoDB supports transactions.
// Runs once at container start via the mongo-init entrypoint script.
rs.initiate({
  _id: 'rs0',
  members: [{ _id: 0, host: 'mongodb:27017' }],
});
