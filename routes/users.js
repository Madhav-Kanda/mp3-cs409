var mongoose = require('mongoose');
var User = require('../models/user');
var Task = require('../models/task');

module.exports = function (router) {

    function parseJSONParam(res, value, name) {
        if (value === undefined) return undefined;
        try {
            return JSON.parse(value);
        } catch (e) {
            res.status(400).json({ message: 'Invalid JSON for ' + name, data: {} });
            return null;
        }
    }

    function buildQueryParts(req, res) {
        var where = parseJSONParam(res, req.query.where, 'where');
        if (where === null) return null;
        var sort = parseJSONParam(res, req.query.sort, 'sort');
        if (sort === null) return null;
        var selectRaw = req.query.select !== undefined ? req.query.select : req.query.filter; // support legacy 'filter'
        var select = parseJSONParam(res, selectRaw, 'select');
        if (selectRaw !== undefined && select === null) return null;
        var skip = parseInt(req.query.skip || 0, 10);
        var limit = req.query.limit !== undefined ? parseInt(req.query.limit, 10) : undefined;
        var count = (req.query.count === 'true' || req.query.count === true);
        return { where: where || {}, sort: sort || undefined, select: select || undefined, skip: skip || 0, limit: limit, count: count };
    }

    // GET /users
    router.get('/users', async function (req, res) {
        var parts = buildQueryParts(req, res);
        if (parts === null) return; // error already sent

        try {
            if (parts.count) {
                var c = await User.countDocuments(parts.where);
                return res.status(200).json({ message: 'OK', data: c });
            }

            var q = User.find(parts.where);
            if (parts.sort) q = q.sort(parts.sort);
            if (parts.select) q = q.select(parts.select);
            if (parts.skip) q = q.skip(parts.skip);
            if (parts.limit !== undefined) q = q.limit(parts.limit);
            var users = await q.exec();
            return res.status(200).json({ message: 'OK', data: users });
        } catch (err) {
            return res.status(500).json({ message: 'Server error', data: {} });
        }
    });

    // POST /users
    router.post('/users', async function (req, res) {
        try {
            var name = req.body.name;
            var email = req.body.email;
            var pendingTasks = req.body.pendingTasks || [];

            if (!name || !email) {
                return res.status(400).json({ message: 'Name and email are required', data: {} });
            }

            var existing = await User.findOne({ email: email }).exec();
            if (existing) {
                return res.status(400).json({ message: 'Email already exists', data: {} });
            }

            var user = new User({ name: name, email: email, pendingTasks: Array.isArray(pendingTasks) ? pendingTasks : [] });
            await user.save();

            // Ensure two-way refs if pendingTasks were provided
            if (Array.isArray(pendingTasks) && pendingTasks.length) {
                await Task.updateMany(
                    { _id: { $in: pendingTasks } },
                    { $set: { assignedUser: String(user._id), assignedUserName: user.name, completed: false } }
                ).exec();
            }

            return res.status(201).json({ message: 'User created', data: user });
        } catch (err) {
            return res.status(500).json({ message: 'Server error', data: {} });
        }
    });

    // GET /users/:id
    router.get('/users/:id', async function (req, res) {
        var selectRaw = req.query.select !== undefined ? req.query.select : req.query.filter; // support legacy 'filter'
        var select = undefined;
        if (selectRaw !== undefined) {
            select = parseJSONParam(res, selectRaw, 'select');
            if (select === null) return;
        }

        try {
            var q = User.findById(req.params.id);
            if (select) q = q.select(select);
            var user = await q.exec();
            if (!user) return res.status(404).json({ message: 'User not found', data: {} });
            return res.status(200).json({ message: 'OK', data: user });
        } catch (err) {
            return res.status(500).json({ message: 'Server error', data: {} });
        }
    });

    // PUT /users/:id (replace entire user)
    router.put('/users/:id', async function (req, res) {
        try {
            var name = req.body.name;
            var email = req.body.email;
            var pendingTasks = req.body.pendingTasks || [];

            if (!name || !email) {
                return res.status(400).json({ message: 'Name and email are required', data: {} });
            }

            var user = await User.findById(req.params.id).exec();
            if (!user) return res.status(404).json({ message: 'User not found', data: {} });

            var emailOwner = await User.findOne({ email: email }).exec();
            if (emailOwner && String(emailOwner._id) !== String(user._id)) {
                return res.status(400).json({ message: 'Email already exists', data: {} });
            }

            // Validate all task IDs exist if provided
            if (pendingTasks && !Array.isArray(pendingTasks)) pendingTasks = [];
            if (pendingTasks.length) {
                var countExisting = await Task.countDocuments({ _id: { $in: pendingTasks } }).exec();
                if (countExisting !== pendingTasks.length) {
                    return res.status(400).json({ message: 'One or more pendingTasks IDs are invalid', data: {} });
                }
            }

            // Previous tasks assigned to this user
            var prevAssignedTasks = await Task.find({ assignedUser: String(user._id) }).select({ _id: 1 }).exec();
            var prevTaskIds = prevAssignedTasks.map(function (t) { return String(t._id); });

            // Update user fields
            user.name = name;
            user.email = email;
            user.pendingTasks = pendingTasks;
            await user.save();

            // Unassign tasks removed from pendingTasks
            var toUnassign = prevTaskIds.filter(function (id) { return pendingTasks.indexOf(id) === -1; });
            if (toUnassign.length) {
                await Task.updateMany(
                    { _id: { $in: toUnassign }, assignedUser: String(user._id) },
                    { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
                ).exec();
            }

            // Assign tasks now in pendingTasks
            if (pendingTasks.length) {
                await Task.updateMany(
                    { _id: { $in: pendingTasks } },
                    { $set: { assignedUser: String(user._id), assignedUserName: user.name, completed: false } }
                ).exec();
            }

            return res.status(200).json({ message: 'User updated', data: user });
        } catch (err) {
            return res.status(500).json({ message: 'Server error', data: {} });
        }
    });

    // DELETE /users/:id
    router.delete('/users/:id', async function (req, res) {
        try {
            var user = await User.findById(req.params.id).exec();
            if (!user) return res.status(404).json({ message: 'User not found', data: {} });

            // Unassign this user's tasks
            await Task.updateMany({ assignedUser: String(user._id) }, { $set: { assignedUser: '', assignedUserName: 'unassigned' } }).exec();

            await user.remove();
            return res.status(200).json({ message: 'User deleted', data: {} });
        } catch (err) {
            return res.status(500).json({ message: 'Server error', data: {} });
        }
    });

    return router;
};

