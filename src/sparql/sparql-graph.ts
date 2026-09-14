// SPARQL GraphAdapter v1: SELECT/ASK-only over operator-owned transport.
// No query translation: caller SPARQL executes verbatim after form gating.
// Pagination is single-response (hasMore false); probe wraps countable
// SELECT as COUNT(*); schema views run fixed bounded discovery queries.

import {
  GRAPH_ADAPTER_CURSOR_V,
  validateGraphJsonValue,
  type GraphError,
  type GraphErrorCode,
  type JsonValue,
} from '../graph/graph-contract.js';
import type {
  GraphAdapter,
  GraphAdapterContext,
  GraphAdapterProbeInput,
  GraphAdapterProbeOutcome,
  GraphAdapterQueryInput,
  GraphAdapterQueryOutcome,
  GraphAdapterSchemaSnapshotOutcome,
} from '../graph/graph-adapter.js';
import type { GraphSchemaResult, GraphSchemaView } from '../graph/graph-contract.js';
import {
  sparqlPost,
  SparqlTransportError,
  type SparqlFetchFn,
} from './sparql-transport.js';

export const SPARQL_PROVIDER = 'sparql' as const;
export const SPARQL_ADAPTER_V: typeof GRAPH_ADAPTER_CURSOR_V = GRAPH_ADAPTER_CURSOR_V;

export interface SparqlGraphAdapterOptions {
  /** Operator-configured endpoint URL (env only, never model input). */
  endpoint: string;
  /** Injected fetch for deterministic tests; defaults to global fetch. */
  fetchFn?: SparqlFetchFn;
  timeoutMs?: number;
  maxBytes?: number;
}

type SparqlForm = 'select' | 'ask' | 'unsupported';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Redact bearer token from adapter-built error strings; slice to 500 chars. */
function redactSparqlAdapterError(message: string, token: string): string {
  const out = token ? message.split(token).join('[REDACTED]') : message;
  return out.slice(0, 500);
}

function toSparqlError(code: GraphErrorCode, message: string, retryable: boolean, token: string): GraphError {
  return { code, message: redactSparqlAdapterError(message, token), retryable, provider: SPARQL_PROVIDER };
}

/** Strip `#` comments only outside <IRIs> and quoted strings (incl. triple-quoted). */
function stripSparqlComments(query: string): string {
  let out = '';
  let i = 0;
  const n = query.length;
  let inIri = false;
  let inSingle = false;
  let inDouble = false;
  let inTripleSingle = false;
  let inTripleDouble = false;
  while (i < n) {
    const ch = query[i]!;
    if (inTripleSingle) {
      if (query.startsWith("'''", i)) {
        out += "'''";
        i += 3;
        inTripleSingle = false;
      } else if (ch === '\\') {
        out += query.slice(i, i + 2);
        i += 2;
      } else {
        out += ch;
        i += 1;
      }
      continue;
    }
    if (inTripleDouble) {
      if (query.startsWith('"""', i)) {
        out += '"""';
        i += 3;
        inTripleDouble = false;
      } else if (ch === '\\') {
        out += query.slice(i, i + 2);
        i += 2;
      } else {
        out += ch;
        i += 1;
      }
      continue;
    }
    if (inSingle) {
      if (ch === '\\') {
        out += query.slice(i, i + 2);
        i += 2;
      } else {
        out += ch;
        i += 1;
        if (ch === "'") inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '\\') {
        out += query.slice(i, i + 2);
        i += 2;
      } else {
        out += ch;
        i += 1;
        if (ch === '"') inDouble = false;
      }
      continue;
    }
    if (inIri) {
      out += ch;
      i += 1;
      if (ch === '>') inIri = false;
      continue;
    }
    if (query.startsWith("'''", i)) {
      out += "'''";
      i += 3;
      inTripleSingle = true;
      continue;
    }
    if (query.startsWith('"""', i)) {
      out += '"""';
      i += 3;
      inTripleDouble = true;
      continue;
    }
    if (ch === "'") {
      out += ch;
      i += 1;
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      i += 1;
      inDouble = true;
      continue;
    }
    if (ch === '<') {
      out += ch;
      i += 1;
      inIri = true;
      continue;
    }
    if (ch === '#') {
      while (i < n && query[i] !== '\n') i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Bare-word scan of SPARQL text for form gating (ADR 0006): collects
 *  uppercase bare keywords, skipping comments, string literals (incl.
 *  triple-quoted + escapes), IRIREFs, variables (?x/$x), blank-node labels
 *  (_:x), prefixed names (ex:foo, :foo), language tags (@en), and numbers.
 *  Only bare words can be SPARQL keywords, so ?service, ex:add, or "FROM"
 *  inside a literal never match. `<` opens an IRIREF only when valid IRIREF
 *  content (no whitespace/controls or `<>"{}|^`\`` unescaped before `>`);
 *  otherwise it is a comparison operator (FILTER(?a < ?b)) and scanning
 *  continues after it, so `<`-masking cannot swallow a SERVICE ban. */
function bareSparqlWords(query: string): string[] {
  const text = stripSparqlComments(query);
  const words: string[] = [];
  const n = text.length;
  let i = 0;
  const isWordChar = (ch: string): boolean => /[A-Za-z0-9_-]/.test(ch);
  const skipLocalName = (): void => {
    while (i < n) {
      const ch = text[i]!;
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (/[A-Za-z0-9_.%:\-]/.test(ch)) {
        i += 1;
        continue;
      }
      break;
    }
  };
  while (i < n) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") {
      let quote: string = ch;
      if (text.startsWith(ch.repeat(3), i)) quote = ch.repeat(3);
      i += quote.length;
      while (i < n) {
        if (quote.length === 1 && text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text.startsWith(quote, i)) {
          i += quote.length;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '<') {
      let j = i + 1;
      let valid = false;
      while (j < n) {
        const c = text[j]!;
        if (c === '>') {
          valid = true;
          break;
        }
        if (c === '\\') {
          const u = text[j + 1];
          const digits = u === 'u' ? 4 : u === 'U' ? 8 : 0;
          const hex = digits > 0 ? text.slice(j + 2, j + 2 + digits) : '';
          if (digits > 0 && /^[0-9A-Fa-f]+$/.test(hex) && hex.length === digits) {
            j += 2 + digits;
            continue;
          }
          break;
        }
        if (c <= ' ' || c === '<' || c === '"' || c === '{' || c === '}' || c === '|' || c === '^' || c === '`' || c === '\x7f') break;
        j += 1;
      }
      if (valid) {
        i = j + 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '?' || ch === '$') {
      i += 1;
      while (i < n && /[A-Za-z0-9_.\-]/.test(text[i]!)) i += 1;
      continue;
    }
    if (ch === '_' && text[i + 1] === ':') {
      i += 2;
      while (i < n && /[A-Za-z0-9_.\-]/.test(text[i]!)) i += 1;
      continue;
    }
    if (ch === ':' || ch === '@') {
      i += 1;
      while (i < n && isWordChar(text[i]!)) i += 1;
      if (ch === ':') skipLocalName();
      continue;
    }
    if (/[0-9]/.test(ch) || ((ch === '+' || ch === '-' || ch === '.') && /[0-9]/.test(text[i + 1] ?? ''))) {
      i += 1;
      while (i < n && /[0-9eE.+-]/.test(text[i]!)) i += 1;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      const start = i;
      while (i < n && isWordChar(text[i]!)) i += 1;
      if (text[i] === ':') {
        i += 1;
        skipLocalName();
        continue;
      }
      words.push(text.slice(start, i).toUpperCase());
      continue;
    }
    i += 1;
  }
  return words;
}

/** `;` stacking outside the single SELECT/ASK form, string/IRIREF-aware:
 *  a top-level `;` with trailing content means a second operation follows. */
function hasTopLevelStacking(query: string): boolean {
  const text = stripSparqlComments(query);
  const n = text.length;
  let i = 0;
  let depth = 0;
  const skipString = (quote: string): void => {
    while (i < n) {
      if (quote.length === 1 && text[i] === '\\') {
        i += 2;
        continue;
      }
      if (text.startsWith(quote, i)) {
        i += quote.length;
        return;
      }
      i += 1;
    }
  };
  while (i < n) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") {
      let quote: string = ch;
      if (text.startsWith(ch.repeat(3), i)) quote = ch.repeat(3);
      i += quote.length;
      skipString(quote);
      continue;
    }
    if (ch === '<') {
      const close = text.indexOf('>', i + 1);
      const segment = close === -1 ? '' : text.slice(i + 1, close);
      if (close !== -1 && !/\s/.test(segment) && !/[<>"{}|^`\\]/.test(segment)) {
        i = close + 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) {
      if (text.slice(i + 1).trim() !== '') return true;
    }
    i += 1;
  }
  return false;
}

const UPDATE_KEYWORDS: ReadonlySet<string> = new Set([
  'INSERT',
  'DELETE',
  'LOAD',
  'CLEAR',
  'CREATE',
  'DROP',
  'COPY',
  'MOVE',
  'ADD',
  'WITH',
]);

function classifySparqlForm(query: string): SparqlForm {
  const words = bareSparqlWords(query);
  let first = -1;
  for (let k = 0; k < words.length; k += 1) {
    if (words[k] !== 'PREFIX' && words[k] !== 'BASE') {
      first = k;
      break;
    }
  }
  if (first === -1) return 'unsupported';
  const keyword = words[first]!;
  if (keyword !== 'SELECT' && keyword !== 'ASK') return 'unsupported';
  const rest = words.slice(first + 1);
  // SERVICE is explicit federation; FROM / FROM NAMED select the RDF dataset
  // and can direct some engines to dereference model-supplied IRIs.
  if (rest.includes('SERVICE')) return 'unsupported';
  if (rest.includes('FROM')) return 'unsupported';
  for (const word of rest) {
    if (UPDATE_KEYWORDS.has(word)) return 'unsupported';
  }
  if (hasTopLevelStacking(query)) return 'unsupported';
  return keyword === 'SELECT' ? 'select' : 'ask';
}

/** Blank string literals (same length) so preamble matching never sees
 *  declaration-shaped text inside "...", '...', or triple-quoted literals. */
function maskSparqlStrings(query: string): string {
  const out = query.split('');
  let i = 0;
  const n = query.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) out[k] = ' ';
  };
  while (i < n) {
    let quote: string | undefined;
    if (query.startsWith("'''", i)) quote = "'''";
    else if (query.startsWith('"""', i)) quote = '"""';
    else if (query[i] === "'" || query[i] === '"') quote = query[i]!;
    if (quote === undefined) {
      i += 1;
      continue;
    }
    const start = i;
    i += quote.length;
    let closed = false;
    while (i < n) {
      if (quote.length === 1 && query[i] === '\\') {
        i += 2;
        continue;
      }
      if (query.startsWith(quote, i)) {
        i += quote.length;
        closed = true;
        break;
      }
      i += 1;
    }
    blank(start, closed ? i : n);
    if (!closed) break;
  }
  return out.join('');
}

/** Hoist PREFIX/BASE preamble above the COUNT(*) wrapper: declarations
 *  embedded inside WHERE braces are invalid SPARQL. Operates on
 *  comment-stripped text (comments carry no semantics for the probe). */
function splitProbePreamble(query: string): { preamble: string; body: string } {
  const stripped = stripSparqlComments(query);
  // Match against a string-blanked copy: a "PREFIX ex: <...>" literal must
  // not hoist. Offsets transfer 1:1, so slices come from the original text.
  const masked = maskSparqlStrings(stripped);
  const pattern = /\b(?:PREFIX\s+(?:[A-Za-z][\w.-]*\s*)?:\s*<[^>]*>|BASE\s*<[^>]*>)/gi;
  const ranges: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  if (ranges.length === 0) return { preamble: '', body: stripped };
  const declarations = ranges.map((range) => stripped.slice(range.start, range.end).trim());
  let body = '';
  let cursor = 0;
  for (const range of ranges) {
    body += `${stripped.slice(cursor, range.start)} `;
    cursor = range.end;
  }
  body += stripped.slice(cursor);
  return { preamble: declarations.join('\n'), body };
}

/** Extract non-negative integer hits from a COUNT(*) results payload. */
function readCountHits(parsed: unknown): number | undefined {
  if (!isRecord(parsed) || !isRecord(parsed.results)) return undefined;
  const bindings = parsed.results.bindings;
  if (!Array.isArray(bindings) || bindings.length === 0 || !isRecord(bindings[0])) return undefined;
  const first = bindings[0];
  const cell = isRecord(first.count) ? first.count.value : undefined;
  const raw = typeof cell === 'string' || typeof cell === 'number' ? cell : undefined;
  if (raw === undefined) return undefined;
  const hits = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(hits) || hits < 0 || !Number.isFinite(hits)) return undefined;
  return hits;
}

function gateError(token: string, detail: string): GraphError {
  return toSparqlError('unsupported_option', `SPARQL ${detail} is not supported: SELECT/ASK only, no SERVICE federation or dataset (FROM) clauses.`, false, token);
}

function fromTransportError(error: unknown, token: string, signal?: AbortSignal): GraphError {
  if (signal?.aborted || (error instanceof Error && /abort/i.test(error.message))) {
    return toSparqlError('operation_aborted', 'Graph request was aborted.', false, token);
  }
  if (error instanceof SparqlTransportError) {
    const code: GraphErrorCode =
      error.code === 'transport_invalid_response' ||
      error.code === 'contract_invalid_response' ||
      error.code === 'response_too_large' ||
      error.code === 'unsupported_option'
        ? error.code
        : 'upstream_error';
    return toSparqlError(code, error.message, error.retryable, token);
  }
  return toSparqlError('transport_invalid_response', error instanceof Error ? error.message : String(error), true, token);
}

/** Fixed bounded discovery queries: SELECT-only, no SERVICE, always LIMIT-capped. */
export const SPARQL_TYPES_DISCOVERY_QUERY = 'SELECT DISTINCT ?type WHERE { ?s a ?type } LIMIT 100';
export const SPARQL_FIELDS_DISCOVERY_LIMIT = 100;
export const SPARQL_SEARCH_DISCOVERY_LIMIT = 20;
export const SPARQL_DESCRIBE_DISCOVERY_LIMIT = 100;

function fieldsDiscoveryQuery(typeIri?: string): string {
  if (typeIri !== undefined) {
    return `SELECT DISTINCT ?p WHERE { ?s a <${typeIri}> . ?s ?p ?o } LIMIT ${SPARQL_FIELDS_DISCOVERY_LIMIT}`;
  }
  return `SELECT DISTINCT ?p WHERE { ?s ?p ?o } LIMIT ${SPARQL_FIELDS_DISCOVERY_LIMIT}`;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&');
}

function searchDiscoveryQuery(query: string): string {
  return `SELECT DISTINCT ?type WHERE { ?s a ?type . FILTER(REGEX(STR(?type), "${escapeRegexLiteral(query)}", "i")) } LIMIT ${SPARQL_SEARCH_DISCOVERY_LIMIT}`;
}

function describeDiscoveryQuery(iri: string): string {
  return `SELECT ?p ?o WHERE { <${iri}> ?p ?o } LIMIT ${SPARQL_DESCRIBE_DISCOVERY_LIMIT}`;
}

async function runSparql(query: string, options: SparqlGraphAdapterOptions, ctx: GraphAdapterContext): Promise<unknown> {
  const { endpoint, fetchFn, timeoutMs, maxBytes } = options;
  return sparqlPost<unknown>({
    endpoint,
    query,
    ...(ctx.token ? { token: ctx.token } : {}),
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    ...(ctx.timeoutMs ?? timeoutMs ? { timeoutMs: (ctx.timeoutMs ?? timeoutMs) as number } : {}),
    ...(maxBytes !== undefined ? { maxBytes } : {}),
    ...(fetchFn !== undefined ? { fetchFn } : {}),
  });
}

function bindingsOf(parsed: unknown): Record<string, unknown>[] {
  if (!isRecord(parsed) || !isRecord(parsed.results)) return [];
  const bindings = parsed.results.bindings;
  if (!Array.isArray(bindings)) return [];
  return bindings.filter((entry): entry is Record<string, unknown> => isRecord(entry));
}

function cellValue(binding: Record<string, unknown>, variable: string): string | undefined {
  const cell = binding[variable];
  if (!isRecord(cell) || typeof cell.value !== 'string') return undefined;
  return cell.value;
}

function distinctValues(parsed: unknown, variable: string): string[] {
  const seen = new Set<string>();
  for (const binding of bindingsOf(parsed)) {
    const value = cellValue(binding, variable);
    if (value !== undefined) seen.add(value);
  }
  return [...seen];
}

export interface SparqlSchemaViewInput {
  action: 'schema';
  language: 'sparql';
  view: GraphSchemaView;
  name?: string;
  query?: string;
}

export interface SparqlSchemaViewOutcome {
  provider: typeof SPARQL_PROVIDER;
  result?: GraphSchemaResult;
  error?: GraphError;
}

function invalidViewInput(message: string): GraphError {
  return { code: 'invalid_input', message: message.slice(0, 500), retryable: false, provider: SPARQL_PROVIDER };
}

/** Execute one fixed bounded discovery query and map it to a portable schema view. */
export async function fetchSparqlSchemaView(
  input: SparqlSchemaViewInput,
  options: SparqlGraphAdapterOptions,
  ctx: GraphAdapterContext,
): Promise<SparqlSchemaViewOutcome> {
  if (input.view === 'types') {
    if (input.name !== undefined || input.query !== undefined) {
      return { provider: SPARQL_PROVIDER, error: invalidViewInput('view types accepts no name or query selectors') };
    }
    let parsed: unknown;
    try {
      parsed = await runSparql(SPARQL_TYPES_DISCOVERY_QUERY, options, ctx);
    } catch (error) {
      return { provider: SPARQL_PROVIDER, error: fromTransportError(error, ctx.token, ctx.signal) };
    }
    if (!isRecord(parsed) || !isRecord(parsed.results)) {
      return { provider: SPARQL_PROVIDER, error: toSparqlError('contract_invalid_response', 'SPARQL types discovery response is missing results.', false, ctx.token) };
    }
    if (!validateGraphJsonValue(parsed)) {
      return { provider: SPARQL_PROVIDER, error: toSparqlError('response_too_large', 'SPARQL response exceeds JSON safety bounds.', false, ctx.token) };
    }
    return { provider: SPARQL_PROVIDER, result: { view: 'types', types: distinctValues(parsed, 'type') } };
  }
  if (input.view === 'fields') {
    if (input.query !== undefined) {
      return { provider: SPARQL_PROVIDER, error: invalidViewInput('view fields accepts no query selector') };
    }
    const rawType = input.name?.trim() ? input.name.trim() : undefined;
    let typeIri: string | undefined;
    if (rawType !== undefined) {
      const unwrapped =
        rawType.startsWith('<') && rawType.endsWith('>') ? rawType.slice(1, -1).trim() : rawType;
      if (!/^https?:\/\/\S+$/.test(unwrapped) || unwrapped.includes('>')) {
        return { provider: SPARQL_PROVIDER, error: invalidViewInput('view fields requires an http(s) IRI name') };
      }
      typeIri = unwrapped;
    }
    let parsed: unknown;
    try {
      parsed = await runSparql(fieldsDiscoveryQuery(typeIri), options, ctx);
    } catch (error) {
      return { provider: SPARQL_PROVIDER, error: fromTransportError(error, ctx.token, ctx.signal) };
    }
    if (!isRecord(parsed) || !isRecord(parsed.results)) {
      return { provider: SPARQL_PROVIDER, error: toSparqlError('contract_invalid_response', 'SPARQL fields discovery response is missing results.', false, ctx.token) };
    }
    if (!validateGraphJsonValue(parsed)) {
      return { provider: SPARQL_PROVIDER, error: toSparqlError('response_too_large', 'SPARQL response exceeds JSON safety bounds.', false, ctx.token) };
    }
    const names = distinctValues(parsed, 'p');
    const fields = names.map((name) => ({ name }));
    const atLimit = bindingsOf(parsed).length >= SPARQL_FIELDS_DISCOVERY_LIMIT;
    return {
      provider: SPARQL_PROVIDER,
      result: typeIri === undefined
        ? { view: 'fields', fields, ...(atLimit ? { truncated: true } : {}) }
        : { view: 'fields', type: typeIri, fields, ...(atLimit ? { truncated: true } : {}) },
    };
  }
  if (input.view === 'search') {
    if (input.name !== undefined) {
      return { provider: SPARQL_PROVIDER, error: invalidViewInput('view search accepts no name selector') };
    }
    if (input.query === undefined || input.query.trim().length === 0) {
      return { provider: SPARQL_PROVIDER, error: invalidViewInput('view search requires a non-empty query') };
    }
    const query = input.query.trim();
    let parsed: unknown;
    try {
      parsed = await runSparql(searchDiscoveryQuery(query), options, ctx);
    } catch (error) {
      return { provider: SPARQL_PROVIDER, error: fromTransportError(error, ctx.token, ctx.signal) };
    }
    if (!isRecord(parsed) || !isRecord(parsed.results)) {
      return { provider: SPARQL_PROVIDER, error: toSparqlError('contract_invalid_response', 'SPARQL search discovery response is missing results.', false, ctx.token) };
    }
    if (!validateGraphJsonValue(parsed)) {
      return { provider: SPARQL_PROVIDER, error: toSparqlError('response_too_large', 'SPARQL response exceeds JSON safety bounds.', false, ctx.token) };
    }
    const matches = distinctValues(parsed, 'type').map((name) => ({ name, kind: 'type' }));
    const atLimit = bindingsOf(parsed).length >= SPARQL_SEARCH_DISCOVERY_LIMIT;
    return { provider: SPARQL_PROVIDER, result: { view: 'search', query, matches, ...(atLimit ? { truncated: true } : {}) } };
  }
  const rawName = input.name?.trim() ?? '';
  if (input.query !== undefined) {
    return { provider: SPARQL_PROVIDER, error: invalidViewInput('view describe accepts no query selector') };
  }
  if (rawName.length === 0) {
    return { provider: SPARQL_PROVIDER, error: invalidViewInput('view describe requires a non-empty name') };
  }
  const iri = rawName.startsWith('<') && rawName.endsWith('>') ? rawName.slice(1, -1).trim() : rawName;
  if (!/^https?:\/\/\S+$/.test(iri) || iri.includes('>')) {
    return { provider: SPARQL_PROVIDER, error: invalidViewInput('view describe requires an http(s) IRI name') };
  }
  let parsed: unknown;
  try {
    parsed = await runSparql(describeDiscoveryQuery(iri), options, ctx);
  } catch (error) {
    return { provider: SPARQL_PROVIDER, error: fromTransportError(error, ctx.token, ctx.signal) };
  }
  if (!isRecord(parsed)) {
    return { provider: SPARQL_PROVIDER, error: toSparqlError('contract_invalid_response', 'SPARQL describe response is not a results object.', false, ctx.token) };
  }
  if (!validateGraphJsonValue(parsed)) {
    return { provider: SPARQL_PROVIDER, error: toSparqlError('response_too_large', 'SPARQL response exceeds JSON safety bounds.', false, ctx.token) };
  }
  return { provider: SPARQL_PROVIDER, result: { view: 'describe', name: iri, detail: parsed as JsonValue } };
}

export function createSparqlGraphAdapter(options: SparqlGraphAdapterOptions): GraphAdapter {
  return {
    language: 'sparql',
    provider: SPARQL_PROVIDER,
    adapterCursorV: SPARQL_ADAPTER_V,

    async executeQuery(input: GraphAdapterQueryInput, ctx: GraphAdapterContext): Promise<GraphAdapterQueryOutcome> {
      const form = classifySparqlForm(input.query);
      if (form === 'unsupported') {
        return { provider: SPARQL_PROVIDER, error: gateError(ctx.token, 'query form') };
      }
      let parsed: unknown;
      try {
        parsed = await runSparql(input.query, options, ctx);
      } catch (error) {
        return { provider: SPARQL_PROVIDER, error: fromTransportError(error, ctx.token, ctx.signal) };
      }
      if (!isRecord(parsed)) {
        return {
          provider: SPARQL_PROVIDER,
          error: toSparqlError('contract_invalid_response', 'SPARQL response is not a results object.', false, ctx.token),
        };
      }
      if (form === 'ask' && typeof parsed.boolean !== 'boolean') {
        return {
          provider: SPARQL_PROVIDER,
          error: toSparqlError('contract_invalid_response', 'SPARQL ASK response is missing a boolean answer.', false, ctx.token),
        };
      }
      if (form === 'select' && !isRecord(parsed.results) && typeof parsed.boolean !== 'boolean') {
        return {
          provider: SPARQL_PROVIDER,
          error: toSparqlError('contract_invalid_response', 'SPARQL SELECT response is missing results.', false, ctx.token),
        };
      }
      if (!validateGraphJsonValue(parsed)) {
        return {
          provider: SPARQL_PROVIDER,
          error: toSparqlError('response_too_large', 'SPARQL response exceeds JSON safety bounds.', false, ctx.token),
        };
      }
      return {
        provider: SPARQL_PROVIDER,
        shape: 'object',
        result: parsed as JsonValue,
        pagination: { hasMore: false },
      };
    },

    async probeCardinality(input: GraphAdapterProbeInput, ctx: GraphAdapterContext): Promise<GraphAdapterProbeOutcome> {
      const items: GraphAdapterProbeOutcome['items'] = new Array(input.queries.length);
      const pending: Array<{ index: number; query: string }> = [];
      for (const [index, query] of input.queries.entries()) {
        if (classifySparqlForm(query) !== 'select') {
          items[index] = { query, status: 'error', error: gateError(ctx.token, 'probe form') };
        } else {
          pending.push({ index, query });
        }
      }
      await Promise.all(
        pending.map(async ({ index, query }) => {
          let parsed: unknown;
          try {
            const { preamble, body } = splitProbePreamble(query);
            const wrapped = preamble.length > 0
              ? `${preamble}\nSELECT (COUNT(*) AS ?count) WHERE { { ${body} } }`
              : `SELECT (COUNT(*) AS ?count) WHERE { { ${query} } }`;
            parsed = await runSparql(wrapped, options, ctx);
          } catch (error) {
            items[index] = { query, status: 'error', error: fromTransportError(error, ctx.token, ctx.signal) };
            return;
          }
          const hits = readCountHits(parsed);
          if (hits === undefined) {
            items[index] = {
              query,
              status: 'error',
              error: toSparqlError('contract_invalid_response', 'SPARQL probe response is missing a countable hits value.', false, ctx.token),
            };
            return;
          }
          items[index] = { query, status: 'ok', hits };
        }),
      );
      return { provider: SPARQL_PROVIDER, items };
    },

    async fetchSchemaSnapshot(ctx: GraphAdapterContext): Promise<GraphAdapterSchemaSnapshotOutcome> {
      let parsed: unknown;
      try {
        parsed = await runSparql(SPARQL_TYPES_DISCOVERY_QUERY, options, ctx);
      } catch (error) {
        return { provider: SPARQL_PROVIDER, error: fromTransportError(error, ctx.token, ctx.signal) };
      }
      if (!isRecord(parsed) || !isRecord(parsed.results)) {
        return {
          provider: SPARQL_PROVIDER,
          error: toSparqlError('contract_invalid_response', 'SPARQL schema snapshot response is missing results.', false, ctx.token),
        };
      }
      if (!validateGraphJsonValue(parsed)) {
        return {
          provider: SPARQL_PROVIDER,
          error: toSparqlError('response_too_large', 'SPARQL response exceeds JSON safety bounds.', false, ctx.token),
        };
      }
      return {
        provider: SPARQL_PROVIDER,
        snapshot: { discovery: 'types', query: SPARQL_TYPES_DISCOVERY_QUERY, result: parsed } as JsonValue,
      };
    },
  };
}
