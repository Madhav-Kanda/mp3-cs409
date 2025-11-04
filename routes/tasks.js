var mongoose = require('mongoose');
var Task = require('../models/task');
var User = require('../models/user');

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
        var limit = req.query.limit !== undefined ? parseInt(req.query.limit, 10) : 100; // default 100
        var count = (req.query.count === 'true' || req.query.count === true);
        return { where: where || {}, sort: sort || undefined, select: select || undefined, skip: skip || 0, limit: limit, count: count };
    }

    // GET /tasks
    router.get('/tasks', async function (req, res) {
        var parts = buildQueryParts(req, res);
        if (parts === null) return;

        try {
            if (parts.count) {
                var c = await Task.countDocuments(parts.where);
                return res.status(200).json({ message: 'OK', data: c });
            }

            var q = Task.find(parts.where);
            if (parts.sort) q = q.sort(parts.sort);
            if (parts.select) q = q.select(parts.select);
            if (parts.skip) q = q.skip(parts.skip);
            if (parts.limit !== undefined) q = q.limit(parts.limit);
            var tasks = await q.exec();
            return res.status(200).json({ message: 'OK', data: tasks });
        } catch (err) {
            return res.status(500).json({ message: 'Server error', data: {} });
        }
    });

    // POST /tasks
    router.post('/tasks', async function (req, res) {
        try {
            var name = req.body.name;
            var description = req.body.description || '';
            var deadlineRaw = req.body.deadline;
            var completed = String(req.body.completed).toLowerCase() === 'true' || req.body.completed === true;
            var assignedUser = req.body.assignedUser || '';

            if (!name || !deadlineRaw) {
                return res.status(400).json({ message: 'Name and deadline are required', data: {} });
            }

            var deadlineDate;
            if (typeof deadlineRaw === 'string' || typeof deadlineRaw === 'number') {
                var ms = parseInt(deadlineRaw, 10);
                if (!isNaN(ms)) {
                    deadlineDate = new Date(ms);
                } else {
                    deadlineDate = new Date(deadlineRaw);
                }
            } else if (deadlineRaw instanceof Date) {
                deadlineDate = deadlineRaw;
            }
            if (!deadlineDate || isNaN(deadlineDate.getTime())) {
                return res.status(400).json({ message: 'Invalid deadline', data: {} });
            }

            var assignedUserName = 'unassigned';
            if (assignedUser) {
                var user = await User.findById(assignedUser).exec();
                if (!user) return res.status(400).json({ message: 'Assigned user not found', data: {} });
                assignedUserName = user.name;
            }

            var task = new Task({
                name: name,
                description: description,
                deadline: deadlineDate,
                completed: completed,
                assignedUser: assignedUser,
                assignedUserName: assignedUser ? assignedUserName : 'unassigned'
            });
            await task.save();

            if (assignedUser && !completed) {
                await User.updateOne(
                    { _id: assignedUser },
                    { $addToSet: { pendingTasks: String(task._id) } }
                ).exec();
            }

            return res.status(201).json({ message: 'Task created', data: task });
        } catch (err) {
            return res.status(500).json({ message: 'Server error', data: {} });
        }
    });

    // GET /tasks/:id
    router.get('/tasks/:id', async function (req, res) {
        var selectRaw = req.query.select !== undefined ? req.query.select : req.query.filter; // support legacy 'filter'
        var select = undefined;
        if (selectRaw !== undefined) {
            select = parseJSONParam(res, selectRaw, 'select');
            if (select === null) return;
        }

        try {
            var q = Task.findById(req.params.id);
            if (select) q = q.select(select);
            var task = await q.exec();
            if (!task) return res.status(404).json({ message: 'Task not found', data: {} });
            return res.status(200).json({ message: 'OK', data: task });
        } catch (err) {
            return res.status(500).json({ message: 'Server error', data: {} });
        }
    });

    // PUT /tasks/:id (replace entire task)
    router.put('/tasks/:id', async function (req, res) {
        try {
            var name = req.body.name;
            var description = req.body.description || '';
            var deadlineRaw = req.body.deadline;
            var completed = String(req.body.completed).toLowerCase() === 'true' || req.body.completed === true;
            var assignedUser = req.body.assignedUser || '';

            if (!name || !deadlineRaw) {
                return res.status(400).json({ message: 'Name and deadline are required', data: {} });
            }

            var task = await Task.findById(req.params.id).exec();
            if (!task) return res.status(404).json({ message: 'Task not found', data: {} });

            var prevAssignedUser = task.assignedUser;
            var prevCompleted = task.completed;

            var deadlineDate;
            if (typeof deadlineRaw === 'string' || typeof deadlineRaw === 'number') {
                var ms = parseInt(deadlineRaw, 10);
                if (!isNaN(ms)) {
                    deadlineDate = new Date(ms);
                } else {
                    deadlineDate = new Date(deadlineRaw);
                }
            } else if (deadlineRaw instanceof Date) {
                deadlineDate = deadlineRaw;
            }
            if (!deadlineDate || isNaN(deadlineDate.getTime())) {
                return res.status(400).json({ message: 'Invalid deadline', data: {} });
            }

            var assignedUserName = 'unassigned';
            if (assignedUser) {
                var user = await User.findById(assignedUser).exec();
                if (!user) return res.status(400).json({ message: 'Assigned user not found', data: {} });
                assignedUserName = user.name;
            }

            task.name = name;
            task.description = description;
            task.deadline = deadlineDate;
            task.completed = completed;
            task.assignedUser = assignedUser;
            task.assignedUserName = assignedUser ? assignedUserName : 'unassigned';
            await task.save();

            // Two-way updates
            var taskIdStr = String(task._id);
            if (prevAssignedUser && (prevAssignedUser !== assignedUser || (!prevCompleted && completed))) {
                await User.updateOne(
                    { _id: prevAssignedUser },
                    { $pull: { pendingTasks: taskIdStr } }
                ).exec();
            }
            if (assignedUser && !completed) {
                await User.updateOne(
                    { _id: assignedUser },
                    { $addToSet: { pendingTasks: taskIdStr } }
                ).exec();
            }

            return res.status(200).json({ message: 'Task updated', data: task });
        } catch (err) {
            return res.status(500).json({ message: 'Server error', data: {} });
        }
    });

    // DELETE /tasks/:id
    router.delete('/tasks/:id', async function (req, res) {
        try {
            var task = await Task.findById(req.params.id).exec();
            if (!task) return res.status(404).json({ message: 'Task not found', data: {} });

            if (task.assignedUser) {
                await User.updateOne(
                    { _id: task.assignedUser },
                    { $pull: { pendingTasks: String(task._id) } }
                ).exec();
            }

            await task.remove();
            return res.status(200).json({ message: 'Task deleted', data: {} });
        } catch (err) {
            return res.status(500).json({ message: 'Server error', data: {} });
        }
    });

    return router;
};

