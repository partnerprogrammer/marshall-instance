/**
 * Wiring test for the add-thread-nudge-feedback skill's code-edit
 * integration point.
 *
 * The skill's only reach into core is one appended line in
 * src/modules/index.ts: `import './thread-nudge-feedback/index.js';`. This
 * asserts it structurally, via the TypeScript AST — same reasoning as
 * add-thread-nudge's own wiring test. It additionally asserts the import
 * comes after './thread-nudge/index.js': not an arbitrary ordering
 * preference but a real functional dependency — thread-nudge-feedback's
 * own config.ts imports THREAD_NUDGE_MESSAGING_GROUPS directly from
 * ../thread-nudge/config.js (see this skill's SKILL.md "Requires" section:
 * "/add-thread-nudge must already be installed"). If thread-nudge were ever
 * removed while this skill's import stayed behind, the barrel would fail to
 * resolve — this test's ordering assertion is the closest structural proxy
 * for "the dependency is actually installed" available without booting the
 * real host.
 *
 * Ships with the skill; apply copies it to src/modules/.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const barrelPath = path.resolve(process.cwd(), 'src/modules/index.ts');
const source = fs.readFileSync(barrelPath, 'utf8');
const sf = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);

function isImportOf(stmt: ts.Statement, specifier: string): boolean {
  return (
    ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) && stmt.moduleSpecifier.text === specifier
  );
}

describe('add-thread-nudge-feedback wiring in src/modules/index.ts', () => {
  it("imports './thread-nudge-feedback/index.js' as a top-level statement, after its thread-nudge dependency", () => {
    const stmts = sf.statements;
    const nudgeIdx = stmts.findIndex((s) => isImportOf(s, './thread-nudge/index.js'));
    const feedbackIdx = stmts.findIndex((s) => isImportOf(s, './thread-nudge-feedback/index.js'));

    expect(
      nudgeIdx,
      "thread-nudge's own import not found — add-thread-nudge-feedback requires add-thread-nudge",
    ).toBeGreaterThanOrEqual(0);
    expect(
      feedbackIdx,
      "import './thread-nudge-feedback/index.js' must be a top-level statement of the barrel",
    ).toBeGreaterThanOrEqual(0);
    expect(
      feedbackIdx,
      'thread-nudge-feedback must be imported after thread-nudge (real dependency: config.ts imports from ../thread-nudge/config.js)',
    ).toBeGreaterThan(nudgeIdx);
  });
});
