class User { save() {} }
class Other { save() {} }
function getUsers(): Array<User> { return []; }
function probe(input) { const users = getUsers(); { const {users} = input; for (const u of users) { u.save(); } } }
