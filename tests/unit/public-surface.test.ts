/**
 * What the SDK hands a customer, the customer can import.
 *
 * Why this exists: on 2026-09-24 the docs code-block guard started building
 * this package's surface with the TypeScript compiler instead of a regex, and
 * for the first time something knew what the package ROOT really exported. It
 * found that the memory client THROWS `ThreadVectorSizeMismatchError` while
 * the root barrel re-exports memory names one by one and had left it out — so
 * `err instanceof ThreadVectorSizeMismatchError` was impossible for a root
 * importer — and that `client.scroll()` took a `ScrollOptions` and returned a
 * `ScrollResult`, neither of them importable. Nothing had noticed either, and
 * nothing would have. This makes the class structural.
 *
 * For EVERY entry point in package.json "exports" (read from the manifest,
 * never hard-coded, so a new subpath is covered the day it is declared):
 *
 *   (a) THROWN ERRORS ARE IMPORTABLE. Every `throw new X(...)` in a source file
 *       the entry point's runtime import graph reaches, with X resolved through
 *       the type checker — not by name: `auth.ts` throws its own
 *       `AuthenticationError`, which the root exports as `AuthError`, and a
 *       name match would have confused it with the one in `exceptions.ts`. X
 *       must be exported from that entry point. Built-ins (`Error`,
 *       `TypeError`, `RangeError`) are declared by the platform, not by this
 *       package, and are importable by definition.
 *       The walk follows STATIC `import` / `export ... from` declarations
 *       only. That is enforced, not assumed: a reached file containing a
 *       dynamic `import(...)`, a `require(...)` call or an
 *       `import x = require(...)` fails the test, because the code it loads
 *       would otherwise go unchecked without anything saying so.
 *   (b) PUBLIC SIGNATURE TYPES ARE IMPORTABLE. For every public member
 *       (constructor, method, accessor, property; static or instance, own or
 *       inherited from a class in this package) of every exported class, and
 *       every exported function: each named interface / type alias / class /
 *       enum DECLARED IN THIS PACKAGE that appears in a parameter or return
 *       type — unwrapped through generic arguments (Promise<T>, Array<T>,
 *       AsyncGenerator<T>, ...), unions and optionals — must be exported from
 *       that entry point. It does not descend into the MEMBERS of those types;
 *       a type that is importable is the unit here.
 *
 *   (d) EVERY ERROR IN AN ENTRY POINT'S OWN HIERARCHY IS IMPORTABLE. (a)
 *       sees only `throw new X(...)`; an error built by a FACTORY and thrown
 *       by value (`throw createErrorFromResponse(...)`) is decided at runtime,
 *       and every class that factory builds — ConflictError,
 *       CollectionInUseError, RateLimitExceededError, ... — was exported only
 *       because someone remembered to.
 *       ANCHORED ON SOURCE, not on exports. Each entry point OWNS the source
 *       directory its entry file sits in, minus any deeper directory another
 *       entry point owns: the root owns src/ minus src/agent/, the agent
 *       subpath owns src/agent/. Its BASE error classes are the error classes
 *       defined in its own files whose parent is defined outside them (the
 *       root: AetherfyVectorsError and auth.ts's AuthenticationError, both
 *       extending Error; the agent subpath: AgentError, whose parent lives in
 *       the root's exceptions.ts). Every base, and every class defined in the
 *       entry point's own files that descends from one, found through the
 *       checker's base types, must be exported from it. Nothing here reads
 *       the exports to decide what is checked, so dropping a BASE from the
 *       exports reds as well; an earlier version anchored on the exports and
 *       could not see that. Ownership is by directory, not by reachability,
 *       because reachability does not partition: the agent subpath reaches
 *       exceptions.ts, and must not be asked to export every vector error.
 *
 * DELIBERATELY NOT ASSERTED — do not "extend" this into it:
 *   (c) NO EXPORTED ORPHANS. Whether an exported type is USED by anything is a
 *       design question, not a structural one: a type a customer annotates
 *       their own code with is a legitimate export that no signature here
 *       mentions. The orphan that prompted this file (`PaginationInfo`, a type
 *       whose `hasMore` nothing ever set) was removed by hand. A check that
 *       reds on unreferenced exports would red on legitimate ones.
 *
 * ANTI-NO-OP: every entry point must have reached more files than itself,
 * found package-declared throw sites, walked public members, and own at least
 * one base error class and at least one class descending from it. A test that
 * walked nothing looks exactly like a test that verified everything.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** A conditional exports target: a path, or conditions nesting more targets. */
type ExportTarget = string | { [condition: string]: ExportTarget };

interface PackageManifest {
  name: string;
  exports: Record<string, ExportTarget>;
}

/** Every path under a `types` condition, at any depth of nesting. */
function typesTargets(target: ExportTarget, underTypes = false): string[] {
  if (typeof target === 'string') return underTypes ? [target] : [];
  return Object.entries(target).flatMap(([condition, nested]) =>
    typesTargets(nested, underTypes || condition === 'types')
  );
}

interface EntryPoint {
  /** What a customer writes: `aetherfy-vectors`, `aetherfy-vectors/agent`. */
  specifier: string;
  /** Absolute path of the source file the entry point's types are built from. */
  source: string;
}

const MANIFEST: PackageManifest = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
);

function loadConfig(): ts.ParsedCommandLine {
  const configPath = path.join(REPO_ROOT, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(read.error.messageText, '\n')
    );
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, REPO_ROOT);
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n'))
        .join('\n')
    );
  }
  return parsed;
}

const CONFIG = loadConfig();
const SOURCE_ROOT = path.resolve(CONFIG.options.rootDir ?? 'src');
const OUT_DIR = path.resolve(CONFIG.options.outDir ?? 'dist');

/**
 * Map each "exports" entry to the source file its declarations come from.
 * Its `types` conditions (nested under `import` / `require`) name a .d.ts under
 * outDir, which tsc writes from the .ts at the same relative path under
 * rootDir, so the mapping is the compiler's own, read from the same tsconfig —
 * not a convention this test assumes. The `.d.mts` twin on the `import` side is
 * GENERATED from the built bundle and re-exports that same .d.ts, so it maps to
 * no source of its own and is not what this reads. Exactly one .d.ts per entry:
 * two would leave the source ambiguous, none would leave it unknown.
 */
function entryPoints(): EntryPoint[] {
  return Object.entries(MANIFEST.exports).map(([subpath, conditions]) => {
    const declarations = [
      ...new Set(typesTargets(conditions).filter(t => t.endsWith('.d.ts'))),
    ];
    if (declarations.length !== 1) {
      throw new Error(
        `package.json exports['${subpath}'] names ${declarations.length} .d.ts ` +
          `files under "types" (${declarations.join(', ') || 'none'}); this ` +
          'test needs exactly one to tell which source file it publishes.'
      );
    }
    const [types] = declarations;
    const declaration = path.resolve(REPO_ROOT, types);
    const relative = path.relative(OUT_DIR, declaration);
    if (relative.startsWith('..')) {
      throw new Error(
        `package.json exports['${subpath}'] types (${types}) is not under ` +
          `the tsconfig outDir (${OUT_DIR}).`
      );
    }
    const source = path.join(SOURCE_ROOT, relative.replace(/\.d\.ts$/, '.ts'));
    if (!fs.existsSync(source)) {
      throw new Error(
        `package.json exports['${subpath}'] publishes ${types}, ` +
          `but its source ${source} does not exist.`
      );
    }
    const specifier =
      subpath === '.'
        ? MANIFEST.name
        : `${MANIFEST.name}/${subpath.replace(/^\.\//, '')}`;
    return { specifier, source };
  });
}

const ENTRY_POINTS = entryPoints();

let program: ts.Program;
let checker: ts.TypeChecker;

// THE BUDGET IS MEASURED, not guessed. Building this program took 6.2 s and
// 6.9 s with this file run alone (one outlier at 19.7 s), and 12.3 s and
// 19.7 s inside the full parallel suite, on a Windows dev box (2026-09-24).
// The worst of those is under a third of 120 s, so the budget was left
// alone. If a CI runner gets near it, re-measure before raising it: a timeout
// is how a slow runner turns into a red for the wrong reason.
beforeAll(() => {
  program = ts.createProgram({
    rootNames: CONFIG.fileNames,
    options: { ...CONFIG.options, noEmit: true },
  });
  checker = program.getTypeChecker();
}, 120_000);

function isPackageFile(sf: ts.SourceFile): boolean {
  if (sf.isDeclarationFile) return false;
  const relative = path.relative(SOURCE_ROOT, path.resolve(sf.fileName));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isPackageSymbol(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some(d =>
    isPackageFile(d.getSourceFile())
  );
}

function resolveAlias(symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function where(node: ts.Node): string {
  const sf = node.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
  return `${path.relative(REPO_ROOT, sf.fileName).replace(/\\/g, '/')}:${line + 1}`;
}

function sourceFileOf(entry: EntryPoint): ts.SourceFile {
  const sf = program.getSourceFile(entry.source);
  if (!sf) {
    throw new Error(
      `${entry.source} is not part of the program built from tsconfig.json.`
    );
  }
  return sf;
}

/** The entry point's exports, each resolved to the symbol it re-exports. */
function exportedSymbols(entry: EntryPoint): Set<ts.Symbol> {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFileOf(entry));
  if (!moduleSymbol) throw new Error(`${entry.source} is not a module.`);
  return new Set(checker.getExportsOfModule(moduleSymbol).map(resolveAlias));
}

/**
 * Refuse a file that loads code the static walk below cannot follow. Parsed,
 * so a `require()` in a comment or a string is not a hit.
 */
function assertStaticImportsOnly(sf: ts.SourceFile): void {
  const visit = (node: ts.Node): void => {
    const dynamic =
      (ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === 'require'))) ||
      (ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference));
    if (dynamic) {
      throw new Error(
        `${where(node)} loads a module dynamically (import() / require()). ` +
          'The reachability walk follows static import/export declarations ' +
          'only and cannot follow this one, so whatever it loads would go ' +
          'unchecked. Make it a static import, or teach the walk this edge.'
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/**
 * Every package source file the entry point's RUNTIME import graph reaches.
 * `import type` / `export type ... from` edges are not followed: nothing
 * reached only through them executes, so nothing in it can throw. Every
 * reached file is checked for dynamic loads first (see above).
 */
function reachableFiles(entry: EntryPoint): ts.SourceFile[] {
  const seen = new Set<ts.SourceFile>();
  const queue = [sourceFileOf(entry)];
  while (queue.length > 0) {
    const sf = queue.pop() as ts.SourceFile;
    if (seen.has(sf)) continue;
    seen.add(sf);
    assertStaticImportsOnly(sf);
    for (const statement of sf.statements) {
      let specifier: ts.Expression | undefined;
      if (ts.isImportDeclaration(statement)) {
        if (statement.importClause?.isTypeOnly) continue;
        specifier = statement.moduleSpecifier;
      } else if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly) continue;
        specifier = statement.moduleSpecifier;
      }
      if (!specifier) continue;
      const target = checker.getSymbolAtLocation(specifier)?.valueDeclaration;
      if (target && ts.isSourceFile(target) && isPackageFile(target)) {
        queue.push(target);
      }
    }
  }
  return [...seen];
}

interface ThrowSite {
  symbol: ts.Symbol;
  at: string;
}

function throwSites(files: ts.SourceFile[]): {
  own: ThrowSite[];
  builtin: number;
} {
  const own: ThrowSite[] = [];
  let builtin = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isThrowStatement(node) && node.expression) {
      let thrown: ts.Expression = node.expression;
      while (
        ts.isParenthesizedExpression(thrown) ||
        ts.isAsExpression(thrown) ||
        ts.isNonNullExpression(thrown)
      ) {
        thrown = thrown.expression;
      }
      if (ts.isNewExpression(thrown)) {
        const callee = ts.isPropertyAccessExpression(thrown.expression)
          ? thrown.expression.name
          : thrown.expression;
        const symbol = checker.getSymbolAtLocation(callee);
        if (!symbol) {
          // Never skipped: an unresolvable throw is exactly the site this
          // test could otherwise pass without having looked at.
          throw new Error(
            `Cannot resolve the class thrown at ${where(thrown)}.`
          );
        }
        const resolved = resolveAlias(symbol);
        if (isPackageSymbol(resolved)) {
          own.push({ symbol: resolved, at: where(thrown) });
        } else {
          builtin += 1;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  files.forEach(visit);
  return { own, builtin };
}

/** The class a class `extends`, or undefined for none. */
function baseClassOf(symbol: ts.Symbol): ts.Symbol | undefined {
  const type = checker.getDeclaredTypeOfSymbol(symbol);
  if (!type.isClass()) return undefined;
  return checker.getBaseTypes(type)[0]?.getSymbol();
}

/** Every proper ancestor, nearest first, package-declared or not. */
function ancestorsOf(symbol: ts.Symbol): ts.Symbol[] {
  const out: ts.Symbol[] = [];
  let current = baseClassOf(symbol);
  while (current && !out.includes(current)) {
    out.push(current);
    current = baseClassOf(current);
  }
  return out;
}

/** A package class that descends from the platform's `Error`. */
function isPackageErrorClass(symbol: ts.Symbol): boolean {
  return (
    !!(symbol.flags & ts.SymbolFlags.Class) &&
    isPackageSymbol(symbol) &&
    ancestorsOf(symbol).some(
      a => a.getName() === 'Error' && !isPackageSymbol(a)
    )
  );
}

/**
 * The entry point that owns a source file: the one whose entry file's
 * directory is the DEEPEST directory containing it. So src/agent/** belongs to
 * the agent subpath and everything else under src/ to the root, and a new
 * subpath in package.json "exports" takes its own directory automatically.
 */
function ownerOf(sf: ts.SourceFile): EntryPoint | undefined {
  const file = path.resolve(sf.fileName);
  let owner: EntryPoint | undefined;
  for (const entry of ENTRY_POINTS) {
    const dir = path.dirname(entry.source);
    const relative = path.relative(dir, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (!owner || dir.length > path.dirname(owner.source).length) {
      owner = entry;
    }
  }
  return owner;
}

interface HierarchyMember {
  symbol: ts.Symbol;
  /** The base this class is, or descends from. */
  base: ts.Symbol;
  at: string;
}

/**
 * See (d): every error class defined in the entry point's OWN files that is
 * one of its bases (its parent is defined outside those files) or descends
 * from one. Decided from the source alone; the exports are never consulted.
 */
function ownHierarchy(entry: EntryPoint): {
  bases: ts.Symbol[];
  members: HierarchyMember[];
} {
  const declared: { symbol: ts.Symbol; at: string }[] = [];
  for (const sf of program.getSourceFiles()) {
    if (!isPackageFile(sf) || ownerOf(sf) !== entry) continue;
    for (const statement of sf.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue;
      const symbol = checker.getSymbolAtLocation(statement.name);
      if (!symbol) {
        throw new Error(`Cannot resolve the class at ${where(statement)}.`);
      }
      if (isPackageErrorClass(symbol)) {
        declared.push({ symbol, at: where(statement) });
      }
    }
  }
  const own = new Set(declared.map(d => d.symbol));
  const bases = declared
    .map(d => d.symbol)
    .filter(symbol => {
      const parent = baseClassOf(symbol);
      return !parent || !own.has(parent);
    });
  const members: HierarchyMember[] = [];
  for (const { symbol, at } of declared) {
    const base = [symbol, ...ancestorsOf(symbol)].find(a => bases.includes(a));
    if (base) members.push({ symbol, base, at });
  }
  return { bases, members };
}

/** A place a type appears in the public surface, phrased for a message. */
interface Usage {
  symbol: ts.Symbol;
  role: string;
}

/**
 * The named, package-declared types a type is built from, unwrapped through
 * generic arguments and unions. A package-declared alias is collected and NOT
 * opened: its body is its own business, and the alias is what a customer
 * writes. An alias from elsewhere (`Record`, `Partial`) is transparent.
 */
function namedPackageTypes(type: ts.Type, out: Set<ts.Symbol>): void {
  const seen = new Set<ts.Type>();
  const walk = (t: ts.Type): void => {
    if (seen.has(t)) return;
    seen.add(t);

    if (t.aliasSymbol) {
      if (isPackageSymbol(t.aliasSymbol)) {
        out.add(t.aliasSymbol);
        return;
      }
      (t.aliasTypeArguments ?? []).forEach(walk);
    }
    if (t.flags & ts.TypeFlags.EnumLiteral && !(t.flags & ts.TypeFlags.Union)) {
      walk(checker.getBaseTypeOfLiteralType(t));
      return;
    }
    const symbol = t.getSymbol();
    if (
      symbol &&
      symbol.flags &
        (ts.SymbolFlags.Interface |
          ts.SymbolFlags.Class |
          ts.SymbolFlags.Enum) &&
      isPackageSymbol(symbol)
    ) {
      out.add(symbol);
    }
    if (t.isUnionOrIntersection()) {
      t.types.forEach(walk);
      return;
    }
    if (t.flags & ts.TypeFlags.Object) {
      const object = t as ts.ObjectType;
      if (object.objectFlags & ts.ObjectFlags.Reference) {
        checker.getTypeArguments(t as ts.TypeReference).forEach(walk);
      }
    }
  };
  walk(type);
}

function signatureUsages(
  signature: ts.Signature,
  owner: string,
  usages: Usage[]
): void {
  for (const parameter of signature.getParameters()) {
    const declaration = parameter.valueDeclaration;
    if (!declaration) continue;
    const found = new Set<ts.Symbol>();
    namedPackageTypes(
      checker.getTypeOfSymbolAtLocation(parameter, declaration),
      found
    );
    found.forEach(symbol =>
      usages.push({
        symbol,
        role: `the type of parameter \`${parameter.getName()}\` of ${owner}`,
      })
    );
  }
  const found = new Set<ts.Symbol>();
  namedPackageTypes(signature.getReturnType(), found);
  found.forEach(symbol =>
    usages.push({ symbol, role: `the return type of ${owner}` })
  );
}

function isPublicMember(member: ts.Symbol): boolean {
  const declarations = member.declarations ?? [];
  if (!declarations.some(d => isPackageFile(d.getSourceFile()))) {
    // Inherited from the platform (Error's `message`, `stack`,
    // `captureStackTrace`): not this package's surface.
    return false;
  }
  return declarations.every(d => {
    const name = ts.getNameOfDeclaration(d);
    if (name && ts.isPrivateIdentifier(name)) return false;
    const flags = ts.getCombinedModifierFlags(d as ts.Declaration);
    return !(flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected));
  });
}

function memberUsages(
  member: ts.Symbol,
  qualifiedName: string,
  location: ts.Node,
  usages: Usage[]
): void {
  const type = checker.getTypeOfSymbolAtLocation(member, location);
  if (member.flags & ts.SymbolFlags.Method) {
    type
      .getCallSignatures()
      .forEach(s => signatureUsages(s, qualifiedName, usages));
    return;
  }
  const found = new Set<ts.Symbol>();
  namedPackageTypes(type, found);
  const kind = member.flags & ts.SymbolFlags.Accessor ? 'accessor' : 'property';
  found.forEach(symbol =>
    usages.push({
      symbol,
      role: `the type of ${kind} ${qualifiedName}`,
    })
  );
}

interface Surface {
  usages: Usage[];
  members: number;
}

function publicSurface(exported: Set<ts.Symbol>): Surface {
  const usages: Usage[] = [];
  let members = 0;
  for (const symbol of exported) {
    const declaration = symbol.valueDeclaration;
    if (!declaration || !isPackageSymbol(symbol)) continue;
    const name = symbol.getName();

    if (symbol.flags & ts.SymbolFlags.Class) {
      const staticSide = checker.getTypeOfSymbolAtLocation(symbol, declaration);
      staticSide.getConstructSignatures().forEach(s => {
        members += 1;
        signatureUsages(s, `new ${name}(...)`, usages);
      });
      for (const member of checker.getPropertiesOfType(staticSide)) {
        if (member.getName() === 'prototype' || !isPublicMember(member)) {
          continue;
        }
        members += 1;
        memberUsages(
          member,
          `${name}.${member.getName()} (static)`,
          declaration,
          usages
        );
      }
      const instanceSide = checker.getDeclaredTypeOfSymbol(symbol);
      for (const member of checker.getPropertiesOfType(instanceSide)) {
        if (!isPublicMember(member)) continue;
        members += 1;
        memberUsages(
          member,
          `${name}.${member.getName()}`,
          declaration,
          usages
        );
      }
    } else if (symbol.flags & ts.SymbolFlags.Function) {
      checker
        .getTypeOfSymbolAtLocation(symbol, declaration)
        .getCallSignatures()
        .forEach(s => {
          members += 1;
          signatureUsages(s, `${name}()`, usages);
        });
    }
  }
  return { usages, members };
}

describe.each(ENTRY_POINTS)(
  "public surface of '$specifier'",
  (entry: EntryPoint) => {
    it('reaches code, throw sites and public members (anti-no-op)', () => {
      const files = reachableFiles(entry);
      const { own } = throwSites(files);
      const { members } = publicSurface(exportedSymbols(entry));

      const hierarchy = ownHierarchy(entry);

      expect(files.length).toBeGreaterThan(1);
      expect(own.length).toBeGreaterThan(0);
      expect(members).toBeGreaterThan(0);
      expect(hierarchy.bases.length).toBeGreaterThan(0);
      expect(hierarchy.members.length).toBeGreaterThan(hierarchy.bases.length);
    });

    it('every error class it throws is exported from it', () => {
      const exported = exportedSymbols(entry);
      const { own } = throwSites(reachableFiles(entry));

      const failures = own
        .filter(site => !exported.has(site.symbol))
        .map(
          site =>
            `${site.symbol.getName()} is thrown at ${site.at} but is not ` +
            `exported from '${entry.specifier}'`
        );
      expect([...new Set(failures)]).toEqual([]);
    });

    it('every error class in its own hierarchy is exported from it', () => {
      const exported = exportedSymbols(entry);
      const { members } = ownHierarchy(entry);

      const failures = members
        .filter(member => !exported.has(member.symbol))
        .map(
          member =>
            `${member.symbol.getName()} (${member.at}) ` +
            (member.base === member.symbol
              ? 'is a base error of this entry point'
              : `extends ${member.base.getName()}`) +
            ` but is not exported from '${entry.specifier}'`
        );
      expect(failures).toEqual([]);
    });

    it('every package type in a public signature is exported from it', () => {
      const exported = exportedSymbols(entry);
      const { usages } = publicSurface(exported);

      const failures = usages
        .filter(usage => !exported.has(usage.symbol))
        .map(
          usage =>
            `${usage.symbol.getName()} is ${usage.role} but is not exported ` +
            `from '${entry.specifier}'`
        );
      expect([...new Set(failures)]).toEqual([]);
    });
  }
);
