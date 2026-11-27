import { describe, expect, it } from 'vitest'

import { looksLikeMarkdown } from './user-message-markdown'

describe('looksLikeMarkdown', () => {
  it.each([
    '# Judul',
    '- satu\n- dua',
    '1. satu',
    '```ts\nconst a = 1\n```',
    'pakai `foo` ya',
    'ini **tebal**',
    '[x](https://a.com)',
    '> kutipan',
    '| a | b |\n|---|---|'
  ])('detects %j', (text) => {
    expect(looksLikeMarkdown(text)).toBe(true)
  })

  it.each([
    'halo',
    'baris satu\nbaris dua',
    'harga 5 * 3 = 15',
    '#hashtag'
  ])('keeps %j as plain text', (text) => {
    expect(looksLikeMarkdown(text)).toBe(false)
  })
})
