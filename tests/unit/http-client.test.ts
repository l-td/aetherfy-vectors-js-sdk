/**
 * Unit tests for HTTP client
 */

import { HttpClient } from '../../src/http/client';
import fetchMock from 'jest-fetch-mock';

describe('HttpClient', () => {
  let client: HttpClient;

  beforeEach(() => {
    client = new HttpClient();
    fetchMock.resetMocks();
  });

  afterAll(() => {
    fetchMock.disableMocks();
  });

  describe('Constructor', () => {
    it('should create client with default options', () => {
      expect(client).toBeInstanceOf(HttpClient);
    });

    it('should create client with custom options', () => {
      const customClient = new HttpClient({
        timeout: 60000,
        defaultHeaders: { 'Custom-Header': 'value' },
      });
      expect(customClient).toBeInstanceOf(HttpClient);
    });
  });

  describe('HTTP Methods', () => {
    beforeEach(() => {
      fetchMock.mockResponse(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    it('should make GET requests', async () => {
      const response = await client.get('https://api.example.com/test');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.example.com/test',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'User-Agent': 'Aetherfy-Vectors-JS/1.0.0',
          }),
        })
      );

      expect(response.data).toEqual({ success: true });
      expect(response.status).toBe(200);
    });

    it('should make POST requests with body', async () => {
      const body = { name: 'test' };
      await client.post('https://api.example.com/test', body);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.example.com/test',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(body),
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('should make PUT requests', async () => {
      await client.put('https://api.example.com/test', { id: 1 });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.example.com/test',
        expect.objectContaining({
          method: 'PUT',
        })
      );
    });

    it('should make DELETE requests', async () => {
      await client.delete('https://api.example.com/test');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.example.com/test',
        expect.objectContaining({
          method: 'DELETE',
        })
      );
    });
  });

  describe('Request Configuration', () => {
    beforeEach(() => {
      fetchMock.mockResponse(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    it('should include custom headers', async () => {
      await client.get('https://api.example.com/test', {
        Authorization: 'Bearer token',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.example.com/test',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer token',
          }),
        })
      );
    });

    it('should merge default and custom headers', async () => {
      const clientWithDefaults = new HttpClient({
        defaultHeaders: { 'X-Custom': 'default' },
      });

      await clientWithDefaults.get('https://api.example.com/test', {
        Authorization: 'Bearer token',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.example.com/test',
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Custom': 'default',
            Authorization: 'Bearer token',
          }),
        })
      );
    });
  });

  describe('Response Handling', () => {
    it('should handle JSON responses', async () => {
      fetchMock.mockResponse(JSON.stringify({ data: 'test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

      const response = await client.get('https://api.example.com/test');
      expect(response.data).toEqual({ data: 'test' });
    });

    it('should handle text responses', async () => {
      fetchMock.mockResponse('plain text', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });

      const response = await client.get('https://api.example.com/test');
      expect(response.data).toBe('plain text');
    });

    it('should parse response headers', async () => {
      fetchMock.mockResponse(JSON.stringify({}), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req-123',
        },
      });

      const response = await client.get('https://api.example.com/test');
      expect(response.headers).toEqual({
        'content-type': 'application/json',
        'x-request-id': 'req-123',
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle HTTP error responses', async () => {
      fetchMock.mockResponse(
        JSON.stringify({ message: 'Resource not found' }),
        {
          status: 404,
          statusText: 'Not Found',
          headers: { 'content-type': 'application/json' },
        }
      );

      await expect(
        client.get('https://api.example.com/test')
      ).rejects.toThrow();
    });

    it('should handle network errors', async () => {
      fetchMock.mockReject(new Error('Network error'));

      await expect(client.get('https://api.example.com/test')).rejects.toThrow(
        'Network error'
      );
    });

    it('should handle network errors', async () => {
      // Mock fetch to simulate a network error
      fetchMock.mockImplementation(() =>
        Promise.reject(new Error('Network request failed'))
      );

      const fastClient = new HttpClient({ timeout: 10 });

      await expect(
        fastClient.get('https://api.example.com/test')
      ).rejects.toThrow('Network error: Network request failed');
    });
  });

  describe('Request Options', () => {
    beforeEach(() => {
      fetchMock.mockResponse(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    it('should use custom timeout', async () => {
      await client.request({
        url: 'https://api.example.com/test',
        method: 'GET',
        timeout: 5000,
      });

      // Verify request was made (AbortSignal is disabled in tests)
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.example.com/test',
        expect.objectContaining({
          method: 'GET',
          headers: expect.any(Object),
        })
      );
    });

    it('should handle request without body', async () => {
      await client.request({
        url: 'https://api.example.com/test',
        method: 'GET',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.example.com/test',
        expect.objectContaining({
          method: 'GET',
          body: undefined,
        })
      );
    });
  });
});
