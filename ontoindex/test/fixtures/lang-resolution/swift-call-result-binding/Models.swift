class User {
    var name: String = ""

    func save() -> Bool {
        return true
    }
}

func getUser(name: String) -> User {
    return User()
}
