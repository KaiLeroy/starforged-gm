'use strict';
const fs = require('fs');
const path = require('path');

const roots = ['data'];
let count = 0;
function visit(entry) {
  const stat = fs.statSync(entry);
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(entry)) visit(path.join(entry, child));
  } else if (entry.endsWith('.json')) {
    JSON.parse(fs.readFileSync(entry, 'utf8'));
    count++;
  }
}
for (const root of roots) visit(root);
console.log(`Validated ${count} JSON files.`);
