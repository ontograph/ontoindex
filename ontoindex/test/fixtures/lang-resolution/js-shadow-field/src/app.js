class User { save() {} }
class Other { save() {} }
class Store { constructor(User) { this.item = new User(); } }
function probe() { const s = new Store(Other); const {item} = s; item.save(); }
