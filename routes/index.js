/*
 * Connect all of your endpoints together here.
 */
module.exports = function (app, router) {
    // Register route modules on the shared router
    require('./home.js')(router);
    require('./users.js')(router);
    require('./tasks.js')(router);

    // Mount the configured router under /api once
    app.use('/api', router);
};