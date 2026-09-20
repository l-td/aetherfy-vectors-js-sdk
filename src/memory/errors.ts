/**
 * Errors for the Aetherfy Memory SDK.
 *
 * Extends AetherfyVectorsError so `instanceof AetherfyVectorsError` still
 * matches memory-layer errors. Generic vector-db errors continue to bubble
 * up from the underlying AetherfyVectorsClient.
 *
 * Each class re-sets its prototype after `super()` because the parent
 * AetherfyVectorsError constructor resets the prototype chain to its own
 * class (standard workaround for ES5-target Error subclassing, which
 * otherwise breaks `instanceof` for subclasses). See the same pattern
 * in ../exceptions.ts.
 */

import { AetherfyVectorsError } from '../exceptions';

export class AetherfyMemoryError extends AetherfyVectorsError {
  constructor(message: string) {
    super(message);
    this.name = 'AetherfyMemoryError';
    Object.setPrototypeOf(this, AetherfyMemoryError.prototype);
  }
}

export class NamespaceNotFoundError extends AetherfyMemoryError {
  constructor(public readonly namespaceName: string) {
    super(
      `Namespace '${namespaceName}' does not exist. ` +
        `Call memory.createNamespace('${namespaceName}') before adding or searching.`
    );
    this.name = 'NamespaceNotFoundError';
    Object.setPrototypeOf(this, NamespaceNotFoundError.prototype);
  }
}

export class ThreadNotFoundError extends AetherfyMemoryError {
  constructor(public readonly threadId: string) {
    super(
      `Thread '${threadId}' does not exist. ` +
        `Call memory.createThread('${threadId}') before adding or searching.`
    );
    this.name = 'ThreadNotFoundError';
    Object.setPrototypeOf(this, ThreadNotFoundError.prototype);
  }
}

export class NamespaceAlreadyExistsError extends AetherfyMemoryError {
  constructor(public readonly namespaceName: string) {
    super(`Namespace '${namespaceName}' already exists.`);
    this.name = 'NamespaceAlreadyExistsError';
    Object.setPrototypeOf(this, NamespaceAlreadyExistsError.prototype);
  }
}

export class ThreadAlreadyExistsError extends AetherfyMemoryError {
  constructor(public readonly threadId: string) {
    super(`Thread '${threadId}' already exists.`);
    this.name = 'ThreadAlreadyExistsError';
    Object.setPrototypeOf(this, ThreadAlreadyExistsError.prototype);
  }
}

/**
 * Thrown when the threads collection already exists at another dimension.
 *
 * Every thread shares ONE collection, so they share one vector size and one
 * distance metric — fixed when that collection is first created. Asking for
 * a different size later cannot be honoured, and letting it through would
 * surface three layers down as a bare dimension error on the first `add`.
 * Thrown at create time instead, naming the dimension that is actually
 * there.
 */
export class ThreadVectorSizeMismatchError extends AetherfyMemoryError {
  constructor(
    public readonly existing: number,
    public readonly requested: number
  ) {
    super(
      `The threads collection already exists with vector size ${existing}, ` +
        `but this MemoryClient is configured for ${requested}. Every thread ` +
        `shares one collection and therefore one dimension. Construct ` +
        `new MemoryClient({ threadVectorSize: ${existing} }) to use it, or ` +
        `delete every thread to re-create the collection at another size.`
    );
    this.name = 'ThreadVectorSizeMismatchError';
    Object.setPrototypeOf(this, ThreadVectorSizeMismatchError.prototype);
  }
}

export class InvalidNameError extends AetherfyMemoryError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNameError';
    Object.setPrototypeOf(this, InvalidNameError.prototype);
  }
}

/**
 * Raised when a caller omits `vector` expecting server-side embedding.
 *
 * Server-side embedding lands in a future release (DX_ROADMAP T2-0).
 * Until then, callers must compute embeddings client-side and pass `vector`.
 */
export class EmbeddingNotSupportedError extends AetherfyMemoryError {
  constructor(context?: string) {
    const base =
      'vector is required. Server-side embedding (add with text only) is ' +
      'planned for a future release; for now, compute the embedding ' +
      'client-side and pass vector=...';
    super(context ? `${context}: ${base}` : base);
    this.name = 'EmbeddingNotSupportedError';
    Object.setPrototypeOf(this, EmbeddingNotSupportedError.prototype);
  }
}
