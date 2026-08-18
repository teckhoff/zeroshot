const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');

const {
  extractHeadings,
  sectionVisibleContent,
  wholeDocumentVisibleContent,
} = require('../src/pr-body-headings');

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'pr-body-templates');

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

describe('pr-body-headings extractor', function () {
  it('extracts the UnrealHog fixture heading sequence in order', function () {
    const headings = extractHeadings(readFixture('unrealhog.md'));
    assert.deepEqual(
      headings.map((h) => [h.level, h.normalizedText]),
      [
        [2, 'problem'],
        [2, 'changes'],
        [2, 'testing'],
        [2, 'docs update'],
        [2, 'agent context'],
      ]
    );
    headings.forEach((h, i) => assert.equal(h.ordinal, i));
  });

  it('ignores headings inside fenced code and recognizes setext headings', function () {
    const headings = extractHeadings(readFixture('fenced-and-setext.md'));
    assert.deepEqual(
      headings.map((h) => [h.level, h.text]),
      [
        [1, 'Setext Title'],
        [2, 'Setext Subtitle'],
        [2, 'Real ATX Heading'],
      ]
    );
  });

  it('produces no headings for a heading-free document with nonempty visible content', function () {
    const markdown = readFixture('heading-free.md');
    const headings = extractHeadings(markdown);
    assert.deepEqual(headings, []);
    assert.ok(wholeDocumentVisibleContent(markdown).length > 0);
  });

  it('ignores headings inside HTML comments', function () {
    const markdown = '## Real\ncontent\n<!--\n## Fake\n-->\nmore content';
    const headings = extractHeadings(markdown);
    assert.deepEqual(
      headings.map((h) => h.text),
      ['Real']
    );
  });

  it('supports duplicate heading text as distinct ordinals with independent sections', function () {
    const markdown = '## Foo\nfirst section\n## Foo\nsecond section';
    const headings = extractHeadings(markdown);
    assert.equal(headings.length, 2);
    assert.equal(sectionVisibleContent(markdown, headings[0]), 'first section');
    assert.equal(sectionVisibleContent(markdown, headings[1]), 'second section');
  });

  it('nests a subsection inside its parent until a same-or-higher-level heading appears', function () {
    const markdown = '# H1\nintro\n## H2\nnested\n# H1b\ntail';
    const headings = extractHeadings(markdown);
    assert.deepEqual(
      headings.map((h) => [h.level, h.text]),
      [
        [1, 'H1'],
        [2, 'H2'],
        [1, 'H1b'],
      ]
    );
    const h1Content = sectionVisibleContent(markdown, headings[0]);
    assert.ok(h1Content.includes('intro'));
    assert.ok(h1Content.includes('## H2'));
    assert.ok(h1Content.includes('nested'));
    assert.ok(!h1Content.includes('H1b'));
  });

  it('reports a comment-only section as having no visible content', function () {
    const markdown = '## testing\n<!-- fill this in -->\n## Next\nreal content';
    const headings = extractHeadings(markdown);
    assert.equal(sectionVisibleContent(markdown, headings[0]), '');
  });

  it('agrees on offsets for CRLF and LF variants of the same document', function () {
    const lf = '## A\nbody a\n## B\nbody b\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    const headingsLf = extractHeadings(lf);
    const headingsCrlf = extractHeadings(crlf);
    assert.deepEqual(
      headingsLf.map((h) => h.text),
      headingsCrlf.map((h) => h.text)
    );
    assert.equal(sectionVisibleContent(lf, headingsLf[0]), 'body a');
    assert.equal(sectionVisibleContent(crlf, headingsCrlf[0]), 'body a');
  });
});
