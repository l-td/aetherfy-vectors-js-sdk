/**
 * Every public entry point that takes an options object refuses a key its
 * type does not declare, and accepts every key it does.
 *
 * Why this exists: TypeScript rejects an unknown key only in a fresh object
 * literal at a typed call site. Before this, a plain-JavaScript caller, an
 * options object built elsewhere or a spread passed any key it liked, and the
 * key was ignored. The case that mattered:
 *     new AetherfyVectorsClient({ apiKey, region: 'eu-central-1' })
 * (the Python SDK's pre-rename spelling) connected to the DEFAULT endpoint,
 * with no error. The Python SDK raises TypeError for an unknown keyword; this
 * pins the same contract here, per entry point.
 *
 * THE DECLARED KEYS ARE READ FROM THE SOURCE WITH THE TYPESCRIPT COMPILER, not
 * from the SDK's runtime lists, so the test is not the list checking itself:
 *
 *   - ACCEPTED: a call carrying EVERY declared key runs to completion (keys the
 *     call needs carry a real value, the rest `undefined`, which means "not
 *     set").
 *   - REFUSED: a call carrying one unknown key throws a TypeError whose message
 *     starts `<method>: unknown option(s): <key>.`, before any request is made
 *     or any collaborator is touched.
 *   - THE SAME SET: the "Accepted: ..." list in that message equals the
 *     compiler's key set. A runtime list built some other way than
 *     optionKeys() — retyped by hand — still cannot drift unnoticed.
 *   - `undefined` IS NO EXCUSE: `{ <unknown>: undefined }` is refused too.
 *     What is checked is the name the caller used, as in Python, where
 *     `f(region=None)` is a TypeError.
 *
 * Methods that return an iterator (scrollIter, iter, iterHistory) and the
 * constructors refuse SYNCHRONOUSLY, at the call. A generator's body does not
 * run until the first next(), so a guard inside it would let
 * `const it = client.scrollIter(c, { limit: 100 })` succeed.
 *
 * ENTRY_POINTS is the enumeration; its anti-no-op check at the bottom requires
 * every class/function it names to be found in the source, with an options
 * parameter that has at least one property.
 */

import { join } from 'node:path';
import * as ts from 'typescript';

import { AetherfyVectorsClient } from '../../src/client';
import { fanOut } from '../../src/agent';
import { MemoryClient } from '../../src/memory/client';
import { Namespace } from '../../src/memory/namespace';
import { Thread } from '../../src/memory/thread';

const SRC = join(__dirname, '..', '..', 'src');
const API_KEY = 'afy_test_1234567890123456';
const VECTOR = [0.1, 0.2, 0.3];

// ---------------------------------------------------------------------------
// Declared keys, from the compiler
// ---------------------------------------------------------------------------

let program: ts.Program;
let checker: ts.TypeChecker;

beforeAll(() => {
  program = ts.createProgram(
    [join(SRC, 'index.ts'), join(SRC, 'agent', 'index.ts')],
    {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'],
      types: ['node'],
    }
  );
  checker = program.getTypeChecker();
}, 120_000);

/** The class or function declaration named `name` in src/. */
function findDeclaration(
  name: string
): ts.ClassDeclaration | ts.FunctionDeclaration {
  const found: Array<ts.ClassDeclaration | ts.FunctionDeclaration> = [];
  for (const file of program.getSourceFiles()) {
    if (!file.fileName.replace(/\\/g, '/').includes('/src/')) continue;
    ts.forEachChild(file, node => {
      if (
        (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) &&
        node.name?.text === name
      ) {
        found.push(node);
      }
    });
  }
  if (found.length !== 1) {
    throw new Error(
      `expected one declaration of ${name}, found ${found.length}`
    );
  }
  return found[0];
}

/**
 * The property names of parameter `index` of `owner.member` (or of the
 * function `owner` when `member` is undefined). An array parameter yields its
 * ELEMENT type's properties: addMany / appendMany take a list of options.
 */
function declaredKeys(where: Where): string[] {
  const decl = findDeclaration(where.owner);
  let fn: ts.SignatureDeclaration | undefined;
  if (ts.isFunctionDeclaration(decl)) {
    fn = decl;
  } else {
    fn = decl.members.find(
      (m): m is ts.MethodDeclaration | ts.ConstructorDeclaration =>
        where.member === 'constructor'
          ? ts.isConstructorDeclaration(m)
          : ts.isMethodDeclaration(m) &&
            ts.isIdentifier(m.name) &&
            m.name.text === where.member
    );
  }
  if (!fn) throw new Error(`${where.owner}.${where.member} not found`);
  const param = fn.parameters[where.param];
  if (!param) {
    throw new Error(
      `${where.owner}.${where.member} has no parameter ${where.param}`
    );
  }
  let type = checker.getNonNullableType(checker.getTypeAtLocation(param));
  const element = type.getNumberIndexType();
  if (where.element) {
    if (!element)
      throw new Error(`${where.owner}.${where.member}: not an array`);
    type = element;
  }
  return checker.getPropertiesOfType(type).map(p => p.name);
}

// ---------------------------------------------------------------------------
// Collaborators: a fake transport for the vectors client, a fake vectors
// client for the memory layer. Every method records its calls, so a refusal
// can be shown to have happened before any of them ran.
// ---------------------------------------------------------------------------

const OK = {
  status: 200,
  data: { result: { count: 0, points: [], next_page_offset: null } },
};

function fakeTransport() {
  return {
    get: jest.fn().mockResolvedValue(OK),
    post: jest.fn().mockResolvedValue(OK),
    put: jest.fn().mockResolvedValue(OK),
    delete: jest.fn().mockResolvedValue(OK),
    destroy: jest.fn(),
  };
}

function vectorsClient() {
  const client = new AetherfyVectorsClient({
    apiKey: API_KEY,
    enableConnectionPooling: false,
  });
  const transport = fakeTransport();
  (client as unknown as { httpClient: unknown }).httpClient = transport;
  return { client, touched: () => allCalls(transport) };
}

async function* none(): AsyncGenerator<never> {
  // an empty page stream
}

function fakeVectors() {
  const fake = {
    workspace: undefined,
    collectionExists: jest.fn().mockResolvedValue(false),
    createCollection: jest.fn().mockResolvedValue({}),
    upsert: jest.fn().mockResolvedValue(true),
    search: jest.fn().mockResolvedValue([]),
    retrieve: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    scroll: jest.fn().mockResolvedValue({ points: [], nextPageOffset: null }),
    scrollIter: jest.fn().mockImplementation(() => none()),
    setSchema: jest.fn().mockResolvedValue('etag'),
  };
  return {
    vectors: fake as unknown as AetherfyVectorsClient,
    touched: () => allCalls(fake),
  };
}

function allCalls(fns: Record<string, unknown>): number {
  return Object.values(fns).reduce<number>(
    (n, f) => n + (jest.isMockFunction(f) ? f.mock.calls.length : 0),
    0
  );
}

function namespace() {
  const { vectors, touched } = fakeVectors();
  return { scope: new Namespace('ns', 'ns', vectors), touched };
}

function thread() {
  const { vectors, touched } = fakeVectors();
  return { scope: new Thread('t1', '__threads__', vectors), touched };
}

// ---------------------------------------------------------------------------
// The entry points
// ---------------------------------------------------------------------------

type Options = Record<string, unknown>;

interface Where {
  owner: string;
  member?: string;
  param: number;
  element?: boolean;
}

interface EntryPoint {
  /** The method name the refusal must carry. */
  label: string;
  /** Where the compiler reads the options type. */
  where: Where;
  /** Declared keys a completed call needs a real value for. */
  required?: Options;
  /** True when the refusal must be a synchronous throw, not a rejection. */
  sync?: boolean;
  /**
   * Make the call. `touched()` counts collaborator calls made so far, or is
   * null where the entry point has no collaborator to stand in for (the
   * constructors, create() without discovery, fanOut).
   */
  setup: () => {
    call: (options: Options) => unknown;
    touched: () => number | null;
  };
}

function onVectors(
  call: (client: AetherfyVectorsClient, options: Options) => unknown
): EntryPoint['setup'] {
  return () => {
    const { client, touched } = vectorsClient();
    return { call: options => call(client, options), touched };
  };
}

function onScope<S>(
  make: () => { scope: S; touched: () => number },
  call: (scope: S, options: Options) => unknown
): EntryPoint['setup'] {
  return () => {
    const { scope, touched } = make();
    return { call: options => call(scope, options), touched };
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const ENTRY_POINTS: EntryPoint[] = [
  // --- AetherfyVectorsClient (src/client.ts) ---
  {
    label: 'AetherfyVectorsClient constructor',
    where: { owner: 'AetherfyVectorsClient', member: 'constructor', param: 0 },
    required: { apiKey: API_KEY },
    sync: true,
    setup: () => ({
      call: options => new AetherfyVectorsClient(options as any),
      touched: () => null,
    }),
  },
  {
    label: 'AetherfyVectorsClient.create',
    where: { owner: 'AetherfyVectorsClient', member: 'create', param: 0 },
    required: { apiKey: API_KEY },
    setup: () => ({
      call: options => AetherfyVectorsClient.create(options as any),
      touched: () => null,
    }),
  },
  {
    label: 'setPayload',
    where: { owner: 'AetherfyVectorsClient', member: 'setPayload', param: 3 },
    setup: onVectors((c, o) => c.setPayload('col', { a: 1 }, [1], o as any)),
  },
  {
    label: 'retrieve',
    where: { owner: 'AetherfyVectorsClient', member: 'retrieve', param: 2 },
    setup: onVectors((c, o) => c.retrieve('col', [1], o as any)),
  },
  {
    label: 'search',
    where: { owner: 'AetherfyVectorsClient', member: 'search', param: 2 },
    setup: onVectors((c, o) => c.search('col', VECTOR, o as any)),
  },
  {
    label: 'scroll',
    where: { owner: 'AetherfyVectorsClient', member: 'scroll', param: 1 },
    setup: onVectors((c, o) => c.scroll('col', o as any)),
  },
  {
    label: 'scrollIter',
    where: { owner: 'AetherfyVectorsClient', member: 'scrollIter', param: 1 },
    sync: true,
    setup: onVectors((c, o) => c.scrollIter('col', o as any)),
  },
  {
    label: 'count',
    where: { owner: 'AetherfyVectorsClient', member: 'count', param: 1 },
    setup: onVectors((c, o) => c.count('col', o as any)),
  },

  // --- MemoryClient (src/memory/client.ts) ---
  {
    label: 'MemoryClient constructor',
    where: { owner: 'MemoryClient', member: 'constructor', param: 0 },
    required: { apiKey: API_KEY },
    sync: true,
    setup: () => ({
      call: options => new MemoryClient(options as any),
      touched: () => null,
    }),
  },
  {
    label: 'MemoryClient.createNamespace',
    where: { owner: 'MemoryClient', member: 'createNamespace', param: 1 },
    setup: () => {
      const { vectors, touched } = fakeVectors();
      const memory = new MemoryClient({ client: vectors });
      return {
        call: options => memory.createNamespace('ns', options as any),
        touched,
      };
    },
  },

  // --- Namespace (src/memory/namespace.ts + scope.ts) ---
  {
    label: 'Namespace.add',
    where: { owner: 'Namespace', member: 'add', param: 0 },
    required: { vector: VECTOR },
    setup: onScope(namespace, (s, o) => s.add(o as any)),
  },
  {
    label: 'Namespace.addMany[0]',
    where: { owner: 'Namespace', member: 'addMany', param: 0, element: true },
    required: { vector: VECTOR },
    setup: onScope(namespace, (s, o) => s.addMany([o as any])),
  },
  {
    label: 'Namespace.setSchema',
    where: { owner: 'Namespace', member: 'setSchema', param: 1 },
    setup: onScope(namespace, (s, o) => s.setSchema({ fields: {} }, o as any)),
  },
  {
    label: 'Namespace.search',
    where: { owner: 'Scope', member: 'search', param: 1 },
    setup: onScope(namespace, (s, o) => s.search(VECTOR, o as any)),
  },
  {
    label: 'Namespace.retrieve',
    where: { owner: 'Scope', member: 'retrieve', param: 1 },
    setup: onScope(namespace, (s, o) => s.retrieve([1], o as any)),
  },
  {
    label: 'Namespace.count',
    where: { owner: 'Scope', member: 'count', param: 0 },
    setup: onScope(namespace, (s, o) => s.count(o as any)),
  },
  {
    label: 'Namespace.iter',
    where: { owner: 'Scope', member: 'iter', param: 0 },
    sync: true,
    setup: onScope(namespace, (s, o) => s.iter(o as any)),
  },

  // --- Thread (src/memory/thread.ts + scope.ts) ---
  {
    label: 'Thread.add',
    where: { owner: 'Thread', member: 'add', param: 0 },
    required: { role: 'user', content: 'hi', vector: VECTOR },
    setup: onScope(thread, (s, o) => s.add(o as any)),
  },
  {
    label: 'Thread.appendMany[0]',
    where: { owner: 'Thread', member: 'appendMany', param: 0, element: true },
    required: { role: 'user', content: 'hi', vector: VECTOR },
    setup: onScope(thread, (s, o) => s.appendMany([o as any])),
  },
  {
    label: 'Thread.history',
    where: { owner: 'Thread', member: 'history', param: 0 },
    setup: onScope(thread, (s, o) => s.history(o as any)),
  },
  {
    label: 'Thread.iterHistory',
    where: { owner: 'Thread', member: 'iterHistory', param: 0 },
    sync: true,
    setup: onScope(thread, (s, o) => s.iterHistory(o as any)),
  },
  {
    label: 'Thread.search',
    where: { owner: 'Scope', member: 'search', param: 1 },
    setup: onScope(thread, (s, o) => s.search(VECTOR, o as any)),
  },
  {
    label: 'Thread.retrieve',
    where: { owner: 'Scope', member: 'retrieve', param: 1 },
    setup: onScope(thread, (s, o) => s.retrieve([1], o as any)),
  },
  {
    label: 'Thread.count',
    where: { owner: 'Scope', member: 'count', param: 0 },
    setup: onScope(thread, (s, o) => s.count(o as any)),
  },
  {
    label: 'Thread.iter',
    where: { owner: 'Scope', member: 'iter', param: 0 },
    sync: true,
    setup: onScope(thread, (s, o) => s.iter(o as any)),
  },

  // --- agent helper (src/agent/index.ts) ---
  {
    label: 'fanOut',
    where: { owner: 'fanOut', param: 2 },
    setup: () => ({
      call: options => fanOut(x => x, [1, 2], options as any),
      touched: () => null,
    }),
  },
];
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------

const AGENT_SHAPE: Record<string, string> = {
  AETHERFY_VCPUS: '2',
  AETHERFY_MEMORY_MB: '1024',
  AETHERFY_REGION: 'us-east-1',
};
let logSpy: jest.SpyInstance;

beforeEach(() => {
  Object.assign(process.env, AGENT_SHAPE);
  // fanOut announces its width on stdout; keep the test output clean.
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  for (const name of Object.keys(AGENT_SHAPE)) delete process.env[name];
});

/** Run the call to completion: await a promise, drain an async iterator. */
async function complete(result: unknown): Promise<void> {
  const value = await result;
  if (value && typeof value === 'object' && Symbol.asyncIterator in value) {
    for await (const _ of value as AsyncIterable<unknown>) {
      // drain
    }
  }
}

/** The error the call raised, synchronously or as a rejection. */
async function refusal(call: () => unknown, sync: boolean): Promise<TypeError> {
  if (sync) {
    try {
      call();
    } catch (error) {
      return error as TypeError;
    }
    throw new Error('expected a synchronous throw, the call returned');
  }
  let returned: unknown;
  try {
    returned = call();
  } catch (error) {
    throw new Error(
      `expected a rejection, got a synchronous throw: ${String(error)}`
    );
  }
  try {
    await complete(returned);
  } catch (error) {
    return error as TypeError;
  }
  throw new Error('expected a rejection, the call completed');
}

const UNKNOWN = 'noSuchOption';

describe.each(ENTRY_POINTS.map(e => [e.label, e] as const))(
  '%s',
  (label, entry) => {
    it('accepts every key its type declares', async () => {
      const keys = declaredKeys(entry.where);
      const options: Options = Object.fromEntries(
        keys.map(k => [k, entry.required?.[k]])
      );
      const { call, touched } = entry.setup();

      await expect(complete(call(options))).resolves.toBeUndefined();
      // It did the work, rather than returning early: a call that
      // short-circuited would pass the line above over nothing.
      if (touched() !== null) expect(touched()).toBeGreaterThan(0);
    });

    it.each([
      ['a value', 1],
      ['undefined', undefined],
    ])(
      'refuses an unknown key carrying %s, naming key and method, before any work',
      async (_what, value) => {
        const { call, touched } = entry.setup();
        const error = await refusal(
          () => call({ ...entry.required, [UNKNOWN]: value }),
          entry.sync === true
        );

        expect(error).toBeInstanceOf(TypeError);
        expect(
          error.message.startsWith(`${label}: unknown option(s): ${UNKNOWN}.`)
        ).toBe(true);
        expect(touched() ?? 0).toBe(0);
      }
    );

    it("lists exactly the type's keys as accepted", async () => {
      const { call } = entry.setup();
      const error = await refusal(
        () => call({ ...entry.required, [UNKNOWN]: 1 }),
        entry.sync === true
      );
      const accepted = /Accepted: ([^.]*)\./.exec(error.message);

      expect(accepted).not.toBeNull();
      expect(accepted![1].split(', ').sort()).toEqual(
        declaredKeys(entry.where).sort()
      );
    });
  }
);

describe('the enumeration (anti-no-op)', () => {
  it('reads a non-empty key set for every entry point', () => {
    for (const entry of ENTRY_POINTS) {
      expect({
        label: entry.label,
        n: declaredKeys(entry.where).length > 0,
      }).toEqual({ label: entry.label, n: true });
    }
  });

  it("the case that started it: ClientConfig's pre-rename `region`", () => {
    expect(
      () =>
        new AetherfyVectorsClient({
          apiKey: API_KEY,
          region: 'eu-central-1',
        } as unknown as ConstructorParameters<typeof AetherfyVectorsClient>[0])
    ).toThrow(
      new TypeError(
        'AetherfyVectorsClient constructor: unknown option(s): region. ' +
          'Accepted: apiKey, endpoint, timeout, enableConnectionPooling, ' +
          'workspace, apiRegion.'
      )
    );
  });

  it('create() refuses before region discovery, not after it', async () => {
    // With apiRegion set and no endpoint, create() would GET /regions first.
    // Net connect is disabled in this lane, so a refusal that came after the
    // request would be a discovery error, not this TypeError.
    await expect(
      AetherfyVectorsClient.create({
        apiKey: API_KEY,
        apiRegion: 'eu-central-1',
        region: 'eu-central-1',
      } as unknown as Parameters<typeof AetherfyVectorsClient.create>[0])
    ).rejects.toThrow(
      /^AetherfyVectorsClient\.create: unknown option\(s\): region\./
    );
  });
});
