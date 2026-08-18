/**
 * Minimal CommonMark heading extractor for PR body templates.
 *
 * Recognizes ATX (`#`) and setext (`===`/`---`) headings. Headings inside
 * fenced code blocks or HTML comments are not headings. Offsets are computed
 * against a newline-normalized (LF) copy of the input so repeated calls with
 * CRLF/LF variants of equivalent text agree.
 */

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

function stripHtmlComments(input) {
  let current = input;
  let previous;
  do {
    previous = current;
    current = current.replace(HTML_COMMENT_RE, '');
  } while (current !== previous);
  return current;
}

function normalizeNewlines(markdown) {
  return markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizeHeadingText(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function parseAtxHeading(line) {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(line);
  if (!match) return null;
  const level = match[1].length;
  let text = match[2] || '';
  text = text.replace(/(^|[ \t])#+[ \t]*$/, '$1').trim();
  return { level, text };
}

function computeLineIndex(normalized) {
  const lines = normalized.split('\n');
  const offsets = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  return { lines, offsets };
}

function lineStartOffset(offsets, normalizedLength, index) {
  if (index < offsets.length) return offsets[index];
  return normalizedLength;
}

/**
 * @param {string} markdown
 * @returns {Array<{ordinal:number,level:number,text:string,normalizedText:string,contentStart:number,contentEnd:number}>}
 */
function extractHeadings(markdown) {
  const normalized = normalizeNewlines(String(markdown ?? ''));
  const { lines, offsets } = computeLineIndex(normalized);

  let inFence = false;
  let fenceChar = null;
  let fenceLen = 0;
  let inComment = false;
  let pendingParagraph = null;

  const rawHeadings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (inComment) {
      if (line.includes('-->')) inComment = false;
      pendingParagraph = null;
      continue;
    }

    if (inFence) {
      const closeRe = fenceChar === '`' ? /^ {0,3}(`{3,})\s*$/ : /^ {0,3}(~{3,})\s*$/;
      const closeMatch = closeRe.exec(line);
      if (closeMatch && closeMatch[1].length >= fenceLen) {
        inFence = false;
      }
      pendingParagraph = null;
      continue;
    }

    const fenceOpenMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceOpenMatch) {
      inFence = true;
      fenceChar = fenceOpenMatch[1][0];
      fenceLen = fenceOpenMatch[1].length;
      pendingParagraph = null;
      continue;
    }

    const commentOpenIdx = line.indexOf('<!--');
    if (commentOpenIdx !== -1) {
      const closeIdx = line.indexOf('-->', commentOpenIdx + 4);
      if (closeIdx === -1) {
        inComment = true;
      }
      pendingParagraph = null;
      continue;
    }

    const atx = parseAtxHeading(line);
    if (atx) {
      rawHeadings.push({
        level: atx.level,
        text: atx.text,
        startLine: i,
        endLine: i,
      });
      pendingParagraph = null;
      continue;
    }

    const setextMatch = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (setextMatch && pendingParagraph) {
      const level = setextMatch[1][0] === '=' ? 1 : 2;
      rawHeadings.push({
        level,
        text: pendingParagraph.text,
        startLine: pendingParagraph.lineIndex,
        endLine: i,
      });
      pendingParagraph = null;
      continue;
    }

    if (line.trim() === '') {
      pendingParagraph = null;
    } else {
      pendingParagraph = { text: line.trim(), lineIndex: i };
    }
  }

  const headings = rawHeadings.map((raw) => ({
    ordinal: 0,
    level: raw.level,
    text: raw.text,
    normalizedText: normalizeHeadingText(raw.text),
    startLine: raw.startLine,
    endLine: raw.endLine,
  }));

  headings.forEach((heading, index) => {
    heading.ordinal = index;
  });

  const normalizedLength = normalized.length;
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const contentStart = lineStartOffset(offsets, normalizedLength, heading.endLine + 1);
    let contentEnd = normalizedLength;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= heading.level) {
        contentEnd = lineStartOffset(offsets, normalizedLength, headings[j].startLine);
        break;
      }
    }
    heading.contentStart = contentStart;
    heading.contentEnd = Math.max(contentStart, contentEnd);
    delete heading.startLine;
    delete heading.endLine;
  }

  return headings;
}

/**
 * @param {string} markdown
 * @param {{contentStart:number,contentEnd:number}} heading
 * @returns {string}
 */
function sectionVisibleContent(markdown, heading) {
  const normalized = normalizeNewlines(String(markdown ?? ''));
  const slice = normalized.slice(heading.contentStart, heading.contentEnd);
  const withoutComments = stripHtmlComments(slice);
  return withoutComments.trim();
}

/**
 * @param {string} markdown
 * @returns {string} the whole document with headings removed, comments stripped, trimmed
 */
function wholeDocumentVisibleContent(markdown) {
  const normalized = normalizeNewlines(String(markdown ?? ''));
  return stripHtmlComments(normalized).trim();
}

module.exports = {
  extractHeadings,
  sectionVisibleContent,
  wholeDocumentVisibleContent,
  normalizeHeadingText,
};
