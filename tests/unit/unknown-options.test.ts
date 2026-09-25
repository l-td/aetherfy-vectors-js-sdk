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
 * COVERAGE IS DERIVED, not trusted: `optionsParameters()` walks the same
 * program's package exports (src/index.ts, src/agent/index.ts) and lists every
 * public constructor, method and function parameter whose type is an options
 * object. That set must EQUAL the ids of ENTRY_POINTS, so a new method taking
 * an options object reds here, by name, until it has a row, and the row's
 * cases then red until it has the guard. ENTRY_POINTS stays hand-written only
 * for what the compiler cannot supply: how to call each one, and what a
 * completed call needs.
 */

import { join } from 'node:path';
import * as ts from 'typescript';

import { AetherfyVectorsClient } from '../../src/client';
import { HttpClient } from '../../src/http/client';
import { createClient } from '../../src/index';
import { retryWithBackoff } from '../../src/utils';
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

/**
 * Every options-object parameter of the package's public API, as
 * `<ExportedName>.<member>#<param>` or `<function>()#<param>`.
 *
 * An OPTIONS OBJECT is a parameter whose type (or, for an array, whose element
 * type) is an object type declared in src/ with named properties, no index
 * signature, no call or construct signature, and is not a class instance.
 * That rule leaves out, with no list: payloads and metadata
 * (`Record<string, unknown>`, an index signature), id and point arrays,
 * unions such as `delete`'s selector and `createCollection`'s vector config,
 * a client passed to a scope, and lib types (`Iterable`, `Error`).
 *
 * Two exclusions the rule cannot express:
 *   - ERROR CLASSES: a class extending Error is built by the SDK itself, and
 *     its constructor's options carry what the SDK read off a response, so
 *     they are not caller input. Detected structurally (the base chain reaches
 *     `Error`), not listed.
 *   - DATA_TYPES: a fixed-shape object that is a document, not options. A type
 *     cannot say which it is, so these are named. Today only `Schema`
 *     (setSchema, validatePayload, validateVectors), whose keys belong to the
 *     caller's payload model.
 */
const DATA_TYPES = new Set(['Schema']);

function optionsParameters(): string[] {
  const inSrc = (d: ts.Node | undefined): boolean =>
    !!d && d.getSourceFile().fileName.replace(/\\/g, '/').includes('/src/');
  const isPublic = (d: ts.Declaration): boolean =>
    !(
      ts.getCombinedModifierFlags(d) &
      (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)
    ) &&
    !(
      (ts.isMethodDeclaration(d) || ts.isPropertyDeclaration(d)) &&
      ts.isPrivateIdentifier(d.name)
    );
  const isShape = (t: ts.Type): boolean => {
    const symbol = t.aliasSymbol ?? t.getSymbol();
    return (
      !!(t.flags & ts.TypeFlags.Object) &&
      !t.isUnion() &&
      !t.getStringIndexType() &&
      !t.getNumberIndexType() &&
      t.getCallSignatures().length === 0 &&
      t.getConstructSignatures().length === 0 &&
      checker.getPropertiesOfType(t).length > 0 &&
      !!symbol &&
      !(symbol.flags & ts.SymbolFlags.Class) &&
      !DATA_TYPES.has(symbol.name) &&
      (symbol.declarations ?? []).some(inSrc)
    );
  };
  const extendsError = (t: ts.Type): boolean =>
    (t.getBaseTypes() ?? []).some(
      b => b.getSymbol()?.name === 'Error' || extendsError(b)
    );

  const found = new Set<string>();
  const scan = (id: string, signature: ts.Signature): void =>
    signature.getParameters().forEach((p, i) => {
      const decl = p.valueDeclaration;
      if (!decl) throw new Error(`${id}: parameter ${i} has no declaration`);
      const t = checker.getNonNullableType(
        checker.getTypeOfSymbolAtLocation(p, decl)
      );
      const element = checker.isArrayType(t)
        ? checker.getTypeArguments(t as ts.TypeReference)[0]
        : undefined;
      if (isShape(t) || (element && isShape(element))) found.add(`${id}#${i}`);
    });

  // One name per symbol: the default export is AetherfyVectorsClient again.
  const named = new Map<ts.Symbol, string>();
  for (const entry of ['index.ts', join('agent', 'index.ts')]) {
    const file = program.getSourceFile(join(SRC, entry));
    const module = file && checker.getSymbolAtLocation(file);
    if (!module) throw new Error(`no module symbol for src/${entry}`);
    for (const exported of checker.getExportsOfModule(module)) {
      const symbol =
        exported.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exported)
          : exported;
      if (exported.name === 'default' && named.has(symbol)) continue;
      if (!named.has(symbol) || named.get(symbol) === 'default') {
        named.set(symbol, exported.name);
      }
    }
  }

  for (const [symbol, name] of named) {
    const decl = symbol.valueDeclaration;
    if (!decl || !inSrc(decl)) continue;
    const staticType = checker.getTypeOfSymbolAtLocation(symbol, decl);
    if (symbol.flags & ts.SymbolFlags.Class) {
      const instance = checker.getDeclaredTypeOfSymbol(symbol);
      if (extendsError(instance)) continue;
      staticType
        .getConstructSignatures()
        .forEach(sig => scan(`${name}.constructor`, sig));
      // The constructor's type carries the statics, the instance type the
      // methods, inherited ones included (Scope's, on Namespace and Thread).
      for (const owner of [staticType, instance]) {
        for (const member of checker.getPropertiesOfType(owner)) {
          const d = member.valueDeclaration;
          if (!(member.flags & ts.SymbolFlags.Method) || !d || !inSrc(d)) {
            continue;
          }
          if (!isPublic(d)) continue;
          checker
            .getTypeOfSymbolAtLocation(member, d)
            .getCallSignatures()
            .forEach(sig => scan(`${name}.${member.name}`, sig));
        }
      }
    } else if (symbol.flags & ts.SymbolFlags.Function) {
      staticType.getCallSignatures().forEach(sig => scan(`${name}()`, sig));
    }
  }
  return [...found].sort();
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
  /**
   * `<ExportedName>.<member>#<param>` (`<name>()#<param>` for a function):
   * the key the derived coverage check below matches this row by.
   */
  id: string;
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
    id: 'AetherfyVectorsClient.constructor#0',
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
    id: 'AetherfyVectorsClient.create#0',
    label: 'AetherfyVectorsClient.create',
    where: { owner: 'AetherfyVectorsClient', member: 'create', param: 0 },
    required: { apiKey: API_KEY },
    setup: () => ({
      call: options => AetherfyVectorsClient.create(options as any),
      touched: () => null,
    }),
  },
  {
    id: 'AetherfyVectorsClient.setPayload#3',
    label: 'setPayload',
    where: { owner: 'AetherfyVectorsClient', member: 'setPayload', param: 3 },
    setup: onVectors((c, o) => c.setPayload('col', { a: 1 }, [1], o as any)),
  },
  {
    id: 'AetherfyVectorsClient.retrieve#2',
    label: 'retrieve',
    where: { owner: 'AetherfyVectorsClient', member: 'retrieve', param: 2 },
    setup: onVectors((c, o) => c.retrieve('col', [1], o as any)),
  },
  {
    id: 'AetherfyVectorsClient.search#2',
    label: 'search',
    where: { owner: 'AetherfyVectorsClient', member: 'search', param: 2 },
    setup: onVectors((c, o) => c.search('col', VECTOR, o as any)),
  },
  {
    id: 'AetherfyVectorsClient.scroll#1',
    label: 'scroll',
    where: { owner: 'AetherfyVectorsClient', member: 'scroll', param: 1 },
    setup: onVectors((c, o) => c.scroll('col', o as any)),
  },
  {
    id: 'AetherfyVectorsClient.scrollIter#1',
    label: 'scrollIter',
    where: { owner: 'AetherfyVectorsClient', member: 'scrollIter', param: 1 },
    sync: true,
    setup: onVectors((c, o) => c.scrollIter('col', o as any)),
  },
  {
    id: 'AetherfyVectorsClient.count#1',
    label: 'count',
    where: { owner: 'AetherfyVectorsClient', member: 'count', param: 1 },
    setup: onVectors((c, o) => c.count('col', o as any)),
  },

  // --- MemoryClient (src/memory/client.ts) ---
  {
    id: 'MemoryClient.constructor#0',
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
    id: 'MemoryClient.createNamespace#1',
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
    id: 'Namespace.add#0',
    label: 'Namespace.add',
    where: { owner: 'Namespace', member: 'add', param: 0 },
    required: { vector: VECTOR },
    setup: onScope(namespace, (s, o) => s.add(o as any)),
  },
  {
    id: 'Namespace.addMany#0',
    label: 'Namespace.addMany[0]',
    where: { owner: 'Namespace', member: 'addMany', param: 0, element: true },
    required: { vector: VECTOR },
    setup: onScope(namespace, (s, o) => s.addMany([o as any])),
  },
  {
    id: 'Namespace.setSchema#1',
    label: 'Namespace.setSchema',
    where: { owner: 'Namespace', member: 'setSchema', param: 1 },
    setup: onScope(namespace, (s, o) => s.setSchema({ fields: {} }, o as any)),
  },
  {
    id: 'Namespace.search#1',
    label: 'Namespace.search',
    where: { owner: 'Scope', member: 'search', param: 1 },
    setup: onScope(namespace, (s, o) => s.search(VECTOR, o as any)),
  },
  {
    id: 'Namespace.retrieve#1',
    label: 'Namespace.retrieve',
    where: { owner: 'Scope', member: 'retrieve', param: 1 },
    setup: onScope(namespace, (s, o) => s.retrieve([1], o as any)),
  },
  {
    id: 'Namespace.count#0',
    label: 'Namespace.count',
    where: { owner: 'Scope', member: 'count', param: 0 },
    setup: onScope(namespace, (s, o) => s.count(o as any)),
  },
  {
    id: 'Namespace.iter#0',
    label: 'Namespace.iter',
    where: { owner: 'Scope', member: 'iter', param: 0 },
    sync: true,
    setup: onScope(namespace, (s, o) => s.iter(o as any)),
  },

  // --- Thread (src/memory/thread.ts + scope.ts) ---
  {
    id: 'Thread.add#0',
    label: 'Thread.add',
    where: { owner: 'Thread', member: 'add', param: 0 },
    required: { role: 'user', content: 'hi', vector: VECTOR },
    setup: onScope(thread, (s, o) => s.add(o as any)),
  },
  {
    id: 'Thread.appendMany#0',
    label: 'Thread.appendMany[0]',
    where: { owner: 'Thread', member: 'appendMany', param: 0, element: true },
    required: { role: 'user', content: 'hi', vector: VECTOR },
    setup: onScope(thread, (s, o) => s.appendMany([o as any])),
  },
  {
    id: 'Thread.history#0',
    label: 'Thread.history',
    where: { owner: 'Thread', member: 'history', param: 0 },
    setup: onScope(thread, (s, o) => s.history(o as any)),
  },
  {
    id: 'Thread.iterHistory#0',
    label: 'Thread.iterHistory',
    where: { owner: 'Thread', member: 'iterHistory', param: 0 },
    sync: true,
    setup: onScope(thread, (s, o) => s.iterHistory(o as any)),
  },
  {
    id: 'Thread.search#1',
    label: 'Thread.search',
    where: { owner: 'Scope', member: 'search', param: 1 },
    setup: onScope(thread, (s, o) => s.search(VECTOR, o as any)),
  },
  {
    id: 'Thread.retrieve#1',
    label: 'Thread.retrieve',
    where: { owner: 'Scope', member: 'retrieve', param: 1 },
    setup: onScope(thread, (s, o) => s.retrieve([1], o as any)),
  },
  {
    id: 'Thread.count#0',
    label: 'Thread.count',
    where: { owner: 'Scope', member: 'count', param: 0 },
    setup: onScope(thread, (s, o) => s.count(o as any)),
  },
  {
    id: 'Thread.iter#0',
    label: 'Thread.iter',
    where: { owner: 'Scope', member: 'iter', param: 0 },
    sync: true,
    setup: onScope(thread, (s, o) => s.iter(o as any)),
  },

  // --- root functions and the low-level transport ---
  {
    id: 'createClient()#0',
    label: 'AetherfyVectorsClient constructor',
    where: { owner: 'createClient', param: 0 },
    required: { apiKey: API_KEY },
    sync: true,
    setup: () => ({
      call: options => createClient(options as any),
      touched: () => null,
    }),
  },
  {
    id: 'retryWithBackoff()#1',
    label: 'retryWithBackoff',
    where: { owner: 'retryWithBackoff', param: 1 },
    setup: () => {
      const fn = jest.fn().mockResolvedValue('ok');
      return {
        call: options => retryWithBackoff(fn, options as any),
        touched: () => fn.mock.calls.length,
      };
    },
  },
  {
    id: 'HttpClient.constructor#0',
    label: 'HttpClient constructor',
    where: { owner: 'HttpClient', member: 'constructor', param: 0 },
    sync: true,
    setup: () => ({
      call: options => new HttpClient(options as any),
      touched: () => null,
    }),
  },
  {
    id: 'HttpClient.request#0',
    label: 'HttpClient.request',
    where: { owner: 'HttpClient', member: 'request', param: 0 },
    required: { url: 'http://127.0.0.1:9/x', method: 'GET' },
    setup: () => {
      const http = new HttpClient({ enableConnectionPooling: false });
      const axiosRequest = jest.fn().mockResolvedValue({
        data: {},
        status: 200,
        statusText: 'OK',
        headers: {},
      });
      (http as unknown as { axiosInstance: unknown }).axiosInstance = {
        request: axiosRequest,
      };
      return {
        call: options => http.request(options as any),
        touched: () => axiosRequest.mock.calls.length,
      };
    },
  },

  // --- agent helper (src/agent/index.ts) ---
  {
    id: 'fanOut()#2',
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
      const accepted = /Accepted: ([^.]*)\./.exec(error.message)?.[1];

      expect(accepted).toBeDefined();
      expect((accepted ?? '').split(', ').sort()).toEqual(
        declaredKeys(entry.where).sort()
      );
    });
  }
);

describe('the enumeration', () => {
  it('guards exactly the options parameters the package exports (derived)', () => {
    const derived = optionsParameters();
    const guarded = ENTRY_POINTS.map(e => e.id).sort();

    // Anti-no-op: a derivation that found nothing would agree with an empty
    // table. 30 is today's count; the equality below is the real check.
    expect(derived.length).toBeGreaterThanOrEqual(30);
    expect({
      notGuarded: derived.filter(id => !guarded.includes(id)),
      notDerived: guarded.filter(id => !derived.includes(id)),
    }).toEqual({ notGuarded: [], notDerived: [] });
  });

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
