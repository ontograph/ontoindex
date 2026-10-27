const root = require("path").join(__dirname, "..", "..");
const { readFileSync } = require("fs");
const { createHash } = require("crypto");
const nativePath = typeof process.versions.bun === "string"
  ? require("path").join(root, "prebuilds", `${process.platform}-${process.arch}`, "tree-sitter-cpp.node")
  : require("node-gyp-build").path(root);
const nativeDigest = createHash("sha256").update(readFileSync(nativePath)).digest("hex");

module.exports =
  typeof process.versions.bun === "string"
    // Support `bun build --compile` by being statically analyzable enough to find the .node file at build-time
    ? require(`../../prebuilds/${process.platform}-${process.arch}/tree-sitter-cpp.node`)
    : require(nativePath);

if (createHash("sha256").update(readFileSync(nativePath)).digest("hex") !== nativeDigest) {
  throw new Error("C++ grammar changed; restart the process before parsing.");
}
Object.defineProperty(module.exports, "__ontoindexNativeIdentity", {
  value: Object.freeze({ path: nativePath, digest: nativeDigest }),
});

try {
  module.exports.nodeTypeInfo = require("../../src/node-types.json");
} catch (_) {}
