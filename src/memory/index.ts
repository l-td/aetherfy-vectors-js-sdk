/**
 * Aetherfy Memory SDK — barrel exports.
 *
 * Agent memory primitives — conversations, knowledge bases, scraping logs,
 * customer state, anything an agent needs to remember across turns or runs.
 *
 * @example
 * ```typescript
 * import { MemoryClient } from 'aetherfy-vectors/memory';
 *
 * const memory = new MemoryClient();
 *
 * await memory.createNamespace('customer-42');
 * const customer = await memory.namespace('customer-42');
 * await customer.add({ text: 'Lives in NYC', vector: await embed('...') });
 * const results = await customer.search(await embed('where does customer live?'));
 *
 * await memory.createThread('conv-99');
 * const chat = await memory.thread('conv-99');
 * await chat.add({ role: 'user', content: 'hi', vector: await embed('hi') });
 * const history = await chat.history({ limit: 20 });
 * ```
 *
 * For raw-Qdrant operations not exposed here, drop to the low-level client:
 *
 * ```typescript
 * memory.vectors.scroll(...);   // any AetherfyVectorsClient method
 * // or directly:
 * import { AetherfyVectorsClient } from 'aetherfy-vectors';
 * ```
 */

export { MemoryClient } from './client';
export type { MemoryClientConfig, CreateScopeOptions } from './client';

export { Namespace } from './namespace';
export type {
  NamespaceAddOptions,
  NamespaceSearchOptions,
  NamespaceRetrieveOptions,
  NamespaceSetSchemaOptions,
} from './namespace';

export { Thread } from './thread';
export type { ThreadAddOptions, ThreadHistoryOptions } from './thread';

export { DEFAULT_VECTOR_SIZE } from './models';
export type { Message } from './models';

export {
  AetherfyMemoryError,
  EmbeddingNotSupportedError,
  InvalidNameError,
  NamespaceAlreadyExistsError,
  NamespaceNotFoundError,
  ThreadAlreadyExistsError,
  ThreadNotFoundError,
} from './errors';
