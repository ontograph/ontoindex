class Address {
    var city: String = ""

    func save() {
        // persist address
    }
}

class User {
    var name: String = ""
    var address: Address = Address()

    func greet() -> String {
        return name
    }
}
