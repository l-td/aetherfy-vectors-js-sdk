/**
 * Basic Usage Example for Aetherfy Vectors JavaScript SDK
 *
 * This example demonstrates the core functionality of the SDK:
 * - Creating a collection
 * - Adding vectors (points)
 * - Performing similarity search
 * - Retrieving points
 * - Getting analytics
 */

import { AetherfyVectorsClient, DistanceMetric } from 'aetherfy-vectors';

async function basicUsageExample() {
  // Initialize the client
  // The API key can be passed explicitly or via environment variables:
  // AETHERFY_API_KEY or AETHERFY_VECTORS_API_KEY
  const client = new AetherfyVectorsClient({
    apiKey: 'afy_live_your_api_key_here', // Replace with your actual API key
  });

  try {
    // Test the connection
    console.log('Testing connection...');
    const isConnected = await client.testConnection();
    if (!isConnected) {
      throw new Error('Failed to connect to Aetherfy Vectors');
    }
    console.log('✅ Connection successful');

    // Create a collection for product embeddings
    const collectionName = 'products';
    console.log(`Creating collection: ${collectionName}`);

    await client.createCollection(collectionName, {
      size: 128, // Vector dimension
      distance: DistanceMetric.COSINE, // Distance metric for similarity
    });
    console.log('✅ Collection created');

    // Prepare sample product data with vectors
    const products = [
      {
        id: 'product_1',
        vector: Array.from({ length: 128 }, () => Math.random()), // Random 128-dim vector
        payload: {
          name: 'Wireless Headphones',
          category: 'Electronics',
          price: 99.99,
          brand: 'TechBrand',
        },
      },
      {
        id: 'product_2',
        vector: Array.from({ length: 128 }, () => Math.random()),
        payload: {
          name: 'Running Shoes',
          category: 'Sports',
          price: 89.99,
          brand: 'SportsCorp',
        },
      },
      {
        id: 'product_3',
        vector: Array.from({ length: 128 }, () => Math.random()),
        payload: {
          name: 'Coffee Maker',
          category: 'Home & Kitchen',
          price: 149.99,
          brand: 'HomeAppliances',
        },
      },
    ];

    // Insert the product vectors
    console.log('Inserting product vectors...');
    await client.upsert(collectionName, products);
    console.log(`✅ Inserted ${products.length} products`);

    // Verify the points were inserted
    const count = await client.count(collectionName);
    console.log(`Collection now contains ${count} points`);

    // Perform a similarity search
    console.log('Performing similarity search...');
    const queryVector = Array.from({ length: 128 }, () => Math.random());

    const searchResults = await client.search(collectionName, queryVector, {
      limit: 2,
      withPayload: true,
      withVectors: false, // Don't return vectors to save bandwidth
    });

    console.log(`Found ${searchResults.length} similar products:`);
    searchResults.forEach((result, index) => {
      console.log(
        `${index + 1}. ${result.payload.name} (Score: ${result.score.toFixed(3)})`
      );
      console.log(
        `   Category: ${result.payload.category}, Price: $${result.payload.price}`
      );
    });

    // Retrieve specific products by ID
    console.log('Retrieving specific products...');
    const retrieved = await client.retrieve(
      collectionName,
      ['product_1', 'product_3'],
      {
        withPayload: true,
        withVectors: false,
      }
    );

    console.log(`Retrieved ${retrieved.length} products by ID`);
    retrieved.forEach(product => {
      console.log(`- ${product.payload.name} (ID: ${product.id})`);
    });

    // Get analytics
    console.log('Getting analytics...');
    const analytics = await client.getPerformanceAnalytics('1h');
    console.log(`Cache hit rate: ${analytics.cacheHitRate}%`);
    console.log(`Average latency: ${analytics.avgLatencyMs}ms`);
    console.log(`Active regions: ${analytics.activeRegions.join(', ')}`);

    // Get collection-specific analytics
    const collectionStats = await client.getCollectionAnalytics(
      collectionName,
      '1h'
    );
    console.log(`Collection stats for ${collectionName}:`);
    console.log(`- Total points: ${collectionStats.totalPoints}`);
    console.log(`- Search requests: ${collectionStats.searchRequests}`);
    console.log(
      `- Avg search latency: ${collectionStats.avgSearchLatencyMs}ms`
    );

    // Get usage information
    const usage = await client.getUsageStats();
    console.log('Account usage:');
    console.log(
      `- Collections: ${usage.currentCollections}/${usage.maxCollections}`
    );
    console.log(`- Points: ${usage.currentPoints}/${usage.maxPoints}`);
    console.log(`- Plan: ${usage.planName}`);

    // List all collections
    const collections = await client.getCollections();
    console.log(`Account has ${collections.length} collections:`);
    collections.forEach(collection => {
      console.log(
        `- ${collection.name} (${collection.config.size}d, ${collection.config.distance})`
      );
    });

    console.log('🎉 Basic usage example completed successfully!');
  } catch (error) {
    console.error('❌ Error:', error.message);

    // Handle specific error types
    if (error.name === 'AuthenticationError') {
      console.error('Please check your API key');
    } else if (error.name === 'RateLimitExceededError') {
      console.error(`Rate limited. Retry after: ${error.retryAfter}s`);
    } else if (error.name === 'ValidationError') {
      console.error('Request validation failed');
    }
  } finally {
    // Clean up resources
    await client.dispose();
  }
}

// Run the example if this file is executed directly
if (require.main === module) {
  basicUsageExample().catch(console.error);
}

export default basicUsageExample;
