const MARKDOWN_SIGNALS: readonly RegExp[] = [
  /^ {0,3}```/m, // fenced code
  /^ {0,3}#{1,6}[ \t]+\S/m, // heading
  /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+\S/m, // list
  /^ {0,3}>[ \t]?\S/m, // blockquote
  /^ {0,3}\|.+\|[ \t]*$/m, // table row
  /`[^`\n]+`/, // inline code
  /\*\*[^*\n]+\*\*|__[^_\n]+__/, // bold
  /\[[^\]\n]+\]\([^)\n]+\)/ // link
]

/**
 * True when a user message holds Markdown worth rendering. Plain text keeps the
 * `whitespace-pre-wrap` path, because Markdown would fold its single newlines.
 */
export function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_SIGNALS.some((re) => re.test(text))
}
