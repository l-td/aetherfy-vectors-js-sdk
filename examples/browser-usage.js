/**
 * Browser Usage Example for Aetherfy Vectors JavaScript SDK
 * 
 * This example shows how to use the SDK in browser environments with
 * proper security considerations and error handling.
 * 
 * ⚠️ SECURITY WARNING: Never expose production API keys in browser code!
 * This example is for development, demos, and admin tools only.
 */

import { AetherfyVectorsClient, DistanceMetric } from 'aetherfy-vectors';

class VectorSearchApp {
  constructor() {
    this.client = null;
    this.currentCollection = 'demo_products';
    this.init();
  }

  async init() {
    // Initialize the client
    // ⚠️ Only use test keys in browser - never production keys!
    try {
      this.client = new AetherfyVectorsClient({
        apiKey: 'afy_test_demo_key_only', // Replace with your TEST key only
        endpoint: 'https://vectors.aetherfy.com'
      });
      
      // The SDK automatically shows a security warning in the browser console
      console.log('✅ Aetherfy Vectors client initialized');
      this.updateStatus('Client initialized successfully', 'success');
      
    } catch (error) {
      this.handleError(error);
    }
  }

  // Set up the demo collection
  async setupDemo() {
    this.updateStatus('Setting up demo collection...', 'info');
    
    try {
      // Check if collection exists
      const exists = await this.client.collectionExists(this.currentCollection);
      
      if (!exists) {
        // Create the collection
        await this.client.createCollection(this.currentCollection, {
          size: 384, // OpenAI ada-002 embedding size
          distance: DistanceMetric.COSINE
        });
        this.updateStatus('Demo collection created', 'success');
        
        // Add sample data
        await this.addSampleProducts();
      } else {
        this.updateStatus('Demo collection already exists', 'info');
      }
      
      // Enable search functionality
      this.enableSearch();
      
    } catch (error) {
      this.handleError(error);
    }
  }

  // Add sample products to the collection
  async addSampleProducts() {
    const sampleProducts = [
      {
        id: 'laptop_1',
        vector: this.generateMockEmbedding(),
        payload: {
          name: 'Gaming Laptop Pro',
          category: 'Electronics',
          price: 1299.99,
          description: 'High-performance gaming laptop with RTX graphics',
          features: ['RGB keyboard', '144Hz display', '16GB RAM']
        }
      },
      {
        id: 'laptop_2',
        vector: this.generateMockEmbedding(),
        payload: {
          name: 'Business Ultrabook',
          category: 'Electronics', 
          price: 899.99,
          description: 'Lightweight ultrabook perfect for business professionals',
          features: ['Long battery life', 'Fingerprint reader', '8GB RAM']
        }
      },
      {
        id: 'headphones_1',
        vector: this.generateMockEmbedding(),
        payload: {
          name: 'Wireless Noise-Canceling Headphones',
          category: 'Audio',
          price: 299.99,
          description: 'Premium wireless headphones with active noise cancellation',
          features: ['40-hour battery', 'Quick charge', 'Premium sound']
        }
      },
      {
        id: 'phone_1',
        vector: this.generateMockEmbedding(),
        payload: {
          name: 'Smartphone Pro Max',
          category: 'Electronics',
          price: 1099.99,
          description: 'Latest smartphone with advanced camera system',
          features: ['Triple camera', '5G connectivity', 'Wireless charging']
        }
      }
    ];

    await this.client.upsert(this.currentCollection, sampleProducts);
    this.updateStatus(`Added ${sampleProducts.length} sample products`, 'success');
  }

  // Generate mock embeddings for demo (in real usage, use actual embeddings)
  generateMockEmbedding() {
    return Array.from({length: 384}, () => Math.random() * 2 - 1);
  }

  // Enable search functionality
  enableSearch() {
    const searchButton = document.getElementById('searchButton');
    const searchInput = document.getElementById('searchInput');
    
    if (searchButton && searchInput) {
      searchButton.disabled = false;
      searchInput.disabled = false;
      searchButton.onclick = () => this.performSearch();
      
      // Enable enter key for search
      searchInput.onkeypress = (e) => {
        if (e.key === 'Enter') {
          this.performSearch();
        }
      };
    }
  }

  // Perform similarity search
  async performSearch() {
    const searchInput = document.getElementById('searchInput');
    const query = searchInput?.value?.trim();
    
    if (!query) {
      this.updateStatus('Please enter a search query', 'warning');
      return;
    }

    this.updateStatus('Searching...', 'info');

    try {
      // In a real application, you would convert the text query to embeddings
      // using OpenAI, Cohere, or another embedding service
      // For this demo, we'll use a mock embedding
      const queryVector = this.generateMockEmbedding();
      
      const results = await this.client.search(this.currentCollection, queryVector, {
        limit: 5,
        withPayload: true,
        scoreThreshold: 0.0 // Accept all results for demo
      });

      this.displayResults(results, query);
      
    } catch (error) {
      this.handleError(error);
    }
  }

  // Display search results in the UI
  displayResults(results, query) {
    const resultsContainer = document.getElementById('results');
    if (!resultsContainer) return;

    if (results.length === 0) {
      resultsContainer.innerHTML = '<p class="no-results">No products found matching your query.</p>';
      this.updateStatus('No results found', 'warning');
      return;
    }

    let html = `<h3>Search Results for "${query}"</h3>`;
    html += '<div class="results-grid">';

    results.forEach(result => {
      const product = result.payload;
      html += `
        <div class="product-card">
          <h4>${product.name}</h4>
          <p class="category">${product.category}</p>
          <p class="price">$${product.price}</p>
          <p class="description">${product.description}</p>
          <p class="score">Similarity: ${(result.score * 100).toFixed(1)}%</p>
          <div class="features">
            ${product.features?.map(feature => `<span class="feature-tag">${feature}</span>`).join('') || ''}
          </div>
        </div>
      `;
    });

    html += '</div>';
    resultsContainer.innerHTML = html;
    
    this.updateStatus(`Found ${results.length} matching products`, 'success');
  }

  // Get and display analytics
  async showAnalytics() {
    try {
      const analytics = await this.client.getPerformanceAnalytics('1h');
      const usage = await this.client.getUsageStats();
      
      const analyticsHtml = `
        <div class="analytics-panel">
          <h3>Analytics Dashboard</h3>
          <div class="metric-grid">
            <div class="metric">
              <div class="metric-value">${analytics.cacheHitRate}%</div>
              <div class="metric-label">Cache Hit Rate</div>
            </div>
            <div class="metric">
              <div class="metric-value">${analytics.avgLatencyMs}ms</div>
              <div class="metric-label">Avg Latency</div>
            </div>
            <div class="metric">
              <div class="metric-value">${usage.currentCollections}</div>
              <div class="metric-label">Collections</div>
            </div>
            <div class="metric">
              <div class="metric-value">${usage.currentPoints}</div>
              <div class="metric-label">Total Points</div>
            </div>
          </div>
          <p class="plan-info">Current Plan: ${usage.planName}</p>
          <p class="regions">Active Regions: ${analytics.activeRegions.join(', ')}</p>
        </div>
      `;
      
      const analyticsContainer = document.getElementById('analytics');
      if (analyticsContainer) {
        analyticsContainer.innerHTML = analyticsHtml;
      }
      
    } catch (error) {
      this.handleError(error);
    }
  }

  // Handle errors with user-friendly messages
  handleError(error) {
    console.error('Error:', error);
    
    let message = 'An error occurred';
    let type = 'error';
    
    if (error.name === 'AuthenticationError') {
      message = 'Authentication failed. Please check your API key.';
    } else if (error.name === 'RateLimitExceededError') {
      message = `Rate limit exceeded. Please wait ${error.retryAfter || 60} seconds.`;
    } else if (error.name === 'NetworkError') {
      message = 'Network error. Please check your connection.';
    } else if (error.name === 'ValidationError') {
      message = `Validation error: ${error.message}`;
    } else {
      message = error.message || 'Unknown error occurred';
    }
    
    this.updateStatus(message, type);
  }

  // Update the status message in the UI
  updateStatus(message, type = 'info') {
    const statusElement = document.getElementById('status');
    if (!statusElement) return;
    
    statusElement.textContent = message;
    statusElement.className = `status status-${type}`;
    
    // Auto-clear success/info messages after 5 seconds
    if (type === 'success' || type === 'info') {
      setTimeout(() => {
        if (statusElement.textContent === message) {
          statusElement.textContent = '';
          statusElement.className = 'status';
        }
      }, 5000);
    }
  }

  // Clean up resources
  async cleanup() {
    if (this.client) {
      await this.client.dispose();
      this.client = null;
      this.updateStatus('Client disposed', 'info');
    }
  }
}

// Initialize the app when the page loads
let app;

document.addEventListener('DOMContentLoaded', () => {
  app = new VectorSearchApp();
  
  // Set up button handlers
  const setupButton = document.getElementById('setupButton');
  const analyticsButton = document.getElementById('analyticsButton');
  
  if (setupButton) {
    setupButton.onclick = () => app.setupDemo();
  }
  
  if (analyticsButton) {
    analyticsButton.onclick = () => app.showAnalytics();
  }
});

// Clean up when the page unloads
window.addEventListener('beforeunload', () => {
  if (app) {
    app.cleanup();
  }
});

export default VectorSearchApp;