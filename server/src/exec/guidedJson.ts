/** Accept presentation wrappers, never prose or a second payload. Schema validation follows. */
function stripTrailingCommas(body: string): string {
  let result = '';
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if (quoted) {
      if (char === '\r' || char === '\n') {
        if (char === '\r' && body[index + 1] === '\n') index++;
        result += '\\n';
        continue;
      }
      if (char === '"' && !escaped) {
        let next = index + 1;
        while (/\s/u.test(body[next] ?? '')) next++;
        // Preserve a quote inside prose/code when it cannot legally terminate a JSON
        // string. Structural quotes still close normally and JSON/schema validation follows.
        if (next < body.length && ![',', '}', ']', ':'].includes(body[next]!)) {
          result += '\\"';
          continue;
        }
        quoted = false;
        result += char;
        continue;
      }
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      continue;
    }
    if (char === '"') { quoted = true; result += char; continue; }
    if (char === ',') {
      let next = index + 1;
      while (next < body.length && /\s/u.test(body[next]!)) next++;
      if (body[next] === '}' || body[next] === ']') continue;
    }
    result += char;
  }
  return result;
}

/** Some local instruct models mark JSON property names with Markdown bold (`**"key"**`).
 * Strip only that wrapper when it surrounds a property key; never rewrite string values. */
function stripBoldPropertyKeys(body: string): string {
  let result = '';
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < body.length;) {
    const char = body[index]!;
    if (quoted) {
      result += char;
      index++;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      let end = index + 1;
      let keyEscaped = false;
      while (end < body.length) {
        if (!keyEscaped && body[end] === '"') break;
        if (!keyEscaped && body[end] === '\\') keyEscaped = true;
        else keyEscaped = false;
        end++;
      }
      if (end < body.length) {
        let after = end + 1;
        while (/\s/u.test(body[after] ?? '')) after++;
        if (body.slice(after, after + 2) === '**') {
          let colon = after + 2;
          while (/\s/u.test(body[colon] ?? '')) colon++;
          if (body[colon] === ':') {
            if (result.endsWith('**')) result = result.slice(0, -2);
            result += body.slice(index, end + 1);
            index = after + 2;
            continue;
          }
        }
      }
      quoted = true;
    }
    result += char;
    index++;
  }
  return result;
}

/** Parse a comma-separated stream of complete objects some local models return in place of one object. */
function parseObjectSequence(body: string): unknown[] | null {
  const values: unknown[] = [];
  let index = 0;
  while (index < body.length) {
    while (/\s/u.test(body[index] ?? '')) index++;
    if (body[index] === ',') { index++; continue; }
    if (body[index] !== '{') return null;
    const start = index;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (; index < body.length; index++) {
      const char = body[index]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        values.push(JSON.parse(stripTrailingCommas(body.slice(start, index + 1))) as unknown);
        index++;
        break;
      }
    }
    if (depth !== 0 || quoted) return null;
  }
  return values.length > 1 ? values : null;
}

export function parseGuidedJson(text: string): unknown {
  const body = text.trim().replace(/^```(?:json)?\s*\n/i, '').replace(/\n```$/, '').trim();
  let normalized = stripBoldPropertyKeys(body).replace(/\}\s*[.\u0433\u0402\u201a]$/u, '}');
  // Local models sometimes append the closing `]` from an array wrapper after a
  // complete object. Remove exactly that unmatched final delimiter; never unwrap arrays.
  if (normalized.startsWith('{') && /\}\s*\]$/u.test(normalized)) normalized = normalized.replace(/\}\s*\]$/u, '}');
  const clean = stripTrailingCommas(normalized);
  try { return JSON.parse(clean) as unknown; }
  catch (error) {
    const sequence = parseObjectSequence(clean);
    if (sequence !== null) return sequence;
    throw error;
  }
}
