/**
 * Wiring test for the add-thread-nudge skill's code-edit integration point.
 *
 * The skill's only reach into core is one appended line in
 * src/modules/index.ts: `import './thread-nudge/index.js';`. A behavioral
 * test of the module (classify.test.ts, index.test.ts) can't see whether
 * that barrel line is actually present — the module works fine in isolation
 * even if nothing ever imports it into the running host — so this asserts
 * the edit *structurally*, via the TypeScript AST. It verifies:
 *   - a top-level import of './thread-nudge/index.js' exists in the barrel,
 *   - it is a direct statement of the SourceFile (not nested/conditional),
 *   - it comes after the mailbox/compose.js import — the barrel's own
 *     documented invariant ("Registry-based modules... append imports
 *     below" the default ones).
 *
 * Delete or misplace the line and this goes red. Combined with the build
 * (a bad path fails typecheck) and classify.test.ts/index.test.ts (module
 * behavior), the three together cover deletion, misplacement, drift, and
 * behavior — for a true code edit, with no registry required.
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

describe('add-thread-nudge wiring in src/modules/index.ts', () => {
  it("imports './thread-nudge/index.js' as a top-level statement, after the mailbox import", () => {
    const stmts = sf.statements;
    const mailboxIdx = stmts.findIndex((s) => isImportOf(s, '../mailbox/compose.js'));
    const nudgeIdx = stmts.findIndex((s) => isImportOf(s, './thread-nudge/index.js'));

    expect(mailboxIdx, 'mailbox/compose.js anchor import not found').toBeGreaterThanOrEqual(0);
    expect(
      nudgeIdx,
      "import './thread-nudge/index.js' must be a top-level statement of the barrel",
    ).toBeGreaterThanOrEqual(0);
    expect(
      nudgeIdx,
      'the thread-nudge import must come after the mailbox import (documented barrel invariant)',
    ).toBeGreaterThan(mailboxIdx);
  });
});
