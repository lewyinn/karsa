/**
 * CommonMark rejects a link destination that holds a space unless it is wrapped
 * in `<...>`, so `[x](file:///D:/Code Programming/a.php)` renders as raw text.
 * Agents write such links for Windows paths. Encode the spaces (`%20`) before
 * parsing; the file-link handlers already `decodeURI` the destination.
 *
 * Fenced and inline code are left alone. A still-streaming link with no closing
 * `)` yet is not matched, so it is rewritten once it completes.
 */
const FILE_LINK_WITH_SPACES_RE = /\]\(([ \t]*file:\/\/[^)\n<>]*[ \t][^)\n<>]*)\)/gi
const CODE_SPAN_RE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g

function encodeFileLinkSpaces(segment: string): string {
  return segment.replace(FILE_LINK_WITH_SPACES_RE, (_match, url: string) => {
    return `](${url.trim().replace(/ /g, '%20').replace(/\t/g, '%09')})`
  })
}

export function encodeSpacesInFileLinks(markdown: string): string {
  if (!markdown.includes('file://')) return markdown
  return markdown
    .split(CODE_SPAN_RE)
    .map((part, i) => (i % 2 === 1 ? part : encodeFileLinkSpaces(part)))
    .join('')
}
