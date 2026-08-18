const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'pr-body-templates');

function loadUnrealhogTemplate() {
  const content = fs.readFileSync(path.join(FIXTURES_DIR, 'unrealhog.md'), 'utf8');
  const sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  return { content, sha256 };
}

function loadUnrealhogCompletedBody() {
  return fs.readFileSync(path.join(FIXTURES_DIR, 'unrealhog-completed.md'), 'utf8');
}

module.exports = {
  loadUnrealhogTemplate,
  loadUnrealhogCompletedBody,
};
