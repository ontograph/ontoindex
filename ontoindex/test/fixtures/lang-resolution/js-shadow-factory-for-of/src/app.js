class User { save() {} }
class Other { save() {} }
function factory() { for (const User of choices) { return new User(); } }
function probe() { const u = factory(); u.save(); }
