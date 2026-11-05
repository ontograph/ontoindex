class User { save() {} }
class Other { save() {} }
function factory() { try { throw Other; } catch (User) { return new User(); } }
function probe() { const u = factory(); u.save(); }
