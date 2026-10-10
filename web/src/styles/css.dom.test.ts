import { test, assert } from 'vitest';
import { css, expandForTest as expand } from './css';

/*
 * The expansion is the part that can be WRONG SILENTLY.
 *
 * A selector that comes out slightly off does not throw - it simply matches nothing, and the
 * element renders with whatever it inherited. That looks plausible, which is exactly how the three
 * invented tokens got through in this project's first hour.
 */

/** Rules as a comparable set, so whitespace and ordering noise cannot pass or fail a test. */
function rules(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

test('a block with no nesting is one rule', () => {
  assert.deepEqual(rules(expand('.x', 'display: flex; gap: 4px;')), ['.x { display: flex; gap: 4px; }']);
});

test('a nested block with & is that selector, not a descendant of it', () => {
  assert.deepEqual(
    rules(expand('.x', 'color: red; &:disabled { color: grey; }')),
    ['.x { color: red; }', '.x:disabled { color: grey; }'],
  );
});

test('a nested block without & is a descendant', () => {
  assert.deepEqual(
    rules(expand('.x', 'svg { width: 20px; }')),
    ['.x svg { width: 20px; }'],
  );
});

/* ::before carries no declarations of its own on the parent - a block that is ONLY a nested rule
 * must not emit an empty `.x { }`, which some minifiers keep and every devtools shows. */
test('a block with no declarations of its own emits no rule for itself', () => {
  assert.deepEqual(
    rules(expand('.x', '&::before { content: ""; }')),
    ['.x::before { content: ""; }'],
  );
});

test('a comma-separated prelude replaces & in every branch', () => {
  assert.deepEqual(
    rules(expand('.x', '& b, & i { font-weight: 600; }')),
    ['.x b, .x i { font-weight: 600; }'],
  );
});

/* The one that brace-counting exists for: a regex looking for the next `}` stops at the inner one
 * and hands the rest of the file back as a declaration. */
test('a media query wraps the selector, and nests further inside it', () => {
  assert.deepEqual(
    rules(expand('.x', 'display: none; @media (orientation: portrait) { display: flex; & b { color: red; } }')),
    ['.x { display: none; }', '@media (orientation: portrait) {', '.x { display: flex; }', '.x b { color: red; }', '}'],
  );
});

test('declarations written after a nested block still belong to the block itself', () => {
  assert.deepEqual(
    rules(expand('.x', 'color: red; & b { color: blue; } gap: 4px;')),
    ['.x { color: red; gap: 4px; }', '.x b { color: blue; }'],
  );
});

test('$key resolves to another rule in the same call', () => {
  const styles = css('T', { row: '& $letter { color: red; }', letter: 'font-size: 9px;' });
  assert.match(
    document.querySelector('[data-styles="T"]')!.textContent!,
    new RegExp(`\\.${styles.row} \\.${styles.letter} \\{ color: red; \\}`),
  );
});

/* Silently producing a rule that matches nothing is the failure this whole file guards against, so
 * a name that is not a key is an error rather than a passthrough. */
test('$key throws on a name that is not a style', () => {
  assert.throws(() => css('U', { row: '& $nope { color: red; }' }), /\$nope is not one of its styles/);
});

/* Trailing CSS is written last on purpose - it is where a rule goes that is only correct because
 * everything it overrides comes before it. */
test('trailing css is emitted after every rule, with $key still resolved', () => {
  const styles = css('V', { a: 'color: red;', b: 'color: blue;' }, '$a b:disabled { color: grey; }');
  const text = document.querySelector('[data-styles="V"]')!.textContent!;
  assert.ok(text.indexOf(`.${styles.b} {`) < text.indexOf(`.${styles.a} b:disabled`), 'trailing came last');
});

test('class names carry the component and the key, so devtools says where a rule lives', () => {
  const styles = css('Rail', { item: 'color: red;' });
  assert.match(styles.item, /^Rail_item_[a-z0-9]{1,4}$/);
});

/* Found by the round trip off CSS modules, not by reading the code: every nested rule in this
 * codebase is preceded by the comment explaining it, which left `@media` not looking like an
 * at-rule at all - so the query became part of a selector that matched nothing. */
test('a comment before a nested block is not mistaken for part of the selector', () => {
  assert.deepEqual(
    rules(expand('.x', 'color: red; /* why */ @media (orientation: portrait) { color: blue; }')),
    ['.x { color: red; }', '@media (orientation: portrait) {', '.x { color: blue; }', '}'],
  );
});

test('a comment before a nested selector is dropped rather than shipped inside it', () => {
  assert.deepEqual(
    rules(expand('.x', '/* why */ &:hover { color: blue; }')),
    ['.x:hover { color: blue; }'],
  );
});
