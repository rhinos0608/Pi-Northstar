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

// Doubled consonants collapsed after -ing/-ed stripping. `ll`, `ss`, and
// `zz` are excluded: called -> call, passed -> pass, buzzing -> buzz must
// keep their double letter, while running -> runn -> run collapses.
const COLLAPSE_DOUBLES = new Set(['bb', 'cc', 'dd', 'ff', 'gg', 'mm', 'nn', 'pp', 'rr', 'tt']);

/**
 * Minimal dependency-free suffix stemmer for English verb/noun inflections.
 * Assumes lowercase input (tokenize lowercases by default). Conservative by
 * design: short tokens (length <= 3) pass through untouched, and derivational
 * suffixes like -er/-or/-ly are never stripped, so agent nouns (`runner`)
 * keep their form while inflections (`running`, `runs`) fold to `run`.
 */
export function stem(token: string): string {
  if (token.length <= 3) return token;
  // -ies -> -y (stories -> story). Length guard keeps `ties` on the -s path.
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  // -ing / -ed with doubled-consonant collapse (running -> run, stopped -> stop).
  // Base-length guard keeps short words (`aging`, `seed`, `red`) intact.
  if (token.endsWith('ing') || token.endsWith('ed')) {
    const suffixLength = token.endsWith('ing') ? 3 : 2;
    const base = token.slice(0, -suffixLength);
    if (base.length >= 3) {
      const lastTwo = base.slice(-2);
      if (COLLAPSE_DOUBLES.has(lastTwo)) return base.slice(0, -1);
      return base;
    }
    return token;
  }
  // -es after sibilants (boxes -> box, watches -> watch, wishes -> wish).
  if (/(?:s|x|z|ch|sh)es$/.test(token) && token.length > 4) return token.slice(0, -2);
  // Plain plural -s (runs -> run, cats -> cat). `ss`/`us` guard keeps
  // `class` and `bus` intact.
  if (token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us') && token.length > 3) {
    return token.slice(0, -1);
  }
  return token;
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
