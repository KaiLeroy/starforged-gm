'use strict';
const pkg = require('../package.json');
const tag = process.env.GITHUB_REF_NAME;
if (tag !== `v${pkg.version}`) {
  throw new Error(`Release tag ${tag || '(missing)'} does not match package version v${pkg.version}.`);
}
