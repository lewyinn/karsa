import { describe, expect, it } from 'vitest'

import { encodeSpacesInFileLinks } from './chat-markdown-file-url-spaces'

describe('encodeSpacesInFileLinks', () => {
  it('encodes spaces in a file:// destination', () => {
    expect(
      encodeSpacesInFileLinks(
        '[ `AuthServiceInterface` ](file:///D:/Code Programming/IoT-Platform/a.php), x'
      )
    ).toBe('[ `AuthServiceInterface` ](file:///D:/Code%20Programming/IoT-Platform/a.php), x')
  })

  it('handles several links on one line', () => {
    const out = encodeSpacesInFileLinks('[a](file:///D:/A B/a.php) and [b](file:///D:/C D/b.php)')
    expect(out).toBe('[a](file:///D:/A%20B/a.php) and [b](file:///D:/C%20D/b.php)')
  })

  it('leaves links without spaces, http links and plain text alone', () => {
    const text = '[a](file:///D:/x/a.php) [b](https://example.com/a b) hi'
    expect(encodeSpacesInFileLinks(text)).toBe(text)
  })

  it('does not touch code spans or fences', () => {
    const text = '`[a](file:///D:/A B/a.php)`\n```\n[a](file:///D:/A B/a.php)\n```'
    expect(encodeSpacesInFileLinks(text)).toBe(text)
  })

  it('ignores an unfinished streaming link', () => {
    const text = '[a](file:///D:/A B/a.p'
    expect(encodeSpacesInFileLinks(text)).toBe(text)
  })
})
