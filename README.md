# Aetherfy Vectors JavaScript SDK

[![npm version](https://img.shields.io/npm/v/aetherfy-vectors.svg)](https://www.npmjs.com/package/aetherfy-vectors)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg)](http://www.typescriptlang.org/)

Global vector database with automatic replication and sub-50ms latency worldwide.

## 🌟 Features

- **🌍 Global Performance** - Automatic replication across 12+ global regions
- **⚡ Intelligent Caching** - 94%+ cache hit rate with sub-50ms response times
- **🛡️ Zero DevOps** - Fully managed infrastructure, no setup required
- **📊 Built-in Analytics** - Real-time performance metrics and insights
- **🔧 Auto-Failover** - Seamless failover and disaster recovery
- **🔒 Enterprise Security** - End-to-end encryption and compliance ready
- **🚀 Developer Friendly** - TypeScript-first with comprehensive documentation

## 🚀 Installation

```bash
npm install aetherfy-vectors
# or
yarn add aetherfy-vectors
# or
pnpm add aetherfy-vectors
```

## 📖 Quick Start

```typescript
import { AetherfyVectorsClient, DistanceMetric } from 'aetherfy-vectors';

// Initialize client
const client = new AetherfyVectorsClient({
  apiKey: 'afy_live_your_api_key_here' // or use environment variable
});

// Create a collection
await client.createCollection('products', {
  size: 384,              // Vector dimensions
  distance: DistanceMetric.COSINE
});

// Add vectors
const points = [
  {
    id: 'product_1',
    vector: [0.1, 0.2, ...], // 384-dimensional vector
    payload: {
      name: 'Wireless Headphones',
      category: 'electronics',
      price: 299.99
    }
  }
];
await client.upsert('products', points);

// Search for similar items
const results = await client.search('products', queryVector, {
  limit: 10,
  withPayload: true,
  scoreThreshold: 0.7
});

console.log('Similar products:', results);
```

## 🔑 Authentication

The SDK supports multiple ways to provide your API key:

### 1. Constructor Parameter (Recommended)

```typescript
const client = new AetherfyVectorsClient({
  apiKey: 'afy_live_your_api_key_here',
});
```

### 2. Environment Variables (Node.js only)

```bash
# Option 1
export AETHERFY_API_KEY=afy_live_your_api_key_here

# Option 2
export AETHERFY_VECTORS_API_KEY=afy_live_your_api_key_here
```

```typescript
// No API key needed in constructor
const client = new AetherfyVectorsClient();
```

### 3. Custom Endpoint

```typescript
const client = new AetherfyVectorsClient({
  apiKey: 'your_api_key',
  endpoint: 'https://custom.vectors.endpoint.com',
  timeout: 45000, // Custom timeout in milliseconds
});
```

## 🔧 Core Operations

### Collection Management

```typescript
// Create collection with vector configuration
await client.createCollection('my-collection', {
  size: 768,
  distance: DistanceMetric.EUCLIDEAN,
});

// List all collections
const collections = await client.getCollections();

// Check if collection exists
const exists = await client.collectionExists('my-collection');

// Get collection info
const info = await client.getCollection('my-collection');

// Delete collection
await client.deleteCollection('my-collection');
```

### Vector Operations

```typescript
// Insert or update vectors
await client.upsert('collection-name', [
  {
    id: 'vec-1',
    vector: [0.1, 0.2, 0.3, ...],
    payload: { category: 'A', metadata: {...} }
  },
  {
    id: 'vec-2',
    vector: [0.4, 0.5, 0.6, ...],
    payload: { category: 'B', metadata: {...} }
  }
]);

// Retrieve vectors by ID
const vectors = await client.retrieve('collection-name', ['vec-1', 'vec-2'], {
  withPayload: true,
  withVectors: false
});

// Delete vectors
await client.delete('collection-name', ['vec-1', 'vec-2']);

// Delete by filter
await client.delete('collection-name', {
  must: [{ key: 'category', match: { value: 'A' } }]
});

// Count vectors
const count = await client.count('collection-name');
const filteredCount = await client.count('collection-name', {
  countFilter: { must: [{ key: 'category', match: { value: 'A' } }] }
});
```

### Search Operations

```typescript
// Basic similarity search
const results = await client.search('collection-name', queryVector, {
  limit: 10,
  withPayload: true,
  withVectors: false,
});

// Advanced search with filtering
const filteredResults = await client.search('collection-name', queryVector, {
  limit: 20,
  offset: 10,
  scoreThreshold: 0.8,
  withPayload: true,
  queryFilter: {
    must: [
      { key: 'category', match: { value: 'electronics' } },
      { key: 'price', range: { gte: 100, lte: 500 } },
    ],
  },
});
```

## 📊 Analytics & Monitoring

```typescript
// Get performance analytics
const analytics = await client.getPerformanceAnalytics('24h');
console.log(`Cache hit rate: ${analytics.cacheHitRate}%`);
console.log(`Average latency: ${analytics.avgLatencyMs}ms`);
console.log(`Active regions: ${analytics.activeRegions.join(', ')}`);

// Get collection-specific analytics
const collectionStats = await client.getCollectionAnalytics('products', '7d');
console.log(`Search requests: ${collectionStats.searchRequests}`);
console.log(`Average search latency: ${collectionStats.avgSearchLatencyMs}ms`);

// Monitor usage and limits
const usage = await client.getUsageStats();
console.log(`Collections: ${usage.currentCollections}/${usage.maxCollections}`);
console.log(`Points: ${usage.currentPoints}/${usage.maxPoints}`);
console.log(`Plan: ${usage.planName}`);

// Usage warning example
if (usage.currentPoints > usage.maxPoints * 0.8) {
  console.warn('⚠️ Approaching point limit');
}
```

## 🌐 Browser Usage

The SDK works in browsers with important security considerations:

```html
<!DOCTYPE html>
<html>
  <head>
    <title>Vector Search Demo</title>
  </head>
  <body>
    <script type="module">
      import { AetherfyVectorsClient } from 'https://unpkg.com/aetherfy-vectors@1.0.0/dist/browser.js';

      // ⚠️ Only use test keys in browser - never production keys!
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_demo_key_only', // Test key only!
      });

      // The SDK will show security warnings in browser console

      async function searchProducts(query) {
        try {
          const results = await client.search('products', query, {
            limit: 5,
            withPayload: true,
          });
          displayResults(results);
        } catch (error) {
          handleError(error);
        }
      }
    </script>
  </body>
</html>
```

### 🔒 Browser Security Guidelines

- **Never expose production API keys** in browser code
- **Use test keys only** for demos and development
- **Configure CORS** on your server for browser requests
- **Use backend proxy** for production applications
- **Consider serverless functions** for secure API access

## 🔧 Advanced Usage

### Error Handling

```typescript
import {
  AetherfyVectorsClient,
  AuthenticationError,
  RateLimitExceededError,
  ValidationError,
  CollectionNotFoundError,
} from 'aetherfy-vectors';

try {
  await client.search('collection', vector);
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error('Invalid API key');
  } else if (error instanceof RateLimitExceededError) {
    console.error(`Rate limited. Retry after: ${error.retryAfter}s`);
  } else if (error instanceof ValidationError) {
    console.error('Invalid request:', error.message);
  } else if (error instanceof CollectionNotFoundError) {
    console.error(`Collection ${error.collectionName} not found`);
  }
}
```

### Batch Operations

```typescript
// Process large datasets in batches
import { batchArray } from 'aetherfy-vectors';

const largeDataset = [...]; // Your large array of points
const batches = batchArray(largeDataset, 100); // Process 100 at a time

for (const batch of batches) {
  await client.upsert('collection', batch);
  console.log(`Processed batch of ${batch.length} points`);
}
```

### Retry Logic

```typescript
import { retryWithBackoff } from 'aetherfy-vectors';

const results = await retryWithBackoff(
  () => client.search('collection', vector),
  {
    maxRetries: 3,
    baseDelay: 1000,
    backoffFactor: 2,
    retryCondition: error => error.name === 'ServiceUnavailableError',
  }
);
```

### Environment Detection

```typescript
import { isBrowser, isNode } from 'aetherfy-vectors';

if (isBrowser()) {
  console.log('Running in browser - use test keys only');
} else if (isNode()) {
  console.log('Running in Node.js - can use environment variables');
}
```

## 📚 API Reference

### AetherfyVectorsClient

| Method                                          | Description                | Returns                          |
| ----------------------------------------------- | -------------------------- | -------------------------------- |
| `createCollection(name, config)`                | Create a new collection    | `Promise<boolean>`               |
| `deleteCollection(name)`                        | Delete a collection        | `Promise<boolean>`               |
| `getCollections()`                              | List all collections       | `Promise<Collection[]>`          |
| `collectionExists(name)`                        | Check if collection exists | `Promise<boolean>`               |
| `getCollection(name)`                           | Get collection info        | `Promise<Collection>`            |
| `upsert(collection, points)`                    | Insert/update vectors      | `Promise<boolean>`               |
| `delete(collection, selector)`                  | Delete vectors             | `Promise<boolean>`               |
| `retrieve(collection, ids, options)`            | Get vectors by ID          | `Promise<Record<string, any>[]>` |
| `search(collection, vector, options)`           | Similarity search          | `Promise<SearchResult[]>`        |
| `count(collection, options)`                    | Count vectors              | `Promise<number>`                |
| `getPerformanceAnalytics(timeRange, region)`    | Performance metrics        | `Promise<PerformanceAnalytics>`  |
| `getCollectionAnalytics(collection, timeRange)` | Collection metrics         | `Promise<CollectionAnalytics>`   |
| `getUsageStats()`                               | Account usage              | `Promise<UsageStats>`            |
| `testConnection()`                              | Test API connection        | `Promise<boolean>`               |

### Distance Metrics

```typescript
import { DistanceMetric } from 'aetherfy-vectors';

DistanceMetric.COSINE; // Cosine similarity (recommended for most use cases)
DistanceMetric.EUCLIDEAN; // Euclidean distance
DistanceMetric.DOT; // Dot product
DistanceMetric.MANHATTAN; // Manhattan distance
```

### Types

```typescript
interface VectorConfig {
  size: number; // Vector dimensions
  distance: DistanceMetric;
}

interface Point {
  id: string | number; // Unique identifier
  vector: number[]; // Vector data
  payload?: Record<string, any>; // Optional metadata
}

interface SearchOptions {
  limit?: number; // Max results (default: 10)
  offset?: number; // Skip results (default: 0)
  withPayload?: boolean; // Include metadata (default: true)
  withVectors?: boolean; // Include vectors (default: false)
  scoreThreshold?: number; // Min similarity score
  queryFilter?: Filter; // Filter conditions
}

interface SearchResult {
  id: string | number; // Point identifier
  score: number; // Similarity score
  payload?: Record<string, any>; // Metadata (if requested)
  vector?: number[]; // Vector (if requested)
}
```

## 🧪 Testing

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run browser compatibility tests
npm run test:browser

# Run specific test file
npm test -- --testNamePattern="client"

# Watch mode during development
npm run test:watch
```

## 🏗️ Building

```bash
# Install dependencies
npm install

# Build for production
npm run build

# Build and watch for changes
npm run build:watch

# Type checking
npm run type-check

# Linting
npm run lint

# Format code
npm run format
```

## 📊 Performance

### Benchmarks

- **Latency**: Sub-50ms average globally
- **Throughput**: 100,000+ queries per second
- **Cache Hit Rate**: 94%+ typical
- **Availability**: 99.9% SLA
- **Regions**: 12+ global locations

### Best Practices

1. **Use appropriate batch sizes** (100-1000 points per upsert)
2. **Enable caching** for repeated queries
3. **Use filters** to reduce search space
4. **Monitor usage** to stay within limits
5. **Choose optimal distance metric** for your use case

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Setup

```bash
# Clone the repository
git clone https://github.com/aetherfy/aetherfy-vectors-js.git
cd aetherfy-vectors-js

# Install dependencies
npm install

# Run development build
npm run dev

# Run tests
npm test
```

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

- **Documentation**: [https://docs.aetherfy.com](https://docs.aetherfy.com)
- **API Reference**: [https://docs.aetherfy.com/api](https://docs.aetherfy.com/api)
- **GitHub Issues**: [Report bugs and request features](https://github.com/aetherfy/aetherfy-vectors-js/issues)
- **Community**: [Join our Discord](https://discord.gg/aetherfy)
- **Email**: [developers@aetherfy.com](mailto:developers@aetherfy.com)

## 🔗 Related Projects

- **Python SDK**: [aetherfy-vectors-python](https://github.com/aetherfy/aetherfy-vectors-python)

---

Made with ❤️ by the [Aetherfy](https://aetherfy.com) team
