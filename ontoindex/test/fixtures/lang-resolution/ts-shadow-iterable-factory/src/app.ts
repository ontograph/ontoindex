class User { save() {} }
class Other { save() {} }
function getUsers(): Array<User> { return []; }
function probe(getUsers) { const users = getUsers(); for (const u of users) { u.save(); } }
