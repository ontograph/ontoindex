{
  "targets": [],
  "conditions": [
    ["OS=='linux'", {
      "targets": [
        {
          "target_name": "tree_sitter_typescript_binding",
          "dependencies": [
            "<!(node -p \"require('node-addon-api').targets\"):node_addon_api_except"
          ],
          "sources": [
            "bindings/node/binding.cc",
            "typescript/src/parser.c",
            "typescript/src/scanner.c",
            "tsx/src/parser.c",
            "tsx/src/scanner.c"
          ],
          "include_dirs": [
            "typescript/src",
            "tsx/src"
          ],
          "cflags_c": ["-std=c11"],
          "cflags_cc": ["-std=c++17"]
        }
      ]
    }]
  ]
}
