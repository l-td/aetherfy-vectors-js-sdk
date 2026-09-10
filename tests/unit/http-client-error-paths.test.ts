/**
 * The transport layer's FAILURE paths.
 *
 * WHY A SEPARATE FILE. src/http was the least-covered area of this package at
 * 84.7% statements and 83.9% branches, and everything missing was an error or
 * edge branch: what happens when a thrown value is not an AxiosError, what
 * happens to a body that cannot be serialised, what the timeout does once a
 * payload is large. Those are the branches that run when production goes
 * wrong, and they are the hardest to reproduce after the fact — which is
 * exactly why they were the ones with no test.
 *
 * The happy paths and the status-code handling live in http-client.test.ts and
 * are left alone.
 */

import { HttpClient } from '../../src/http/client';

// The constants the timeout scaling is defined against. Deliberately restated
// here rather than imported: they are not exported, and a test that read the
// same expression as the code would agree with it no matter what it said.
const THRESHOLD_BYTES = 5 * 1024 * 1024;
const PER_MB_OVER_MS = 1000;

/** Reach a private member without loosening the class's own types. */
function internals(client: HttpClient): {
  prepareBody(body: unknown): { data: unknown; bodyBytes: number };
  computeBodyAwareTimeout(bodyBytes: number): number;
  axiosInstance: { request: (...args: unknown[]) => Promise<unknown> };
} {
  return client as unknown as ReturnType<typeof internals>;
}

describe('HttpClient error and edge paths', () => {
  let client: HttpClient;

  beforeEach(() => {
    client = new HttpClient({ timeout: 30000, enableConnectionPooling: false });
  });

  describe('a thrown value that is not an AxiosError', () => {
    // The `!isAxiosError(error)` branch. Nothing reached it, because every
    // other test drives failures through nock, which produces axios errors.
    // Anything else reaching this catch means no response was ever received,
    // so it must surface as a network error rather than an API error — the
    // distinction callers branch on.

    it('reports a plain Error as a network error, keeping its message', async () => {
      internals(client).axiosInstance.request = () =>
        Promise.reject(new Error('socket hang up'));

      await expect(client.get('https://api.example.com/x')).rejects.toThrow(
        'Network error: socket hang up'
      );
    });

    it('does not double-prefix a message that already says Network error', async () => {
      internals(client).axiosInstance.request = () =>
        Promise.reject(new Error('Network error: already said so'));

      await expect(client.get('https://api.example.com/x')).rejects.toThrow(
        'Network error: already said so'
      );
      // The naive fix for the case above is a blind prefix, which would read
      // "Network error: Network error: ...". Asserting the exact message is
      // what stops that.
      await expect(client.get('https://api.example.com/x')).rejects.toThrow(
        /^Network error: already said so$/
      );
    });

    it('survives a thrown value that is not an Error at all', async () => {
      // A rejected promise can carry anything: a string, a number, undefined.
      // The branch that handles it existed and had never run.
      internals(client).axiosInstance.request = () =>
        Promise.reject('a bare string');

      await expect(client.get('https://api.example.com/x')).rejects.toThrow(
        'Network error: Unknown network error'
      );
    });
  });

  describe('prepareBody', () => {
    it('treats null and undefined as zero bytes and passes them through', () => {
      expect(internals(client).prepareBody(undefined)).toEqual({
        data: undefined,
        bodyBytes: 0,
      });
      expect(internals(client).prepareBody(null)).toEqual({
        data: null,
        bodyBytes: 0,
      });
    });

    it('measures a string in UTF-8 bytes, not characters', () => {
      // The distinction matters for the timeout below: a multibyte payload is
      // larger on the wire than its length suggests, and a length-based
      // measure would under-scale the timeout for exactly the callers who
      // need it most.
      const multibyte = 'é'.repeat(10); // 10 chars, 20 bytes
      expect(internals(client).prepareBody(multibyte)).toEqual({
        data: multibyte,
        bodyBytes: 20,
      });
    });

    it('measures a Uint8Array by its byte length and does not serialise it', () => {
      const bytes = new Uint8Array(64);
      const prepared = internals(client).prepareBody(bytes);
      expect(prepared.bodyBytes).toBe(64);
      expect(prepared.data).toBe(bytes);
    });

    it('serialises an object and reports the serialised size', () => {
      const prepared = internals(client).prepareBody({ a: 1 });
      expect(prepared.data).toBe('{"a":1}');
      expect(prepared.bodyBytes).toBe(7);
    });

    it('hands a circular object back unserialised rather than throwing', () => {
      // JSON.stringify throws on a cycle. The request should still fire with
      // the original value and the base timeout, because failing to MEASURE a
      // body is not a reason to refuse to SEND it.
      const circular: Record<string, unknown> = { name: 'loop' };
      circular.self = circular;

      const prepared = internals(client).prepareBody(circular);
      expect(prepared.data).toBe(circular);
      expect(prepared.bodyBytes).toBe(0);
    });
  });

  describe('computeBodyAwareTimeout', () => {
    it('leaves the base timeout alone at and below the threshold', () => {
      expect(internals(client).computeBodyAwareTimeout(0)).toBe(30000);
      expect(internals(client).computeBodyAwareTimeout(THRESHOLD_BYTES)).toBe(
        30000
      );
    });

    it('adds a full increment for any part of a megabyte over', () => {
      // Ceiling, not floor: one byte over the threshold still buys a whole
      // increment. A floor would give a body just past the line the same
      // timeout as one exactly on it.
      expect(
        internals(client).computeBodyAwareTimeout(THRESHOLD_BYTES + 1)
      ).toBe(30000 + PER_MB_OVER_MS);
    });

    it('scales linearly with megabytes over the threshold', () => {
      expect(
        internals(client).computeBodyAwareTimeout(
          THRESHOLD_BYTES + 3 * 1024 * 1024
        )
      ).toBe(30000 + 3 * PER_MB_OVER_MS);
    });
  });
});
