/**
 * Guards README.md against the live source of THIS package.
 *
 * Why this exists: until the 2026-08-18 hygiene sweep, nothing had ever read
 * this file. Its error-handling sample printed `error.details` on a
 * SchemaValidationError — the property is `errors` — so the sample logged
 * `undefined` at exactly the moment a reader needed the violations. A wrong
 * return type and a region count contradicted by the same page shipped with it.
 *
 * The README is the npm page the moment this package is published, so it is a
 * released artifact with no test. It has one now.
 *
 * DESIGN, and why it is not the docs-site guard:
 *   - docs-site's code-block guard runs in dashboard CI, which never checks out
 *     this repository; it validates against a COMMITTED SNAPSHOT for that
 *     reason. Here the source is in the same tree, so this reads the live
 *     classes and the live type declarations. Nothing to go stale.
 *   - Static only. Samples are parsed with the TypeScript compiler's own
 *     parser; nothing is executed and nothing touches the network.
 *
 * SCOPE, stated honestly:
 *   - Receivers are tracked by declaration (`new AetherfyVectorsClient(...)`,
 *     `await memory.namespace(...)`, `AetherfyVectorsClient.create(...)`) and
 *     bindings persist across fences in document order, the way a reader
 *     following the page accumulates them. Calls on untracked names are
 *     skipped, not guessed at.
 *   - Option-object keys are checked for the methods whose options interface is
 *     named in OPTIONS_INTERFACE below. That is a mapping, not inference: TS
 *     option bags are structural and resolving them properly means a full type
 *     check, which is more machinery than this earns. Extend the map when a
 *     method grows an options bag.
 *   - NOT COVERED, and worth knowing because it is the defect that started all
 *     this: property reads on a caught error. The old sample logged
 *     `error.details` for a SchemaValidationError. `details` is declared on the
 *     base class as an optional, so it TYPE-CHECKS — but SchemaValidationError's
 *     constructor calls `super(message)` alone and neither construction site
 *     passes details, so it is always `undefined` and the violations live in
 *     `errors`. Catching that needs "is this ever populated for this subclass",
 *     which is dataflow, not typing: a full `tsc` would have passed it too.
 *     Reviewers still own that class of bug.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

import * as sdk from '../../src/index';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const README_PATH = path.join(REPO_ROOT, 'README.md');

const readme = (): string =>
  fs.readFileSync(README_PATH, 'utf8').replace(/\r\n/g, '\n');

const FENCE_RE = /^```(\w+)\n([\s\S]*?)^```/gm;

/** Every ```typescript / ```javascript block, in document order. */
function codeFences(markdown: string): string[] {
  const out: string[] = [];
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(markdown)) !== null) {
    if (m[1] === 'typescript' || m[1] === 'javascript' || m[1] === 'ts') {
      out.push(m[2]);
    }
  }
  return out;
}

/** Prose only — a claim is prose; `avgLatencyMs` in a sample is not. */
function proseOnly(markdown: string): string {
  return markdown.replace(FENCE_RE, '');
}

// --- the live surface -------------------------------------------------------

/** Type-only names cannot be seen at runtime; read them out of the sources. */
function declaredTypeNames(): Set<string> {
  const names = new Set<string>();
  const walkDir = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkDir(full);
      else if (entry.name.endsWith('.ts')) {
        const src = ts.createSourceFile(
          full,
          fs.readFileSync(full, 'utf8'),
          ts.ScriptTarget.Latest,
          true
        );
        src.forEachChild(node => {
          if (
            (ts.isInterfaceDeclaration(node) ||
              ts.isTypeAliasDeclaration(node) ||
              ts.isEnumDeclaration(node) ||
              ts.isClassDeclaration(node)) &&
            node.name
          ) {
            names.add(node.name.text);
          }
        });
      }
    }
  };
  walkDir(path.join(REPO_ROOT, 'src'));
  return names;
}

/** Members of a named interface, from the live sources. */
function interfaceMembers(name: string): Set<string> | null {
  const found = new Set<string>();
  let seen = false;
  const walkDir = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkDir(full);
      else if (entry.name.endsWith('.ts')) {
        const src = ts.createSourceFile(
          full,
          fs.readFileSync(full, 'utf8'),
          ts.ScriptTarget.Latest,
          true
        );
        src.forEachChild(node => {
          if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
            seen = true;
            for (const member of node.members) {
              if (member.name && ts.isIdentifier(member.name)) {
                found.add(member.name.text);
              }
            }
          }
        });
      }
    }
  };
  walkDir(path.join(REPO_ROOT, 'src'));
  return seen ? found : null;
}

/** Constructors a sample may bind a receiver from. */
const RECEIVER_CLASSES: Record<string, any> = {
  AetherfyVectorsClient: (sdk as any).AetherfyVectorsClient,
  MemoryClient: (sdk as any).MemoryClient,
  Namespace: (sdk as any).Namespace,
  Thread: (sdk as any).Thread,
};

/** MemoryClient factories that hand back another tracked class. */
const FACTORY_RETURNS: Record<string, string> = {
  namespace: 'Namespace',
  createNamespace: 'Namespace',
  thread: 'Thread',
  createThread: 'Thread',
};

/** method -> the interface its options bag must satisfy. A map, not inference. */
const OPTIONS_INTERFACE: Record<string, { argIndex: number; iface: string }> = {
  search: { argIndex: 2, iface: 'SearchOptions' },
  retrieve: { argIndex: 2, iface: 'RetrieveOptions' },
  count: { argIndex: 1, iface: 'CountOptions' },
  scrollIter: { argIndex: 1, iface: 'ScrollIterOptions' },
  // Added because the skip counter reported them: they had interfaces all
  // along and were going unchecked purely because nothing listed them. That is
  // exactly the coverage rot the counter exists to expose.
  iter: { argIndex: 0, iface: 'NamespaceIterOptions' },
  iterHistory: { argIndex: 0, iface: 'ThreadHistoryOptions' },
  history: { argIndex: 0, iface: 'ThreadHistoryOptions' },
  createCollection: { argIndex: 1, iface: 'VectorConfig' },
  // `delete(name, selector)` takes point ids OR a filter; when a sample writes
  // the filter inline, its clauses are checkable — and this is where a
  // snake_case `must_not` in a sample would be caught.
  delete: { argIndex: 1, iface: 'Filter' },
};

/**
 * `[0.1, 0.2, ...]` is a human ellipsis meaning "and so on" — a documentation
 * convention, and a TypeScript syntax error. Python's `...` is real syntax, so
 * the PY guard never met this; here it would fail three correct samples and
 * push the README toward worse prose to satisfy a parser.
 *
 * A BARE ellipsis (one followed by `,` `]` or `}`) is dropped. A spread —
 * `{ ...current, reviewed: true }` — is real syntax the README uses and is left
 * exactly alone. Trailing commas that result are legal in both literals.
 */
export function normalizeEllipsis(code: string): string {
  return code.replace(/\.\.\.(?=\s*[,\]}])/g, '');
}

/**
 * Type-level truth of one sample. `bindings` is mutated so later fences see
 * receivers declared in earlier ones.
 */
/** What the checker looked at, and what it declined to look at. */
export interface CheckStats {
  checkedOptionBags: number;
  /** `Class.method#argIndex` for every options bag NOT checked. */
  skippedOptionBags: string[];
}

export function emptyStats(): CheckStats {
  return { checkedOptionBags: 0, skippedOptionBags: [] };
}

export function checkSample(
  code: string,
  bindings: Map<string, string>,
  typeNames: Set<string>,
  stats: CheckStats = emptyStats()
): string[] {
  const problems: string[] = [];
  const src = ts.createSourceFile(
    'sample.ts',
    normalizeEllipsis(code),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  // A sample that cannot parse cannot be copied.
  const diagnostics = (src as any).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const d = diagnostics[0];
    problems.push(
      `sample does not parse: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`
    );
    return problems;
  }

  const classOfExpression = (expr: ts.Expression): string | null => {
    // new Foo(...)
    if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression)) {
      return expr.expression.text in RECEIVER_CLASSES
        ? expr.expression.text
        : null;
    }
    if (ts.isAwaitExpression(expr)) return classOfExpression(expr.expression);
    if (ts.isCallExpression(expr)) {
      const fn = expr.expression;
      // AetherfyVectorsClient.create(...)
      if (
        ts.isPropertyAccessExpression(fn) &&
        ts.isIdentifier(fn.expression) &&
        fn.expression.text in RECEIVER_CLASSES &&
        fn.name.text === 'create'
      ) {
        return fn.expression.text;
      }
      // memory.namespace(...) / memory.thread(...)
      if (ts.isPropertyAccessExpression(fn) && ts.isIdentifier(fn.expression)) {
        const owner = bindings.get(fn.expression.text);
        if (owner === 'MemoryClient' && FACTORY_RETURNS[fn.name.text]) {
          return FACTORY_RETURNS[fn.name.text];
        }
      }
    }
    return null;
  };

  const visit = (node: ts.Node): void => {
    // ---- imports ----
    if (ts.isImportDeclaration(node)) {
      const spec = (node.moduleSpecifier as ts.StringLiteral).text;
      if (spec === 'aetherfy-vectors') {
        const clause = node.importClause;
        const named = clause?.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) {
            const name = el.name.text;
            const isTypeOnly = clause!.isTypeOnly || el.isTypeOnly;
            const existsAtRuntime = name in (sdk as any);
            const existsAsType = typeNames.has(name);
            if (
              isTypeOnly ? !existsAsType : !existsAtRuntime && !existsAsType
            ) {
              problems.push(
                `\`import { ${name} } from 'aetherfy-vectors'\` — not exported ` +
                  `by src/index.ts${isTypeOnly ? ' as a type' : ''}`
              );
            }
          }
        }
      }
    }

    // ---- receiver bindings ----
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.name)
    ) {
      const cls = classOfExpression(node.initializer);
      if (cls) bindings.set(node.name.text, cls);
      else if (ts.isNewExpression(node.initializer))
        bindings.delete(node.name.text);
    }

    // ---- method existence + option keys ----
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const recv = node.expression.expression;
      if (ts.isIdentifier(recv)) {
        const clsName = bindings.get(recv.text);
        if (clsName) {
          const cls = RECEIVER_CLASSES[clsName];
          const method = node.expression.name.text;
          const onPrototype =
            cls && typeof cls.prototype?.[method] === 'function';
          const onStatic = cls && typeof cls[method] === 'function';
          if (!onPrototype && !onStatic) {
            problems.push(
              `\`${recv.text}.${method}(...)\` — ${clsName} has no method ${method}`
            );
          } else {
            // Every object literal handed to a tracked receiver is either
            // CHECKED against a mapped options interface or COUNTED as a skip.
            // Silence is not allowed: without the counter, adding a method with
            // an options bag — or moving one to a different argument position —
            // quietly shrinks coverage while the suite stays green.
            const spec = OPTIONS_INTERFACE[method];
            node.arguments.forEach((arg, argIndex) => {
              if (!ts.isObjectLiteralExpression(arg)) return;
              const allowed =
                spec && spec.argIndex === argIndex
                  ? interfaceMembers(spec.iface)
                  : null;
              if (!allowed) {
                stats.skippedOptionBags.push(
                  `${clsName}.${method}#${argIndex}`
                );
                return;
              }
              stats.checkedOptionBags++;
              for (const prop of arg.properties) {
                if (prop.name && ts.isIdentifier(prop.name)) {
                  if (!allowed.has(prop.name.text)) {
                    problems.push(
                      `\`${recv.text}.${method}({ ${prop.name.text}: ... })\` — ` +
                        `no such option on ${spec!.iface}. Accepted: ` +
                        `${[...allowed].join(', ')}`
                    );
                  }
                }
              }
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(src, visit);
  return problems;
}

// ---------------------------------------------------------------------------

/**
 * Object literals the checker deliberately does NOT validate, pinned so
 * coverage cannot shrink in silence.
 *
 * All four are USER DATA, not option bags: a payload and a metadata partial
 * have free-form keys by definition, so there is no interface to check them
 * against and a check would be wrong, not merely absent.
 *
 * Everything else that used to sit in this list had an interface all along and
 * was unchecked only because nothing listed it — `Namespace.iter`,
 * `Thread.iterHistory`, `createCollection`'s vector config and `delete`'s
 * filter are now mapped in OPTIONS_INTERFACE and checked. The counter is what
 * surfaced them; that is the point of counting skips rather than ignoring them.
 *
 * Compared as a deduplicated set: the unit that matters is the KIND of skip,
 * not how many times the README happens to repeat it.
 */
const EXPECTED_SKIPS: string[] = [
  'AetherfyVectorsClient.overwritePayload#1', // free-form payload object
  'AetherfyVectorsClient.setPayload#1', // free-form payload object
  'Namespace.mergeMetadata#1', // free-form metadata partial
  'Namespace.setMetadata#1', // free-form metadata partial
];

describe('README code samples', () => {
  const typeNames = declaredTypeNames();

  it('match the live API', () => {
    const samples = codeFences(readme());

    // Anti-no-op: an extractor that stops matching is RED, not silent.
    expect(samples.length).toBeGreaterThanOrEqual(15);

    const bindings = new Map<string, string>();
    const stats = emptyStats();
    const problems: string[] = [];
    samples.forEach((sample, i) => {
      for (const p of checkSample(sample, bindings, typeNames, stats)) {
        problems.push(`README.md fence #${i + 1}: ${p}`);
      }
    });

    expect(problems).toEqual([]);

    // NO SILENT SKIPS. Every options bag is either checked against a mapped
    // interface or listed here. The pin is the point: add a method with an
    // options bag, or move one to a different argument position, and this reds
    // instead of coverage quietly shrinking. To resolve a red, either add the
    // method to OPTIONS_INTERFACE (preferred — it becomes checked) or move the
    // entry into EXPECTED_SKIPS deliberately, with a reason.
    expect([...new Set(stats.skippedOptionBags)].sort()).toEqual(
      EXPECTED_SKIPS
    );
    expect(stats.checkedOptionBags).toBeGreaterThanOrEqual(4);

    // The scan means nothing if it never resolved a receiver.
    expect(bindings.get('client')).toBe('AetherfyVectorsClient');
    expect(bindings.get('ns')).toBe('Namespace');
  });

  it('checker actually fires (negative control)', () => {
    const cases: Array<[string, string]> = [
      [
        `import { AetherfyVectorsClient } from 'aetherfy-vectors';
         const client = new AetherfyVectorsClient({ apiKey: 'k' });
         await client.noSuchMethod();`,
        'has no method',
      ],
      [`import { NoSuchExport } from 'aetherfy-vectors';`, 'not exported'],
      [
        `import { AetherfyVectorsClient } from 'aetherfy-vectors';
         const client = new AetherfyVectorsClient({ apiKey: 'k' });
         await client.search('c', v, { hnswEf: 256 });`,
        'no such option',
      ],
    ];
    for (const [code, expected] of cases) {
      const found = checkSample(code, new Map(), typeNames);
      expect(found.join('\n')).toContain(expected);
    }

    // ...and stays quiet on the corrected forms, or it is useless noise.
    const ok = checkSample(
      `import { AetherfyVectorsClient } from 'aetherfy-vectors';
       const client = new AetherfyVectorsClient({ apiKey: 'k' });
       await client.search('c', v, { searchParams: { hnsw_ef: 256 }, limit: 5 });`,
      new Map(),
      typeNames
    );
    expect(ok).toEqual([]);
  });

  it('normalizes the human ellipsis without eating real spread syntax', () => {
    // Docs convention: dropped so the rest of the sample can be checked.
    expect(normalizeEllipsis('vector: [0.1, 0.2, ...],')).toBe(
      'vector: [0.1, 0.2, ],'
    );
    expect(normalizeEllipsis('const big = [...];')).toBe('const big = [];');
    expect(normalizeEllipsis('payload: { category: 1, metadata: {...} }')).toBe(
      'payload: { category: 1, metadata: {} }'
    );
    // Real syntax the README relies on: untouched.
    expect(
      normalizeEllipsis(
        'await ns.setMetadata(id, { ...current, reviewed: true });'
      )
    ).toBe('await ns.setMetadata(id, { ...current, reviewed: true });');
    // ...and a genuinely broken sample is still reported, not normalized away.
    const broken = checkSample(
      `const client = new AetherfyVectorsClient({ apiKey: 'k'`,
      new Map(),
      typeNames
    );
    expect(broken.join('\n')).toContain('does not parse');
  });

  it('type-only imports are resolved as types, not runtime exports', () => {
    // ScrollIterOptions is an interface: absent at runtime, present in source.
    expect((sdk as any).ScrollIterOptions).toBeUndefined();
    expect(typeNames.has('ScrollIterOptions')).toBe(true);
    const problems = checkSample(
      `import type { ScrollIterOptions } from 'aetherfy-vectors';`,
      new Map(),
      typeNames
    );
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

const GITHUB_OWNER = 'l-td';

const DOCS_ROUTES_FILE = path.join(REPO_ROOT, '.github', 'docs-routes.txt');

/**
 * The one list of documented routes, shared with the liveness workflow.
 *
 * Deliberately not a literal here. This guard can only check that a URL is in
 * the list; whether the list still RESOLVES is checked for real by
 * .github/workflows/docs-links.yml on a weekly schedule. Two copies would let
 * those answers disagree, which is the shape of the bug this batch exists to
 * kill.
 */
function knownDocsRoutes(): Set<string> {
  return new Set(
    fs
      .readFileSync(DOCS_ROUTES_FILE, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l !== '' && !l.startsWith('#'))
  );
}

describe('README links', () => {
  it('every github.com URL names a repository we own', () => {
    // Not "this repo only": the README cross-links the sibling Python SDK under
    // Related Projects, which is legitimate and which the first version of this
    // guard wrongly failed. The rule is the one that mattered — the `aetherfy`
    // org does not exist, so every URL must sit under an owner account and name
    // a repository that does.
    const OWNED = [
      `${GITHUB_OWNER}/aetherfy-vectors-js-sdk`,
      `${GITHUB_OWNER}/aetherfy-vectors-python-sdk`,
      `${GITHUB_OWNER}/aetherfy-cli`,
    ];
    const surfaces: Record<string, string> = {
      'README.md': readme(),
      'package.json': fs.readFileSync(
        path.join(REPO_ROOT, 'package.json'),
        'utf8'
      ),
    };
    const bad: string[] = [];
    let found = 0;
    for (const [where, text] of Object.entries(surfaces)) {
      for (const url of text.match(
        /https:\/\/github\.com\/[A-Za-z0-9_.\-/]+/g
      ) ?? []) {
        found++;
        // A clone URL carries a `.git` suffix; the repo is the same repo.
        const repo = url
          .replace('https://github.com/', '')
          .split('/')
          .slice(0, 2)
          .join('/')
          .replace(/\.git$/, '');
        if (!OWNED.includes(repo)) {
          bad.push(
            `${where}: ${url} — ${repo} is not a repository we own. Owned: ${OWNED.join(', ')}`
          );
        }
      }
    }
    expect(bad).toEqual([]);
    // Boundary check: a regex that stops matching must not pass silently.
    expect(found).toBeGreaterThanOrEqual(2);
  });

  it('every docs.aetherfy.com path is a known route', () => {
    const routes = knownDocsRoutes();
    // The loader must actually load, or every check below passes vacuously.
    expect(routes.size).toBeGreaterThanOrEqual(5);

    const unknown: string[] = [];
    let found = 0;
    for (const url of readme().match(
      /https:\/\/docs\.aetherfy\.com[A-Za-z0-9_.\-/]*/g
    ) ?? []) {
      found++;
      if (!routes.has(url.replace(/\/$/, ''))) {
        unknown.push(
          `${url} is not in .github/docs-routes.txt — add it there only after ` +
            `confirming it resolves; docs.aetherfy.com/api was invented and 404'd`
        );
      }
    }
    expect(unknown).toEqual([]);
    expect(found).toBeGreaterThanOrEqual(2);
  });

  it('the liveness workflow still guards these routes', () => {
    // This guard cannot see a docs-site restructure; that scheduled job can.
    // A check nothing references can be deleted without any red, so the
    // offline guard asserts the online one exists and reads the same list.
    const workflow = path.join(
      REPO_ROOT,
      '.github',
      'workflows',
      'docs-links.yml'
    );
    expect(fs.existsSync(workflow)).toBe(true);
    const body = fs.readFileSync(workflow, 'utf8');
    expect(body).toContain('.github/docs-routes.txt');
    expect(body).toContain('schedule:');
  });

  it('CI actually runs this guard on README changes', () => {
    // A path-filtered workflow can switch this whole file off, silently.
    // Found by audit: .github/workflows/ci.yml filtered on src/**, tests/**,
    // package.json, tsconfig.json, jest.config.js — and NOT on README.md. A
    // commit touching only the README triggered no workflow at all, so the
    // guard never ran on the exact change it exists to police. It would still
    // have caught a README made stale by a CODE change, which is why nothing
    // looked broken. A missing path filter fails GREEN: no run, no red, no
    // signal. So the trigger is asserted here, where a red is visible.
    const workflow = fs.readFileSync(
      path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'),
      'utf8'
    );
    const blocks = workflow.split("- 'README.md'").length - 1;
    expect(blocks).toBeGreaterThanOrEqual(2);
  });

  it('leaves the install lines alone', () => {
    // The registry is an owner gate, not an error. Do not hedge npm install.
    expect(readme()).toContain('npm install aetherfy-vectors');
  });
});

// ---------------------------------------------------------------------------

// Owner ruling (2026-08-18): performance claims stay QUALITATIVE. A number with
// a performance unit is a promise nothing in this repo measures — and an SLA
// figure is a contractual one.
const PERF_CLAIMS: Array<[RegExp, string]> = [
  [/sub-\s*\d+\s*ms/i, "a 'sub-Nms' latency promise"],
  [/\b\d+(?:\.\d+)?\s*ms\b/i, 'a latency figure in ms'],
  [
    /\b[\d,]+\+?\s*(?:QPS|queries per second|requests per second)/i,
    'a throughput figure',
  ],
  [
    /\b\d+(?:\.\d+)?\s*%\+?\s*(?:cache|hit rate|uptime|availability|SLA)/i,
    'a cache/uptime percentage',
  ],
  [
    /(?:cache hit rate|uptime|availability|SLA)[^.\n]{0,24}?\b\d+(?:\.\d+)?\s*%/i,
    'a cache/uptime percentage',
  ],
];

describe('README performance claims', () => {
  it('states no numeric performance claims in prose', () => {
    const hits: string[] = [];
    proseOnly(readme())
      .split('\n')
      .forEach((line, i) => {
        for (const [pattern, why] of PERF_CLAIMS) {
          const m = pattern.exec(line);
          if (m) hits.push(`line ${i + 1}: ${JSON.stringify(m[0])} — ${why}`);
        }
      });
    expect(hits).toEqual([]);
  });

  it('the tripwire fires, and does not fire on ordinary numbers', () => {
    for (const bad of [
      'sub-50ms latency worldwide',
      'Average latency: 12 ms',
      '100,000+ queries per second',
      '94%+ cache hit rate',
      'Availability: 99.9% SLA',
    ]) {
      expect(PERF_CLAIMS.some(([p]) => p.test(bad))).toBe(true);
    }
    for (const fine of [
      'Requires Node.js **>= 20**',
      'up to **512 points** in one round trip',
      '1000 points/call, 10 MB/response',
      'size: 384, // Vector dimensions',
      'timeout: 45000, // Custom timeout in milliseconds',
    ]) {
      expect(PERF_CLAIMS.some(([p]) => p.test(fine))).toBe(false);
    }
  });
});
