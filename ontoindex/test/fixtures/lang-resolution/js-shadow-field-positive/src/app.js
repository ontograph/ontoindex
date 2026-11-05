class User { save() {} }
class Other { save() {} }
class Store { constructor() { this.item = new User(); } }
function probe() { const s = new Store(); const {item} = s; item.save(); }
