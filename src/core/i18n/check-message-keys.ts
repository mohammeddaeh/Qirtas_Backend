/**
 * Static check: **every user-facing refusal must carry a registered
 * `messageKey`** — `npm run check:messages`.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * `ApiError`'s `message` argument is the ENGLISH fallback. When a throw site
 * omits `messageKey`, `resolveMessage` has nothing to look up and returns that
 * fallback verbatim — so an Arabic-speaking admin mid-task reads an English
 * sentence. Nothing fails, nothing logs, and the only way to notice is to hit
 * that exact refusal and look at the screen.
 *
 * That is how it stayed hidden: on 2026-08-05 an audit found **27 throws**
 * without a key, including "This role has active user assignments…" — which a
 * user hit and reported. The rule had been written down in
 * `qirtas_app/readme/rest_api.md` §6.1 since the message system was built; a
 * written rule with no check is a suggestion.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────
 * Only the four classes that both reach the user verbatim and accept a
 * `messageKey` — see [CHECKED_CLASSES] for why the others are excluded.
 * A throw passes when its last argument is a key present in `MESSAGES`.
 * Anything else fails the run and names the file, line and message.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MESSAGES } from './messages.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The error classes whose `message` reaches a user verbatim AND whose
 * constructor accepts a `messageKey`. Only these are checked.
 *
 * Everything else is out of scope on purpose, not by oversight:
 * - plain `Error` — a programmer fault or a script abort; it never becomes an
 *   API response body, and the handler answers 500 with a generic sentence.
 * - `NotFoundError` / `ValidationError` — structural. The client renders its
 *   own text for a 404, and a 422 carries per-field errors, not a message.
 * - `ConflictError` — has no `messageKey` parameter at all, and nothing throws
 *   it today. If that changes, give it one before using it.
 */
const CHECKED_CLASSES = new Set([
  'BusinessError',
  'ForbiddenError',
  'UnauthorizedError',
  'RateLimitError',
]);

/** Re-throw sites that forward a key they were handed. */
const EXEMPT_FILES = ['core/security/rate-limiter.ts'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Removes a trailing `data` object argument, so the key can still be found by
 * the "last argument" rule.
 *
 * `BusinessError`/`ForbiddenError` take an optional machine-readable `data`
 * payload after the key — e.g. the (role, branch) a "last holder" refusal
 * names, so the client can offer to fill that exact post. Without this, adding
 * that payload silently turns a compliant throw into an offence, and the fix
 * that suggests itself is deleting the payload rather than keeping both.
 *
 * Deliberately narrow: only an argument that is literally a brace-balanced
 * object at the very end is dropped. Anything else still has to end with the
 * key.
 */
function stripTrailingDataObject(body: string): string {
  const trimmed = body.trimEnd().replace(/,$/, '').trimEnd();
  if (!trimmed.endsWith('}')) return body;

  let depth = 0;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const c = trimmed[i];
    if (c === '}') depth++;
    else if (c === '{') {
      depth--;
      if (depth === 0) return trimmed.slice(0, i).trimEnd().replace(/,$/, '');
    }
  }
  return body;
}

const registered = new Set(Object.keys(MESSAGES));
const offences: string[] = [];

for (const file of walk(SRC)) {
  const rel = file.slice(SRC.length + 1).split(path.sep).join('/');
  if (rel.includes('smoke-test') || rel.startsWith('core/i18n/') || EXEMPT_FILES.includes(rel)) {
    continue;
  }

  const source = fs.readFileSync(file, 'utf8');
  const re = /throw new (\w*Error)\(/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(source)) !== null) {
    const cls = match[1] ?? '';
    if (!CHECKED_CLASSES.has(cls)) continue;

    // Close on balanced parentheses so interpolated template literals inside
    // the message are never cut mid-expression.
    let i = match.index + match[0].length;
    let depth = 1;
    while (i < source.length && depth > 0) {
      const c = source[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }

    const body = source.slice(match.index + match[0].length, i - 1);
    const lastArg = stripTrailingDataObject(body).trimEnd().match(/'([a-z_]+)',?$/);
    if (lastArg && registered.has(lastArg[1] ?? '')) continue;

    const line = source.slice(0, match.index).split('\n').length;
    const preview = body.replace(/\s+/g, ' ').trim().slice(0, 70);
    offences.push(`${rel}:${line}  ${cls}  ${preview}`);
  }
}

if (offences.length > 0) {
  console.error(`\n❌ ${offences.length} throw(s) without a registered messageKey:\n`);
  for (const o of offences) console.error('   ' + o);
  console.error(
    '\n   Each of these shows its ENGLISH text to an Arabic reader. Add a key to' +
      '\n   src/core/i18n/messages.ts and pass it as the last argument.\n',
  );
  process.exitCode = 1;
} else {
  console.log('✅ every user-facing throw carries a registered messageKey');
}
