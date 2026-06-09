'use strict';

const fs = require('node:fs');
const path = require('node:path');

const candidates = [
  path.join(__dirname, 'native', 'ontoindex_native.node'),
  path.join(__dirname, 'target', 'release', 'ontoindex_native.node'),
];

const nativePath = candidates.find((candidate) => fs.existsSync(candidate));

if (!nativePath) {
  throw new Error(
    `ontoindex-native has not been built. Run "npm run build" in ${__dirname}. Checked: ${candidates.join(', ')}`,
  );
}

module.exports = require(nativePath);
