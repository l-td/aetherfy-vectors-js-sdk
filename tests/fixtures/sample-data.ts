/**
 * Sample data fixtures for testing
 */

import {
  Point,
  Collection,
  SearchResult,
  PerformanceAnalytics,
  DistanceMetric,
} from '../../src/models';

export const samplePoints: Point[] = [
  {
    id: 'point_1',
    vector: [0.1, 0.2, 0.3, 0.4, 0.5],
    payload: {
      category: 'electronics',
      name: 'Wireless Headphones',
      price: 299.99,
      brand: 'TechCorp',
    },
  },
  {
    id: 'point_2',
    vector: [0.6, 0.7, 0.8, 0.9, 1.0],
    payload: {
      category: 'clothing',
      name: 'Running Shoes',
      price: 129.99,
      brand: 'SportsBrand',
    },
  },
  {
    id: 'point_3',
    vector: [0.2, 0.4, 0.6, 0.8, 1.0],
    payload: {
      category: 'books',
      name: 'JavaScript Guide',
      price: 49.99,
      author: 'John Doe',
    },
  },
  {
    id: 'point_4',
    vector: [0.1, 0.3, 0.5, 0.7, 0.9],
    payload: {
      category: 'electronics',
      name: 'Smart Watch',
      price: 399.99,
      brand: 'TechCorp',
    },
  },
  {
    id: 'point_5',
    vector: [0.9, 0.8, 0.7, 0.6, 0.5],
    payload: {
      category: 'home',
      name: 'Coffee Maker',
      price: 199.99,
      brand: 'HomeBrand',
    },
  },
];

export const sampleCollections: Collection[] = [
  {
    name: 'products',
    config: {
      size: 128,
      distance: DistanceMetric.COSINE,
    },
    pointsCount: 1500,
    status: 'active',
  },
  {
    name: 'documents',
    config: {
      size: 384,
      distance: DistanceMetric.EUCLIDEAN,
    },
    pointsCount: 2300,
    status: 'active',
  },
  {
    name: 'images',
    config: {
      size: 512,
      distance: DistanceMetric.DOT,
    },
    pointsCount: 890,
    status: 'active',
  },
];

export const sampleSearchResults: SearchResult[] = [
  {
    id: 'point_1',
    score: 0.95,
    payload: samplePoints[0].payload,
    vector: samplePoints[0].vector,
  },
  {
    id: 'point_4',
    score: 0.87,
    payload: samplePoints[3].payload,
    vector: samplePoints[3].vector,
  },
  {
    id: 'point_2',
    score: 0.72,
    payload: samplePoints[1].payload,
  },
];

export const sampleAnalytics: PerformanceAnalytics = {
  cacheHitRate: 94.2,
  avgLatencyMs: 45,
  requestsPerSecond: 1250,
  activeRegions: ['us-east-1', 'eu-west-1', 'ap-southeast-1'],
  regionPerformance: {
    'us-east-1': {
      latency: 35,
      requests: 800,
    },
    'eu-west-1': {
      latency: 42,
      requests: 300,
    },
    'ap-southeast-1': {
      latency: 58,
      requests: 150,
    },
  },
  totalRequests: 12500,
  errorRate: 0.02,
};

// Test vectors of different dimensions
export const testVectors = {
  small: [0.1, 0.2, 0.3],
  medium: Array.from({ length: 128 }, (_, i) => Math.sin(i / 10)),
  large: Array.from({ length: 1536 }, (_, i) => Math.cos(i / 20)),
  invalid: [0.1, NaN, 0.3],
  empty: [] as number[],
  mixed: [1, '2', 3] as (number | string)[],
};

// Sample API responses
export const mockApiResponses = {
  collections: {
    success: {
      collections: sampleCollections,
    },
  },
  search: {
    success: {
      result: sampleSearchResults,
    },
    empty: {
      result: [],
    },
  },
  analytics: {
    performance: sampleAnalytics,
    usage: {
      currentCollections: 5,
      maxCollections: 100,
      currentPoints: 4690,
      maxPoints: 100000,
      requestsThisMonth: 25000,
      maxRequestsPerMonth: 1000000,
      storageUsedMb: 125.5,
      maxStorageMb: 10240,
      planName: 'Developer',
    },
  },
  errors: {
    unauthorized: {
      message: 'Invalid API key',
      error: 'Unauthorized',
    },
    notFound: {
      message: 'Collection not found',
      collectionName: 'missing-collection',
    },
    validation: {
      message: 'Validation failed',
      field: 'vector',
      violations: ['must be array', 'must not be empty'],
    },
    rateLimit: {
      message: 'Rate limit exceeded',
      retryAfter: 60,
    },
  },
};

// Valid API keys for testing
export const testApiKeys = {
  valid: {
    live: 'afy_live_1234567890123456789012345678',
    test: 'afy_test_abcdefghijklmnopqrstuvwxyz12',
  },
  invalid: {
    wrongPrefix: 'invalid_prefix_1234567890123456',
    tooShort: 'afy_test_short',
    empty: '',
    malformed: 'afy_test_invalid_format!',
  },
};

// Common test configurations
export const testConfigs = {
  collections: [
    { name: 'test-cosine', config: { size: 128, distance: 'Cosine' } },
    { name: 'test-euclidean', config: { size: 256, distance: 'Euclidean' } },
    { name: 'test-dot', config: { size: 512, distance: 'Dot' } },
    { name: 'test-manhattan', config: { size: 1024, distance: 'Manhattan' } },
  ],
  search: {
    basic: { limit: 10, withPayload: true },
    detailed: { limit: 5, withPayload: true, withVectors: true },
    filtered: {
      limit: 20,
      withPayload: true,
      queryFilter: {
        must: [{ key: 'category', match: { value: 'electronics' } }],
      },
    },
  },
};

export default {
  samplePoints,
  sampleCollections,
  sampleSearchResults,
  sampleAnalytics,
  testVectors,
  mockApiResponses,
  testApiKeys,
  testConfigs,
};
