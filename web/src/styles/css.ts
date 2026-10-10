/** A component's styles, written in the component's own file. */

/** Emitted at module evaluation, so a stylesheet cannot be missing when its component first renders. */
function inject(name: string, text: string) {
  // No document under a non-DOM test runner; nothing to style, and nothing to fail over.
  if (typeof document === 'undefined') return;
  const element = document.createElement('style');
  element.dataset.styles = name;
  element.textContent = text;
  document.head.append(element);
}

/** Short, stable and only needs to differ - not a checksum. */
function hash(text: string): string {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(36).slice(0, 4);
}

/** A block's own declarations, and the `prelude {... */
function split(block: string): { declarations: string; nested: Array<[string, string]> } {
  const nested: Array<[string, string]> = [];
  let declarations = '';
  let pending = '';
  let index = 0;

  while (index < block.length) {
    if (block[index] !== '{') {
      pending += block[index];
      index += 1;
      continue;
    }

    /** Everything since the last `;` or `}` is this group's selector; everything before that is a declaration belonging to the block itself. */
    const cut = Math.max(pending.lastIndexOf(';'), pending.lastIndexOf('}'));
    declarations += pending.slice(0, cut + 1);
    /** Comments are dropped from a SELECTOR, not merely ignored. */
    const prelude = pending.slice(cut + 1).replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
    pending = '';

    let depth = 1;
    let end = index + 1;
    for (; end < block.length && depth > 0; end += 1) {
      if (block[end] === '{') depth += 1;
      else if (block[end] === '}') depth -= 1;
    }
    nested.push([prelude, block.slice(index + 1, end - 1)]);
    index = end;
  }

  return { declarations: declarations + pending, nested };
}

/** One block, flattened into real CSS rules under `selector`. */
function expand(selector: string, block: string): string {
  const { declarations, nested } = split(block);
  const body = declarations.trim();
  let out = body ? `${selector} { ${body} }\n` : '';

  for (const [prelude, inner] of nested) {
    if (prelude.startsWith('@')) {
      // An at-rule WRAPS this selector rather than nesting under it.
      out += `${prelude} {\n${expand(selector, inner)}}\n`;
      continue;
    }
    // `&` is this rule; a prelude without one is a descendant of it.
    out += expand(
      prelude.includes('&') ? prelude.replaceAll('&', selector) : `${selector} ${prelude}`,
      inner,
    );
  }

  return out;
}

export function css<T extends Record<string, string>>(
  name: string,
  rules: T,
  trailing = '',
): { [K in keyof T]: string } {
  const suffix = hash(name + JSON.stringify(rules) + trailing);
  const names = Object.fromEntries(
    Object.keys(rules).map((key) => [key, `${name}_${key}_${suffix}`]),
  ) as { [K in keyof T]: string };

  /** A `$key` reference is resolved before anything is parsed, so by the time a selector is built it is already an ordinary class name. */
  const resolve = (text: string) => text.replace(/\$([A-Za-z]\w*)/g, (_, key: string) => {
    if (!(key in names)) throw new Error(`${name}: $${key} is not one of its styles`);
    return `.${names[key]}`;
  });

  let text = '';
  for (const [key, block] of Object.entries(rules)) {
    text += expand(`.${names[key]}`, resolve(block));
  }
  // Last, which is the whole point of it - see the doc comment.
  if (trailing.trim()) text += `${resolve(trailing).trim()}\n`;

  inject(name, text);
  return names;
}

/** The expansion on its own, for tests and for the migration's round-trip check. */
export const expandForTest = expand;
