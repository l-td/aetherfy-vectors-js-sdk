/**
 * Unit tests for HTTP client
 */

import nock from 'nock';
import { HttpClient } from '../../src/http/client';

describe('HttpClient', () => {
  let client: HttpClient;

  beforeEach(() => {
    client = new HttpClient({ enableConnectionPooling: false });
  });

  describe('Constructor', () => {
    it('should create client with default options', () => {
      expect(client).toBeInstanceOf(HttpClient);
    });

    it('should create client with custom options', () => {
      const customClient = new HttpClient({
        timeout: 60000,
        defaultHeaders: { 'Custom-Header': 'value' },
        enableConnectionPooling: false,
      });
      expect(customClient).toBeInstanceOf(HttpClient);
    });
  });

  describe('HTTP Methods', () => {
    it('should make GET requests', async () => {
      const scope = nock('https://api.example.com')
        .get('/test')
        .reply(200, { success: true });

      const response = await client.get('https://api.example.com/test');

      expect(response.status).toBe(200);
      expect(response.data).toEqual({ success: true });
      expect(scope.isDone()).toBe(true);
    });

    it('should make POST requests with body', async () => {
      const body = { name: 'test' };
      const scope = nock('https://api.example.com')
        .post('/test', body)
        .reply(200, { success: true });

      await client.post('https://api.example.com/test', body);

      expect(scope.isDone()).toBe(true);
    });

    it('should make PUT requests', async () => {
      const scope = nock('https://api.example.com')
        .put('/test', { id: 1 })
        .reply(200, { success: true });

      await client.put('https://api.example.com/test', { id: 1 });

      expect(scope.isDone()).toBe(true);
    });

    it('should make DELETE requests', async () => {
      const scope = nock('https://api.example.com')
        .delete('/test')
        .reply(200, { success: true });

      await client.delete('https://api.example.com/test');

      expect(scope.isDone()).toBe(true);
    });
  });

  describe('Request Configuration', () => {
    it('should include custom headers', async () => {
      const scope = nock('https://api.example.com')
        .get('/test')
        .matchHeader('Authorization', 'Bearer token')
        .reply(200, {});

      await client.get('https://api.example.com/test', {
        Authorization: 'Bearer token',
      });

      expect(scope.isDone()).toBe(true);
    });

    it('should merge default and custom headers', async () => {
      const clientWithDefaults = new HttpClient({
        defaultHeaders: { 'X-Custom': 'default' },
        enableConnectionPooling: false,
      });

      const scope = nock('https://api.example.com')
        .get('/test')
        .matchHeader('X-Custom', 'default')
        .matchHeader('Authorization', 'Bearer token')
        .reply(200, {});

      await clientWithDefaults.get('https://api.example.com/test', {
        Authorization: 'Bearer token',
      });

      expect(scope.isDone()).toBe(true);
    });
  });

  describe('Response Handling', () => {
    it('should handle JSON responses', async () => {
      nock('https://api.example.com').get('/test').reply(200, { data: 'test' });

      const response = await client.get('https://api.example.com/test');
      expect(response.data).toEqual({ data: 'test' });
    });

    it('should handle text responses', async () => {
      nock('https://api.example.com').get('/test').reply(200, 'plain text');

      const response = await client.get('https://api.example.com/test');
      expect(response.data).toBe('plain text');
    });

    it('should parse response headers', async () => {
      nock('https://api.example.com').get('/test').reply(
        200,
        {},
        {
          'content-type': 'application/json',
          'x-request-id': 'req-123',
        }
      );

      const response = await client.get('https://api.example.com/test');
      expect(response.headers).toMatchObject({
        'content-type': 'application/json',
        'x-request-id': 'req-123',
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle HTTP error responses', async () => {
      nock('https://api.example.com').get('/test').reply(404, {
        message: 'Resource not found',
      });

      await expect(
        client.get('https://api.example.com/test')
      ).rejects.toThrow();
    });

    it('should handle network errors', async () => {
      nock('https://api.example.com')
        .get('/test')
        .replyWithError(new Error('Network Error'));

      await expect(client.get('https://api.example.com/test')).rejects.toThrow(
        'Network Error'
      );
    });

    it('should handle network errors with context', async () => {
      nock('https://api.example.com')
        .get('/test')
        .replyWithError(new Error('Network Error'));

      const fastClient = new HttpClient({
        timeout: 10,
        enableConnectionPooling: false,
      });

      await expect(
        fastClient.get('https://api.example.com/test')
      ).rejects.toThrow();
    });

    it('should handle request timeout with AbortError', async () => {
      nock('https://api.example.com').get('/test').delay(100).reply(200, {});

      const fastClient = new HttpClient({
        timeout: 10,
        enableConnectionPooling: false,
      });

      await expect(
        fastClient.get('https://api.example.com/test')
      ).rejects.toThrow();
    });

    it('should handle errors with status property', async () => {
      nock('https://api.example.com').get('/test').reply(400, {
        message: 'Bad request',
      });

      await expect(client.get('https://api.example.com/test')).rejects.toThrow(
        'Bad request'
      );
    });
  });

  describe('Request Options', () => {
    it('should use custom timeout', async () => {
      const scope = nock('https://api.example.com').get('/test').reply(200, {});

      await client.request({
        url: 'https://api.example.com/test',
        method: 'GET',
        timeout: 5000,
      });

      expect(scope.isDone()).toBe(true);
    });

    it('should handle request without body', async () => {
      const scope = nock('https://api.example.com').get('/test').reply(200, {});

      await client.request({
        url: 'https://api.example.com/test',
        method: 'GET',
      });

      expect(scope.isDone()).toBe(true);
    });
  });

  describe('Connection Pooling', () => {
    it('should create client with connection pooling enabled', () => {
      const pooledClient = new HttpClient({
        enableConnectionPooling: true,
      });
      expect(pooledClient).toBeInstanceOf(HttpClient);
      pooledClient.destroy();
    });

    it('should create client with connection pooling disabled', () => {
      const nonPooledClient = new HttpClient({
        enableConnectionPooling: false,
      });
      expect(nonPooledClient).toBeInstanceOf(HttpClient);
      nonPooledClient.destroy();
    });

    it('should destroy agents when destroy is called', () => {
      const pooledClient = new HttpClient({
        enableConnectionPooling: true,
      });
      // Should not throw
      expect(() => pooledClient.destroy()).not.toThrow();
    });
  });

  describe('Error Edge Cases', () => {
    it('should handle errors with custom code', async () => {
      const error = new Error('Custom error');
      (error as any).code = 'CUSTOM_ERROR';

      nock('https://api.example.com').get('/test').replyWithError(error);

      await expect(client.get('https://api.example.com/test')).rejects.toThrow(
        'Network error'
      );
    });

    it('should handle errors with code property', async () => {
      const error = new Error('Connection reset');
      (error as any).code = 'ECONNRESET';

      nock('https://api.example.com').get('/test').replyWithError(error);

      await expect(
        client.get('https://api.example.com/test')
      ).rejects.toThrow();
    });

    it('should handle generic Error objects', async () => {
      nock('https://api.example.com')
        .get('/test')
        .replyWithError(new Error('Generic error'));

      await expect(
        client.get('https://api.example.com/test')
      ).rejects.toThrow();
    });

    it('should handle Error with Network error prefix already present', async () => {
      nock('https://api.example.com')
        .get('/test')
        .replyWithError(new Error('Network error: Already formatted'));

      await expect(client.get('https://api.example.com/test')).rejects.toThrow(
        'Network error: Already formatted'
      );
    });

    it('should handle axios-specific timeout errors', async () => {
      const timeoutError = new Error('timeout of 100ms exceeded');
      (timeoutError as any).code = 'ECONNABORTED';

      nock('https://api.example.com').get('/test').replyWithError(timeoutError);

      await expect(client.get('https://api.example.com/test')).rejects.toThrow(
        'Network error'
      );
    });

    it('should handle errors without message property', async () => {
      const errorWithoutMessage = new Error();
      errorWithoutMessage.message = '';

      nock('https://api.example.com')
        .get('/test')
        .replyWithError(errorWithoutMessage);

      await expect(
        client.get('https://api.example.com/test')
      ).rejects.toThrow();
    });
  });
});
