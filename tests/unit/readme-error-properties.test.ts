/**
 * Guards the README's error-object promises against the classes that throw.
 *
 * WHY THIS EXISTS: the README tells integrators what a caught error carries —
 * `error.retryAfter`, `error.quotaType`, `error.errors`. Nothing tied those
 * claims to the classes. The README could document a property no constructor
 * ever assigns and every suite in this repository would stay green while the
 * reader's handler logged `undefined`. Publication makes the README the npm
 * page, so those claims become contractual; this is the check that says they
 * are true.
 *
 * It closes the hole readme-guard.test.ts names in its own header: "NOT
 * COVERED ... property reads on a caught error". It does not close all of it.
 * That file's example — `error.details` on a SchemaValidationError, declared on
 * the base as optional and never populated for that subclass — needs "is this
 * ever populated HERE", which is dataflow. This guard answers the weaker,
 * decidable question: does an assignment site exist at all?
 *
 * THE CHECK, narrow on purpose, and its edges stated honestly:
 *
 *   - A CLAIM is `if (e instanceof <OurError>)` inside a README fence, plus an
 *     `e.<prop>` read in that branch's body. That is the ONLY claim form
 *     parsed. Prose is deliberately not parsed: prose is ambiguous about whose
 *     property it names — the Limits section's "a structured `error.code`" is
 *     the SERVER envelope's key, not an attribute of any class here, and a
 *     parser that read it as one would red on a true sentence.
 *
 *   - An ASSIGNMENT SITE is a literal `this.<prop> = ...` in the class or one
 *     of its ancestors, or a TypeScript constructor PARAMETER PROPERTY
 *     (`constructor(public readonly namespaceName: string)`), which is the same
 *     assignment with the compiler writing it out. src/memory/errors.ts uses
 *     that spelling, so a check that only knew `this.x =` would report its
 *     properties as missing and be wrong.
 *
 *   - A DECLARATION IS NOT A SITE. `public code?: string;` on its own promises
 *     nothing; a declared-but-never-assigned property is exactly the bug shape
 *     this guard exists to catch, and TypeScript is happy with it.
 *
 *   - What this does NOT prove: that the assignment always runs. A site inside
 *     an `if` still counts as a site.
 *
 *   - A property assigned any other way is REPORTED, not guessed at. This repo
 *     has a live example: `AetherfyVectorsError.code` is stamped from OUTSIDE
 *     the class, by `createErrorFromResponse`'s `err.code = errorCode`, so it
 *     has no `this.code =` site. The README does not currently document
 *     `err.code`, so nothing reds today — but if it ever does, the fix is to
 *     assign `code` in the class, not to widen this check into a dataflow
 *     engine.
 *
 * WIRING: tests/unit/, so it runs in the same lane as every other README guard
 * — .github/workflows/ci.yml, whose path filters cover README.md, src/** and
 * tests/**.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const README_PATH = path.join(REPO_ROOT, 'README.md');

/**
 * The files that define this package's error classes. Deliberately an explicit
 * short list rather than a walk of src/: src/auth.ts exports an unrelated
 * `AuthenticationError extends Error`, and a walk would collide it with the SDK
 * error of the same name (index.ts re-exports it as `AuthError` for exactly
 * that reason). The "every documented class is in the table" test below is what
 * keeps this list honest if the errors ever move.
 */
const ERROR_SOURCES = ['src/exceptions.ts', 'src/memory/errors.ts'];

/**
 * Where the ancestor walk stops. The native Error constructor sets these with
 * no `this.x =` anywhere in this repository, so they are named explicitly
 * rather than left to read as MISSING.
 *
 * `cause` is deliberately NOT here: it is a native own property only when
 * something calls `new Error(msg, { cause })`, and nothing in this package
 * does. NetworkError declares and assigns its own `cause`, so a claim on it
 * must find that real site — listing `cause` as native would excuse a future
 * class that forgot to assign it.
 */
const NATIVE_ROOTS: Record<string, string[]> = {
  Error: ['message', 'name', 'stack'],
};

/**
 * The README documents seven error properties today. The floor is a tripwire
 * on the EXTRACTOR, not a cap on the README: parsing fewer than this means the
 * error-handling section moved, stopped using `instanceof`, or stopped being a
 * fenced sample, and a silent zero would read as "all claims hold".
 */
const MIN_CLAIMS = 7;

const FENCE_RE = /^```(\w+)\n([\s\S]*?)^```/gm;

const readme = (): string =>
  fs.readFileSync(README_PATH, 'utf8').replace(/\r\n/g, '\n');

/**
 * The error-class sources, keyed by repo-relative path. Text rather than
 * imported classes so the mutation proof can hand this back with one
 * assignment removed.
 */
function liveSources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of ERROR_SOURCES) {
    out.set(
      rel,
      fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
    );
  }
  return out;
}

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

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

// ---------------------------------------------------------------------------
// The assignment sites
// ---------------------------------------------------------------------------

interface ClassInfo {
  // No `name` field: the table is keyed by class name, and a second copy of it
  // here was written by buildClassTable and read by nothing.
  bases: string[];
  props: Map<string, string>; // property -> "path:line" of its assignment
  where: string;
}

/**
 * class name -> its base and its assignment sites.
 *
 * Assignments only. A property that is merely READ (`if (this.retryAfter)`) or
 * merely DECLARED (`public readonly x?: string;`) is not a site.
 */
export function buildClassTable(
  sources: Map<string, string>
): Map<string, ClassInfo> {
  const table = new Map<string, ClassInfo>();

  for (const [label, text] of sources) {
    const src = parse(label, text);
    const lineOf = (node: ts.Node): number =>
      src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1;

    const visitClass = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        const name = node.name.text;
        const props = new Map<string, string>();

        // `this.<prop> = ...`, anywhere in the class body. The walk stops at a
        // nested class: crediting an inner class's assignment to the outer one
        // would be a fail-GREEN, the only direction that matters here. Nested
        // classes are registered as their own entries by visitClass.
        const scan = (n: ts.Node): void => {
          if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) return;
          if (
            ts.isBinaryExpression(n) &&
            n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(n.left) &&
            n.left.expression.kind === ts.SyntaxKind.ThisKeyword
          ) {
            const prop = n.left.name.text;
            if (!props.has(prop)) props.set(prop, `${label}:${lineOf(n)}`);
          }
          ts.forEachChild(n, scan);
        };
        ts.forEachChild(node, scan);

        // Constructor parameter properties — the same assignment, written by
        // the compiler. src/memory/errors.ts is built entirely this way.
        for (const member of node.members) {
          if (!ts.isConstructorDeclaration(member)) continue;
          for (const param of member.parameters) {
            const isParamProperty = (param.modifiers ?? []).some(mod =>
              [
                ts.SyntaxKind.PublicKeyword,
                ts.SyntaxKind.PrivateKeyword,
                ts.SyntaxKind.ProtectedKeyword,
                ts.SyntaxKind.ReadonlyKeyword,
              ].includes(mod.kind)
            );
            if (!isParamProperty || !ts.isIdentifier(param.name)) continue;
            const prop = param.name.text;
            if (!props.has(prop)) props.set(prop, `${label}:${lineOf(param)}`);
          }
        }

        const bases: string[] = [];
        for (const clause of node.heritageClauses ?? []) {
          if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
          for (const type of clause.types) {
            if (ts.isIdentifier(type.expression)) {
              bases.push(type.expression.text);
            }
          }
        }

        const where = `${label}:${lineOf(node)}`;
        const existing = table.get(name);
        if (existing) {
          throw new Error(
            `two classes named ${name} in the scanned error sources ` +
              `(${existing.where} and ${where}). A claim about ${name} would be ` +
              `checked against whichever won, which is a coin toss, not a guard. ` +
              `Narrow ERROR_SOURCES or rename.`
          );
        }
        table.set(name, { bases, props, where });
      }
      ts.forEachChild(node, visitClass);
    };

    ts.forEachChild(src, visitClass);
  }

  return table;
}

interface Resolved {
  props: Map<string, string>;
  chainProblem: string | null;
}

/**
 * Every property visible on `className`, walking its ancestors.
 *
 * `chainProblem` is non-null when a base is neither a scanned class nor a known
 * native root. Saying MISSING off an incomplete chain would be a guess, so that
 * is reported as its own problem instead.
 */
export function inheritedProps(
  table: Map<string, ClassInfo>,
  className: string
): Resolved {
  const props = new Map<string, string>();
  let chainProblem: string | null = null;
  const seen = new Set<string>();
  const queue = [className];

  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);

    const native = NATIVE_ROOTS[name];
    if (native) {
      for (const prop of native) {
        if (!props.has(prop)) props.set(prop, `native ${name}`);
      }
      continue;
    }

    const info = table.get(name);
    if (!info) {
      chainProblem =
        `${className} extends ${name}, which is neither defined in ` +
        `${ERROR_SOURCES.join(' / ')} nor a known native base — the ancestor ` +
        `chain cannot be resolved, so this guard cannot say whether a property ` +
        `is assigned. Add the file to ERROR_SOURCES.`;
      continue;
    }
    for (const [prop, site] of info.props) {
      if (!props.has(prop)) props.set(prop, site);
    }
    queue.push(...info.bases);
  }

  return { props, chainProblem };
}

function chainOf(table: Map<string, ClassInfo>, className: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [className];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    const info = table.get(name);
    if (info) queue.push(...info.bases);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The claims
// ---------------------------------------------------------------------------

interface Claim {
  cls: string;
  prop: string;
  where: string;
}

/**
 * Every `instanceof <OurError>` branch and the properties its body reads.
 *
 * A condition naming two of our classes claims the property against BOTH,
 * because the body runs only when both hold — that is the promise the reader is
 * handed, not a choice between them.
 */
export function readmeClaims(markdown: string, known: Set<string>): Claim[] {
  const claims: Claim[] = [];

  codeFences(markdown).forEach((fence, index) => {
    const where = `README.md fence #${index + 1}`;
    const src = parse('sample.ts', fence);

    const visit = (node: ts.Node): void => {
      if (ts.isIfStatement(node)) {
        // Which names the condition proves are one of our error classes.
        const bound = new Map<string, string[]>();
        const scanCondition = (n: ts.Node): void => {
          if (
            ts.isBinaryExpression(n) &&
            n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
            ts.isIdentifier(n.left) &&
            ts.isIdentifier(n.right) &&
            known.has(n.right.text)
          ) {
            const list = bound.get(n.left.text) ?? [];
            list.push(n.right.text);
            bound.set(n.left.text, list);
          }
          ts.forEachChild(n, scanCondition);
        };
        scanCondition(node.expression);

        if (bound.size > 0) {
          const collect = (n: ts.Node): void => {
            if (
              ts.isPropertyAccessExpression(n) &&
              ts.isIdentifier(n.expression)
            ) {
              const classes = bound.get(n.expression.text);
              if (classes) {
                for (const cls of classes) {
                  claims.push({ cls, prop: n.name.text, where });
                }
              }
            }
            ts.forEachChild(n, collect);
          };
          collect(node.thenStatement);
        }
      }
      ts.forEachChild(node, visit);
    };

    ts.forEachChild(src, visit);
  });

  // Deduplicated — a branch reading `error.limit` twice is one promise — and
  // ordered so failure output is stable.
  const seen = new Set<string>();
  return claims
    .filter(c => {
      const key = `${c.cls}.${c.prop}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => `${a.cls}.${a.prop}`.localeCompare(`${b.cls}.${b.prop}`));
}

interface Audit {
  problems: string[];
  claims: Claim[];
}

/** Zero claims is itself a problem. */
export function audit(markdown: string, table: Map<string, ClassInfo>): Audit {
  const claims = readmeClaims(markdown, new Set(table.keys()));
  if (claims.length === 0) {
    return {
      claims,
      problems: [
        'no error-property claims were parsed from the README at all. That is ' +
          'a failure, not a pass: an error-handling section that moved, stopped ' +
          'using instanceof, or stopped being a fenced sample would otherwise ' +
          "read as 'every claim holds'.",
      ],
    };
  }

  const problems: string[] = [];
  for (const claim of claims) {
    const { props, chainProblem } = inheritedProps(table, claim.cls);
    if (chainProblem) {
      problems.push(`${claim.where}: ${chainProblem}`);
      continue;
    }
    if (!props.has(claim.prop)) {
      problems.push(
        `${claim.where}: \`${claim.cls}.${claim.prop}\` is documented, but no ` +
          `\`this.${claim.prop} = \` (and no constructor parameter property) ` +
          `exists in ${claim.cls} or its ancestors ` +
          `(${chainOf(table, claim.cls).join(' -> ')}). A reader's handler ` +
          `would read undefined. Assign it, or stop documenting it.`
      );
    }
  }
  return { problems, claims };
}

/** The report artifact: property -> assignment site, or MISSING. */
export function claimsTable(
  markdown: string,
  table: Map<string, ClassInfo>
): string {
  return readmeClaims(markdown, new Set(table.keys()))
    .map(claim => {
      const { props } = inheritedProps(table, claim.cls);
      return `${claim.cls}.${claim.prop} -> ${props.get(claim.prop) ?? 'MISSING'}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

describe('README error-object properties', () => {
  it('every documented property has an assignment site', () => {
    const table = buildClassTable(liveSources());

    // Refuse to trust an extraction that found nothing: an empty table agrees
    // with every claim by having nothing to disagree with.
    expect(table.size).toBeGreaterThanOrEqual(15);
    expect(table.get('RateLimitExceededError')?.props.has('retryAfter')).toBe(
      true
    );

    const { problems, claims } = audit(readme(), table);

    expect(claims.length).toBeGreaterThanOrEqual(MIN_CLAIMS);
    if (problems.length > 0) {
      throw new Error(
        'README documents error properties that nothing assigns:\n  ' +
          problems.join('\n  ') +
          '\n\nEvery claim, and where it resolves:\n' +
          claimsTable(readme(), table)
      );
    }
  });

  it('catches a planted claim', () => {
    // Positive control. The zero above is worthless until the check fires. A
    // README can document a property no code assigns; that is the whole reason
    // this file exists, so plant exactly that and require a red naming it.
    const table = buildClassTable(liveSources());
    const original = readme();
    const anchor =
      '    console.error(`Rate limited. Retry after: ${error.retryAfter}s`);';
    expect(original).toContain(anchor);

    const planted = original.replace(
      anchor,
      () => `${anchor}\n    console.error(error.retryAfterSeconds);`
    );
    expect(planted).not.toBe(original);

    const { problems } = audit(planted, table);
    expect(
      problems.some(
        p =>
          p.includes('RateLimitExceededError') &&
          p.includes('retryAfterSeconds')
      )
    ).toBe(true);

    // ...and the unplanted README stays green, or the control proves only noise.
    expect(audit(original, table).problems).toEqual([]);
  });

  it('treats zero claims as a failure, not a pass', () => {
    // Vacuity guard: a section that moved must never read as "all claims hold".
    const table = buildClassTable(liveSources());

    const empty = audit('# Aetherfy\n\nNo fenced samples here.\n', table);
    expect(empty.claims).toEqual([]);
    expect(empty.problems[0]).toContain('no error-property claims');

    // The realistic version of the same accident: the section is still there,
    // but the branch no longer proves which class it caught.
    const unbound = [
      '```typescript',
      'try {',
      "  await client.search('c', vector);",
      '} catch (error) {',
      '  console.error(error.retryAfter);',
      '}',
      '```',
      '',
    ].join('\n');
    const loose = audit(unbound, table);
    expect(loose.claims).toEqual([]);
    expect(loose.problems.length).toBeGreaterThan(0);
  });

  it('goes red when a real assignment is deleted', () => {
    // Mutation proof, asserted-applied before the verdict is trusted.
    const sources = liveSources();
    const label = 'src/exceptions.ts';
    const original = sources.get(label) as string;

    const needle = '    this.retryAfter = retryAfter;\n';
    expect(original).toContain(needle);
    const mutated = original.replace(needle, '');
    expect(mutated).not.toBe(original);

    const mutatedTable = buildClassTable(
      new Map([...sources, [label, mutated]])
    );
    // The mutation LANDED — the site is gone from the table, not merely from
    // the text. The class still DECLARES `retryAfter`, and a declaration is not
    // a site; if this expectation ever passes trivially the red below would not
    // be caused by the mutation.
    expect(
      mutatedTable.get('RateLimitExceededError')?.props.has('retryAfter')
    ).toBe(false);

    const { problems } = audit(readme(), mutatedTable);
    expect(
      problems.some(
        p => p.includes('RateLimitExceededError') && p.includes('retryAfter')
      )
    ).toBe(true);

    // Restore -> green.
    expect(audit(readme(), buildClassTable(sources)).problems).toEqual([]);
  });

  it('does not count a declaration as an assignment site', () => {
    // The crux. `public code?: string;` type-checks everywhere and promises
    // nothing; that is the bug shape this guard exists to catch.
    const table = buildClassTable(
      new Map([
        [
          'synthetic.ts',
          [
            'export class Declared extends Error {',
            '  public readonly neverAssigned?: string;',
            '  public readonly assigned: string;',
            '  constructor() {',
            "    super('x');",
            "    this.assigned = 'y';",
            '  }',
            '}',
          ].join('\n'),
        ],
      ])
    );
    const { props } = inheritedProps(table, 'Declared');
    expect(props.has('assigned')).toBe(true);
    expect(props.has('neverAssigned')).toBe(false);
  });

  it('counts a constructor parameter property as an assignment site', () => {
    // src/memory/errors.ts is written entirely this way. A check that only knew
    // `this.x =` would call every one of its properties missing.
    const table = buildClassTable(liveSources());
    const { props, chainProblem } = inheritedProps(
      table,
      'NamespaceNotFoundError'
    );
    expect(chainProblem).toBeNull();
    expect(props.get('namespaceName')).toContain('src/memory/errors.ts:');
  });

  it('allows only the properties the native Error constructor sets', () => {
    // The README's ValidationError branch reads `error.message`, which has no
    // `this.message =` anywhere in this repository — the native constructor
    // sets it. That allowance is pinned here so it stays a short, named list
    // rather than quietly growing into an excuse.
    const table = buildClassTable(liveSources());
    const { props } = inheritedProps(table, 'ValidationError');
    expect(props.get('message')).toBe('native Error');
    expect(props.get('stack')).toBe('native Error');
    // `cause` is NOT native here: NetworkError must show its own real site.
    expect(props.has('cause')).toBe(false);
    expect(inheritedProps(table, 'NetworkError').props.get('cause')).toContain(
      'src/exceptions.ts:'
    );
  });

  it('does not let a nested class lend its assignments to the outer one', () => {
    // Fail-green check on the extractor itself. A walk that descended into a
    // nested class would credit the outer class with the inner one's
    // `this.x =`, which reads as "assigned" for a property the outer class
    // never sets — green, and wrong.
    const table = buildClassTable(
      new Map([
        [
          'synthetic.ts',
          [
            'export class Outer extends Error {',
            '  build() {',
            '    class Inner {',
            '      constructor() {',
            '        this.innerOnly = 1;',
            '      }',
            '    }',
            '    return Inner;',
            '  }',
            '  constructor() {',
            "    super('x');",
            '    this.outerOnly = 2;',
            '  }',
            '}',
          ].join('\n'),
        ],
      ])
    );
    expect([...(table.get('Outer')?.props.keys() ?? [])]).toEqual([
      'outerOnly',
    ]);
    expect([...(table.get('Inner')?.props.keys() ?? [])]).toEqual([
      'innerOnly',
    ]);
  });

  it('reports an unresolvable ancestor instead of assuming', () => {
    const table = buildClassTable(
      new Map([
        ['synthetic.ts', 'export class Orphan extends SomethingElse {}'],
      ])
    );
    const { props, chainProblem } = inheritedProps(table, 'Orphan');
    expect(props.size).toBe(0);
    expect(chainProblem).toContain('SomethingElse');
  });

  it('refuses two classes with the same name', () => {
    expect(() =>
      buildClassTable(
        new Map([
          ['a.ts', 'export class AuthenticationError extends Error {}'],
          ['b.ts', 'export class AuthenticationError extends Error {}'],
        ])
      )
    ).toThrow(/two classes named AuthenticationError/);
  });

  it('knows every error class the README imports', () => {
    // Coverage pin for ERROR_SOURCES itself. A class the table does not know is
    // not checked and is not reported either — readmeClaims only claims against
    // known class names, so moving an error to a new file would drop its claims
    // SILENTLY. That is the one fail-green this design has; this closes it.
    const table = buildClassTable(liveSources());
    const imported = new Set<string>();

    for (const fence of codeFences(readme())) {
      const src = parse('sample.ts', fence);
      ts.forEachChild(src, node => {
        if (!ts.isImportDeclaration(node)) return;
        const spec = node.moduleSpecifier;
        if (!ts.isStringLiteral(spec) || spec.text !== 'aetherfy-vectors')
          return;
        const named = node.importClause?.namedBindings;
        if (!named || !ts.isNamedImports(named)) return;
        for (const el of named.elements) {
          const name = el.name.text;
          if (/^[A-Z].*Error$/.test(name)) imported.add(name);
        }
      });
    }

    expect(imported.size).toBeGreaterThanOrEqual(10);
    const missing = [...imported].filter(name => !table.has(name)).sort();
    if (missing.length > 0) {
      throw new Error(
        `the README documents ${missing.join(', ')}, which ` +
          `${ERROR_SOURCES.join(' / ')} do not define. Claims about those ` +
          `classes are being dropped silently. Add the defining file to ` +
          `ERROR_SOURCES.`
      );
    }
  });
});
