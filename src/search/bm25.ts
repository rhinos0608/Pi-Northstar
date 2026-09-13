export interface BM25Document {
  id: string;
  text: string;
}

export interface BM25Result {
  id: string;
  score: number;
}

export interface BM25Stats {
  documentCount: number;
  vocabularySize: number;
  avgDocLength: number;
}

export interface TokenizerOptions {
  minLength?: number;
  stopwords?: Set<string>;
  lower?: boolean;
}

const DEFAULT_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing', 'will', 'would',
  'shall', 'should', 'may', 'might', 'must', 'can', 'could', 'i', 'me', 'my',
  'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your', 'yours', 'yourself', 'yourselves',
  'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself', 'it', 'its',
  'itself', 'they', 'them', 'their', 'theirs', 'themselves', 'what', 'which', 'who', 'whom',
  'this', 'that', 'these', 'those', 'am', 'and', 'but', 'if', 'or', 'because',
  'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with', 'about', 'against',
  'between', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from',
  'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further',
  'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'any',
  'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'don', 'now',
]);

/**
 * Porter stemmer (Martin Porter, 1980; public-domain algorithm) for English.
 * Assumes lowercase input (tokenize lowercases by default). Dependency-free.
 * Normalizes inflections to a shared base (`movies`/`movie` -> `movi`,
 * `cases`/`case` -> `case`, `running`/`runs` -> `run`) while leaving base
 * words alone (`string` stays `string` via the vowel-in-stem guard; `bus`,
 * `class` keep their form via the `us`/`ss` guard; agent nouns like `runner`
 * are never stripped to `run`). Non-ASCII tokens pass through untouched.
 */
export function stem(token: string): string {
  if (token.length <= 2) return token;
  if (!/^[a-z]+$/.test(token)) return token;
  return porter(token);
}

function isConsonant(word: string, i: number): boolean {
  const ch = word[i]!;
  if (ch === 'a' || ch === 'e' || ch === 'i' || ch === 'o' || ch === 'u') return false;
  if (ch === 'y') return i === 0 ? true : !isConsonant(word, i - 1);
  return true;
}

function measure(word: string): number {
  let m = 0;
  let i = 0;
  const n = word.length;
  while (i < n && isConsonant(word, i)) i++;
  while (i < n) {
    while (i < n && !isConsonant(word, i)) i++;
    if (i >= n) break;
    m++;
    while (i < n && isConsonant(word, i)) i++;
  }
  return m;
}

function hasVowel(word: string): boolean {
  for (let i = 0; i < word.length; i++) if (!isConsonant(word, i)) return true;
  return false;
}

function endsDoubleConsonant(word: string): boolean {
  if (word.length < 2) return false;
  const a = word[word.length - 1]!;
  const b = word[word.length - 2]!;
  return a === b && isConsonant(word, word.length - 1);
}

function endsCvc(word: string): boolean {
  if (word.length < 3) return false;
  const c = word[word.length - 1]!;
  if (c === 'w' || c === 'x' || c === 'y') return false;
  return (
    isConsonant(word, word.length - 1) &&
    !isConsonant(word, word.length - 2) &&
    isConsonant(word, word.length - 3)
  );
}

function porter(input: string): string {
  let word = input;
  // Step 1a: plurals. `us`/`ss` guard keeps `bus`/`class` intact.
  if (word.endsWith('sses')) word = `${word.slice(0, -2)}`;
  else if (word.endsWith('ies')) word = `${word.slice(0, -2)}`;
  else if (word.endsWith('ss')) { /* keep */ } else if (word.endsWith('us')) { /* keep base words like `bus` */ } else if (word.endsWith('s')) word = word.slice(0, -1);
  // Step 1b
  let flag = false;
  if (word.endsWith('eed')) {
    const base = word.slice(0, -3);
    if (measure(base) > 0) word = `${base}ee`;
  } else if (word.endsWith('ed')) {
    const base = word.slice(0, -2);
    if (hasVowel(base)) {
      word = base;
      flag = true;
    }
  } else if (word.endsWith('ing')) {
    const base = word.slice(0, -3);
    if (hasVowel(base)) {
      word = base;
      flag = true;
    }
  }
  if (flag) {
    if (word.endsWith('at') || word.endsWith('bl') || word.endsWith('iz')) word = `${word}e`;
    else if (endsDoubleConsonant(word) && !word.endsWith('l') && !word.endsWith('s') && !word.endsWith('z')) {
      word = word.slice(0, -1);
    } else if (measure(word) === 1 && endsCvc(word)) word = `${word}e`;
  }
  // Step 1c: trailing y -> i only after a consonant (`story` -> `stori`,
  // but `play` stays `play`). The vowel guard keeps `string`-like bases intact.
  if (word.endsWith('y')) {
    const base = word.slice(0, -1);
    if (base.length > 0 && isConsonant(base, base.length - 1) && hasVowel(base)) word = `${base}i`;
  }
  // Step 2
  const step2: Array<[string, string]> = [
    ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'],
    ['izer', 'ize'], ['bli', 'ble'], ['alli', 'al'], ['entli', 'ent'],
    ['eli', 'e'], ['ousli', 'ous'], ['ization', 'ize'], ['ation', 'ate'],
    ['ator', 'ate'], ['alism', 'al'], ['iveness', 'ive'], ['fulness', 'ful'],
    ['ousness', 'ous'], ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble'],
    ['logi', 'log'],
  ];
  for (const [suffix, replacement] of step2) {
    if (word.endsWith(suffix)) {
      const base = word.slice(0, -suffix.length);
      if (measure(base) > 0) word = `${base}${replacement}`;
      break;
    }
  }
  // Step 3
  const step3: Array<[string, string]> = [
    ['icate', 'ic'], ['ative', ''], ['alize', 'al'], ['iciti', 'ic'],
    ['ical', 'ic'], ['ful', ''], ['ness', ''],
  ];
  for (const [suffix, replacement] of step3) {
    if (word.endsWith(suffix)) {
      const base = word.slice(0, -suffix.length);
      if (measure(base) > 0) word = `${base}${replacement}`;
      break;
    }
  }
  // Step 4
  const step4 = ['al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement', 'ment', 'ent', 'ion', 'ou', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize'];
  for (const suffix of step4) {
    if (word.endsWith(suffix)) {
      const base = word.slice(0, -suffix.length);
      if (measure(base) > 1) {
        if (suffix === 'ion') {
          if (base.endsWith('s') || base.endsWith('t')) word = base;
        } else {
          word = base;
        }
      }
      break;
    }
  }
  // Step 5a
  if (word.endsWith('e')) {
    const base = word.slice(0, -1);
    const m = measure(base);
    if (m > 1 || (m === 1 && !endsCvc(base))) word = base;
  }
  // Step 5b
  if (measure(word) > 1 && endsDoubleConsonant(word) && word.endsWith('l')) word = word.slice(0, -1);
  return word;
}

export function tokenize(text: string, options?: TokenizerOptions): string[] {
  const minLength = options?.minLength ?? 2;
  const stopwords = options?.stopwords ?? DEFAULT_STOPWORDS;
  const lower = options?.lower ?? true;

  let processed = text;
  if (lower) processed = processed.toLowerCase();

  const rawTokens = processed.match(/\p{L}+|\p{N}+/gu) ?? [];

  const result: string[] = [];
  for (const token of rawTokens) {
    if (token.length < minLength) continue;
    if (stopwords.has(token)) continue;
    result.push(stem(token));
  }
  return result;
}

interface DocData {
  termFreqs: Map<string, number>;
  length: number;
}

export class BM25Index {
  private k1: number;
  private b: number;
  private docs: Map<string, DocData>;
  private invertedIndex: Map<string, Set<string>>;
  private docFreq: Map<string, number>;
  private totalDocs: number;
  private totalDocLength: number;

  constructor(k1?: number, b?: number) {
    this.k1 = k1 ?? 1.5;
    this.b = b ?? 0.75;
    this.docs = new Map();
    this.invertedIndex = new Map();
    this.docFreq = new Map();
    this.totalDocs = 0;
    this.totalDocLength = 0;
  }

  add(id: string, text: string): void {
    if (this.docs.has(id)) {
      this.removeDoc(id);
    }

    const tokens = tokenize(text);
    const termFreqs = new Map<string, number>();
    for (const token of tokens) {
      termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1);
    }

    const docData: DocData = {
      termFreqs,
      length: tokens.length,
    };

    this.docs.set(id, docData);
    this.totalDocs++;
    this.totalDocLength += tokens.length;

    for (const [term] of termFreqs) {
      let docSet = this.invertedIndex.get(term);
      if (!docSet) {
        docSet = new Set();
        this.invertedIndex.set(term, docSet);
      }
      docSet.add(id);
      this.docFreq.set(term, docSet.size);
    }
  }

  private removeDoc(id: string): void {
    const docData = this.docs.get(id);
    if (!docData) return;

    for (const [term] of docData.termFreqs) {
      const docSet = this.invertedIndex.get(term);
      if (docSet) {
        docSet.delete(id);
        if (docSet.size === 0) {
          this.invertedIndex.delete(term);
          this.docFreq.delete(term);
        } else {
          this.docFreq.set(term, docSet.size);
        }
      }
    }

    this.totalDocs--;
    this.totalDocLength -= docData.length;
    this.docs.delete(id);
  }

  addBatch(docs: BM25Document[]): void {
    for (const doc of docs) {
      this.add(doc.id, doc.text);
    }
  }

  search(query: string, topK?: number): BM25Result[] {
    const k = topK ?? 20;
    if (k <= 0) return [];
    const queryTokens = tokenize(query);

    if (queryTokens.length === 0 || this.totalDocs === 0) return [];

    const avgdl = this.totalDocLength / this.totalDocs;
    const N = this.totalDocs;

    const candidateDocs = new Set<string>();
    for (const term of queryTokens) {
      const docSet = this.invertedIndex.get(term);
      if (docSet) {
        for (const docId of docSet) {
          candidateDocs.add(docId);
        }
      }
    }

    const scores = new Map<string, number>();
    for (const docId of candidateDocs) {
      const docData = this.docs.get(docId)!;
      let score = 0;

      for (const term of queryTokens) {
        const n_t = this.docFreq.get(term) ?? 0;
        if (n_t === 0) continue;

        const idf = Math.log((N - n_t + 0.5) / (n_t + 0.5) + 1);

        const f_t_d = docData.termFreqs.get(term) ?? 0;
        if (f_t_d === 0) continue;

        const numerator = f_t_d * (this.k1 + 1);
        const denominator = f_t_d + this.k1 * (1 - this.b + this.b * docData.length / avgdl);
        score += idf * numerator / denominator;
      }

      if (score > 0) {
        scores.set(docId, score);
      }
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([id, score]) => ({ id, score }));
  }

  clear(): void {
    this.docs.clear();
    this.invertedIndex.clear();
    this.docFreq.clear();
    this.totalDocs = 0;
    this.totalDocLength = 0;
  }

  stats(): BM25Stats {
    const vocabularySize = this.invertedIndex.size;
    const avgDocLength = this.totalDocs > 0 ? this.totalDocLength / this.totalDocs : 0;
    return {
      documentCount: this.totalDocs,
      vocabularySize,
      avgDocLength,
    };
  }
}
