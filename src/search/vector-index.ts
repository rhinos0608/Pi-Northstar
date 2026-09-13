export interface VectorDocument {
  id: string;
  vector: Float32Array | number[];
}

export interface VectorResult {
  id: string;
  score: number;
}

export interface VectorIndexStats {
  count: number;
  dimensions: number;
}

export class VectorIndex {
  private dimensions: number | null;
  private ids: string[];
  private vectors: Float32Array[];
  private norms: number[];

  constructor(dimensions?: number) {
    this.dimensions = dimensions ?? null;
    this.ids = [];
    this.vectors = [];
    this.norms = [];
  }

  add(id: string, vector: Float32Array | number[]): void {
    const vec = new Float32Array(vector);

    if (this.dimensions === null) {
      this.dimensions = vec.length;
    } else if (vec.length !== this.dimensions) {
      throw new Error(
        `Dimension mismatch: expected ${this.dimensions}, got ${vec.length}`,
      );
    }

    // Compute L2 norm
    let sumSq = 0;
    for (let i = 0; i < vec.length; i++) {
      sumSq += vec[i]! * vec[i]!;
    }
    const norm = Math.sqrt(sumSq);

    // Check for replacement (idempotent: replace existing)
    const existingIdx = this.ids.indexOf(id);
    if (existingIdx !== -1) {
      this.vectors[existingIdx] = vec;
      this.norms[existingIdx] = norm;
      return;
    }

    this.ids.push(id);
    this.vectors.push(vec);
    this.norms.push(norm);
  }

  search(queryVector: Float32Array | number[], topK?: number): VectorResult[] {
    const k = topK ?? 10;
    const query = queryVector instanceof Float32Array ? queryVector : new Float32Array(queryVector);

    if (this.dimensions !== null && query.length !== this.dimensions) {
      throw new Error(`Dimension mismatch: expected ${this.dimensions}, got ${query.length}`);
    }

    if (this.ids.length === 0 || k <= 0) return [];

    // Compute query norm
    let querySumSq = 0;
    for (let i = 0; i < query.length; i++) {
      querySumSq += query[i]! * query[i]!;
    }
    const queryNorm = Math.sqrt(querySumSq);

    const results: VectorResult[] = [];

    for (let j = 0; j < this.ids.length; j++) {
      const vec = this.vectors[j]!;
      const norm = this.norms[j]!;

      // Dot product
      let dot = 0;
      for (let i = 0; i < vec.length; i++) {
        dot += query[i]! * vec[i]!;
      }

      // Cosine similarity
      const denom = queryNorm * norm;
      const score = denom === 0 ? 0 : dot / denom;

      results.push({ id: this.ids[j]!, score });
    }

    // Sort descending by score
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, k);
  }

  clear(): void {
    this.ids = [];
    this.vectors = [];
    this.norms = [];
  }

  stats(): VectorIndexStats {
    return {
      count: this.ids.length,
      dimensions: this.dimensions ?? 0,
    };
  }
}
