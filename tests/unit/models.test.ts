/**
 * Unit tests for data models and types
 */

import { DistanceMetric } from '../../src/models';
import { generateId } from '../../src/memory/models';

describe('generateId', () => {
  // Canonical UUID = 8-4-4-4-12 lowercase hex with hyphens.
  // Qdrant emits this on read. The SDK must emit the same so that
  // round-trip ID equality (caller tracks SDK-returned IDs and compares
  // against scroll/iter output) holds. A regression that strips hyphens
  // (or returns 32-char hex) silently breaks every memory-iter contract.
  const CANONICAL_UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it('returns canonical UUID format with hyphens', () => {
    expect(generateId()).toMatch(CANONICAL_UUID_RE);
  });

  it('generates distinct IDs across calls', () => {
    const ids = new Set(Array.from({ length: 32 }, () => generateId()));
    expect(ids.size).toBe(32);
  });
});

describe('DistanceMetric', () => {
  it('should have correct enum values', () => {
    expect(DistanceMetric.COSINE).toBe('Cosine');
    expect(DistanceMetric.EUCLIDEAN).toBe('Euclidean');
    expect(DistanceMetric.DOT).toBe('Dot');
    expect(DistanceMetric.MANHATTAN).toBe('Manhattan');
  });

  it('should contain all expected metrics', () => {
    const metrics = Object.values(DistanceMetric);
    expect(metrics).toHaveLength(4);
    expect(metrics).toContain('Cosine');
    expect(metrics).toContain('Euclidean');
    expect(metrics).toContain('Dot');
    expect(metrics).toContain('Manhattan');
  });
});
