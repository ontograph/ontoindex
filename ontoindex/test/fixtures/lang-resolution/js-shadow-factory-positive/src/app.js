class User { save() {} }
class Other { save() {} }
function factory() { return new User(); }
function probe() { const u = factory(); u.save(); }
