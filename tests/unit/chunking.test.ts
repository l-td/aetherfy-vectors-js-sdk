/**
 * Unit tests for utils/chunking (byte-bounded chunk splitter for upsert
 * payloads) and the PartialUpsertError exception used by the multi-chunk
 * path in client.upsert.
 *
 * The integration path (upsert dispatching multiple HTTP requests under
 * the byte cap) is covered by the e2e suite; here we pin the math and
 * the error shape.
 */
import {
  pointWireBytes,
  chunkPointsByBytes,
  MAX_REQUEST_BYTES,
} from '../../src/utils/chunking';
import {
  PartialUpsertError,
  AetherfyVectorsError,
  ValidationError,
} from '../../src/exceptions';

describe('pointWireBytes', () => {
  it('returns 0 for unmeasurable inputs (chunker treats as "send alone")', () => {
    expect(pointWireBytes(null)).toBe(0);
    expect(pointWireBytes(undefined)).toBe(0);
    expect(pointWireBytes(42)).toBe(0);
    expect(pointWireBytes('not an object')).toBe(0);
  });

  it('estimates vector-only points as framing + dim × 18', () => {
    const point = { id: 'p0', vector: new Array(100).fill(0.5) };
    const bytes = pointWireBytes(point);
    expect(bytes).toBeGreaterThan(100 * 18);
    expect(bytes).toBeLessThan(100 * 18 + 200); // framing allowance
  });

  it('adds payload bytes via JSON.stringify length', () => {
    const vecOnly = { id: 'p0', vector: new Array(100).fill(0.5) };
    const withPayload = {
      id: 'p0',
      vector: new Array(100).fill(0.5),
      payload: { text: 'hello world' },
    };
    expect(pointWireBytes(withPayload)).toBeGreaterThan(
      pointWireBytes(vecOnly)
    );
  });

  it('returns MAX_REQUEST_BYTES for circular payloads (forces isolated chunk)', () => {
    const circular: { payload: { self?: unknown } } = { payload: {} };
    circular.payload.self = circular.payload;
    const point = { id: 'p0', vector: [0.1], payload: circular.payload };
    expect(pointWireBytes(point)).toBe(MAX_REQUEST_BYTES);
  });

  it('handles non-array vector gracefully (skips vector size estimate)', () => {
    // Defensive: a malformed point with vector as object shouldn't crash
    // the chunker; we just under-estimate (the upsert validation will
    // reject it before the chunker fires in practice, but the chunker
    // must not crash on bad input).
    const point = { id: 'p0', vector: { not: 'an array' } };
    const bytes = pointWireBytes(point);
    expect(bytes).toBeGreaterThanOrEqual(0);
  });
});

describe('chunkPointsByBytes', () => {
  it('yields nothing for empty or non-array input', () => {
    expect(Array.from(chunkPointsByBytes([], 100))).toEqual([]);
    expect(
      Array.from(chunkPointsByBytes(null as unknown as unknown[], 100))
    ).toEqual([]);
    expect(
      Array.from(chunkPointsByBytes(undefined as unknown as unknown[], 100))
    ).toEqual([]);
  });

  it('keeps a small batch in one chunk (target far exceeds total bytes)', () => {
    const points = Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`,
      vector: [0.1, 0.2],
    }));
    const chunks = Array.from(chunkPointsByBytes(points, MAX_REQUEST_BYTES));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(10);
  });

  it('splits when in-flight chunk would exceed the byte target', () => {
    // 100 points × 100-dim vector ≈ 1900 bytes each (100 framing + 1800
    // vector). With a 5000-byte target, ~2 points per chunk.
    const points = Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`,
      vector: new Array(100).fill(0.5),
    }));
    const chunks = Array.from(chunkPointsByBytes(points, 5000));
    expect(chunks.length).toBeGreaterThan(1);
    // No points dropped — total across all chunks equals input count.
    const totalForwarded = chunks.reduce((n, c) => n + c.length, 0);
    expect(totalForwarded).toBe(10);
  });

  it('preserves input order across chunks (FIFO MessageGroupId depends on it)', () => {
    const points = Array.from({ length: 50 }, (_, i) => ({
      id: `p${i}`,
      vector: new Array(200).fill(0.5),
    }));
    const chunks = Array.from(chunkPointsByBytes(points, 5000));
    const flattened = chunks.flat().map(p => p.id);
    const expected = points.map(p => p.id);
    expect(flattened).toEqual(expected);
  });

  it('sends a single oversized point alone in its own chunk (no silent drop)', () => {
    // One point with a huge embedded payload that itself exceeds the
    // target. The chunker must yield it in its own chunk rather than
    // refuse to emit it. The backend (or Cloudflare) may then reject
    // it, but the SDK NEVER drops user data without telling them.
    const tiny = { id: 'tiny', vector: [0.1] };
    const huge = {
      id: 'huge',
      vector: [0.1],
      payload: { text: 'x'.repeat(50000) },
    };
    const moreTiny = { id: 'moreTiny', vector: [0.2] };
    const chunks = Array.from(
      chunkPointsByBytes([tiny, huge, moreTiny], 10000)
    );
    // Find the chunk containing the huge point — it should be alone.
    const hugeChunk = chunks.find(c => c.some(p => p.id === 'huge'));
    expect(hugeChunk).toBeDefined();
    expect(hugeChunk).toHaveLength(1);
    expect(hugeChunk?.[0].id).toBe('huge');
  });

  it('heterogeneous payloads: small first + large later still chunked correctly', () => {
    // First-point-only measurement would underestimate and overflow.
    // Per-point byte tracking flushes BEFORE adding a point that pushes
    // the in-flight chunk past target.
    const small = { id: 's0', vector: [0.1], payload: { tag: 'x' } };
    const largeText = 'a'.repeat(20000);
    const large = (i: number) => ({
      id: `l${i}`,
      vector: [0.1],
      payload: { text: largeText },
    });
    const points = [small, ...Array.from({ length: 10 }, (_, i) => large(i))];
    const chunks = Array.from(chunkPointsByBytes(points, 50000));

    expect(chunks.length).toBeGreaterThan(1);
    // All points accounted for.
    expect(chunks.flat()).toHaveLength(points.length);
    // No chunk far exceeds the target (the >target case is only when a
    // single point alone exceeds — none here do).
    for (const chunk of chunks) {
      const bytes = chunk.reduce((n, p) => n + pointWireBytes(p), 0);
      // Allow some slack for the framing approximation but flag gross
      // overruns. A chunk with 4× target indicates the splitter broke.
      expect(bytes).toBeLessThan(50000 * 2);
    }
  });

  it('MAX_REQUEST_BYTES is 24 MB (backend processing budget under wait=true)', () => {
    expect(MAX_REQUEST_BYTES).toBe(24 * 1024 * 1024);
  });
});

describe('PartialUpsertError', () => {
  it('reports saved count, total count, and failed chunk details', () => {
    const failed = [
      {
        pointIds: ['p4', 'p5', 'p6'],
        error: new ValidationError('bad chunk'),
      },
    ];
    const err = new PartialUpsertError(3, 6, failed);

    expect(err).toBeInstanceOf(AetherfyVectorsError);
    expect(err.name).toBe('PartialUpsertError');
    expect(err.saved).toBe(3);
    expect(err.total).toBe(6);
    expect(err.failed).toEqual(failed);
    expect(err.message).toContain('3 of 6 points saved');
    expect(err.message).toContain('3 failed');
    expect(err.message).toContain('1 chunk');
  });

  it('aggregates failed-point count across multiple failed chunks', () => {
    const failed = [
      { pointIds: ['a', 'b'], error: new ValidationError('chunk 1') },
      { pointIds: ['c', 'd', 'e'], error: new ValidationError('chunk 2') },
    ];
    const err = new PartialUpsertError(0, 5, failed);
    expect(err.message).toContain('0 of 5 points saved');
    expect(err.message).toContain('5 failed across 2 chunk(s)');
  });

  it('serialises with full diagnostic info via toJSON', () => {
    const failed = [{ pointIds: ['p1'], error: new ValidationError('test') }];
    const err = new PartialUpsertError(1, 2, failed);
    const json = err.toJSON() as {
      name: string;
      saved: number;
      total: number;
      failed: Array<{ pointIds: unknown[]; error: { name: string } }>;
    };
    expect(json.name).toBe('PartialUpsertError');
    expect(json.saved).toBe(1);
    expect(json.total).toBe(2);
    expect(json.failed).toHaveLength(1);
    expect(json.failed[0].pointIds).toEqual(['p1']);
    expect(json.failed[0].error.name).toBe('ValidationError');
  });

  it('instanceof checks work across the AetherfyVectorsError hierarchy', () => {
    const err = new PartialUpsertError(0, 1, [
      { pointIds: ['x'], error: new ValidationError('e') },
    ]);
    expect(err instanceof PartialUpsertError).toBe(true);
    expect(err instanceof AetherfyVectorsError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});
