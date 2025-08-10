/**
 * Unit tests for data models and types
 */

import { DistanceMetric } from '../../src/models';

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
