/** HTML that has already been escaped/assembled and may be inserted verbatim. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"'`]/g, (c) => ESCAPES[c] ?? c);
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(value);
}

/**
 * Tagged template that escapes every interpolation unless it is {@link SafeHtml} (e.g. the
 * result of a nested `html` call). Arrays are rendered item by item; null/undefined/false
 * render as nothing. This is the only way views build markup.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? '';
  values.forEach((value, i) => {
    out += render(value) + (strings[i + 1] ?? '');
  });
  return new SafeHtml(out);
}

/** Marks trusted markup (e.g. a server-generated SVG) as safe. Never pass user input. */
export function trusted(markup: string): SafeHtml {
  return new SafeHtml(markup);
}
