// web/listing-html.js is a plain script attaching `ListingHtml` to globalThis.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../web/listing-html.js';

const { sanitize } = globalThis.ListingHtml;
const eq = (input, want) => assert.equal(sanitize(input), want);
// Any `<` in output must begin an emitted allowlisted tag.
const onlyAllowedTags = out => {
  for (const m of out.matchAll(/<[^>]*>?/g)) {
    assert.match(m[0], /^<\/?(p|br|strong|b|em|i|ul|ol|li)>$|^<a href="(https?:|mailto:)[^"<>]*" target="_blank" rel="noopener">$|^<\/a>$/i, 'unexpected tag: ' + m[0]);
  }
};

test('brief cases', () => {
  eq('<p>Hi <strong>there</strong></p>', '<p>Hi <strong>there</strong></p>');
  eq('<script>alert(1)</script><p>x</p>', '<p>x</p>');
  eq('<p onclick="x">y</p>', '<p>y</p>');
  eq('<a href="javascript:alert(1)">z</a>', 'z');
  eq('<a href="https://e.com">l</a>', '<a href="https://e.com" target="_blank" rel="noopener">l</a>');
  eq('<div><span>t</span></div>', 't');
});
test('nested/split script tags stay inert', () => {
  const out = sanitize('<scr<script>ipt>alert(1)</scr</script>ipt>');
  onlyAllowedTags(out);
  assert.ok(!/<script/i.test(out));
});
test('uppercase tags and attrs are canonicalised', () => {
  eq('<SCRIPT>alert(1)</SCRIPT><P>x</P>', '<p>x</p>');
  eq('<A HREF="HTTPS://e.com">l</A>', '<a href="HTTPS://e.com" target="_blank" rel="noopener">l</a>');
  eq('<STRONG>s</STRONG>', '<strong>s</strong>');
});
test('unquoted attributes', () => {
  eq('<a href=https://e.com onclick=x>l</a>', '<a href="https://e.com" target="_blank" rel="noopener">l</a>');
  eq('<p onclick=alert(1)>y</p>', '<p>y</p>');
});
test('javascript: hrefs are unwrapped, however disguised', () => {
  for (const h of [' javascript:alert(1)', '\tjava\nscript:alert(1)', '&#106;avascript:alert(1)', '&#x6A;avascript:alert(1)',
    'JaVaScRiPt:alert(1)', '\u0001javascript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', '//evil.com', '/relative', '']) {
    eq(`<a href="${h}">z</a>`, 'z');
    eq(`<a href='${h}'>z</a>`, 'z');
  }
  eq('<a>z</a>', 'z');
  eq('<a href>z</a>', 'z');
});
test('safe href with entity-encoded chars is re-escaped', () => {
  eq('<a href="https://e.com/?a=1&amp;b=2">l</a>', '<a href="https://e.com/?a=1&amp;b=2" target="_blank" rel="noopener">l</a>');
  eq('<a href="mailto:a@b.org">m</a>', '<a href="mailto:a@b.org" target="_blank" rel="noopener">m</a>');
  const out = sanitize('<a href="https://e.com/&quot;onmouseover=&quot;x">l</a>');
  onlyAllowedTags(out);
  assert.ok(!out.includes('onmouseover=x') && !/"onmouseover/.test(out));
});
test('quoted > inside an attribute does not end the tag early', () => {
  eq('<p title=">"><b>x</b></p>', '<p><b>x</b></p>');
  eq('<a href="https://e.com" title="<script>alert(1)</script>">l</a>', '<a href="https://e.com" target="_blank" rel="noopener">l</a>');
});
test('unclosed script/style drops everything after', () => {
  eq('<p>a</p><script>alert(1)<p>b</p>', '<p>a</p>');
  eq('<p>a</p><style>p{}<p>b</p>', '<p>a</p>');
  eq('<p>a</p><SCRIPT src=x>', '<p>a</p>');
});
test('style content removed', () => {
  eq('<style>body{display:none}</style><p>x</p>', '<p>x</p>');
});
test('comments dropped, unclosed comment drops the rest', () => {
  eq('<p>a<!-- <script>x</script> -->b</p>', '<p>ab</p>');
  eq('<p>a</p><!-- never closed <p>b</p>', '<p>a</p>');
});
test('malformed and unterminated tags', () => {
  eq('<p>a</p><img src=x onerror=alert(1)', '<p>a</p>');
  eq('<p>a</p><img src=x onerror=alert(1)>b', '<p>a</p>b');
  eq('1 < 2 and 3 > 2', '1 &lt; 2 and 3 &gt; 2');
  eq('<<p>x</p>', '&lt;<p>x</p>');
  eq('<p>a</', '<p>a&lt;/</p>');
});
test('br is canonical; close tags only for allowed open tags', () => {
  eq('a<BR/>b<br />c<br>d', 'a<br>b<br>c<br>d');
  eq('</br>x</div></p>', 'x');
  eq('<p>a</p></p>', '<p>a</p>');
});
test('unclosed allowed tags are closed at the end', () => {
  eq('<p><strong>a', '<p><strong>a</strong></p>');
  eq('<ul><li>a<li>b</ul>', '<ul><li>a<li>b</li></li></ul>');
});
test('text entities: well-formed refs pass through, bare specials are escaped', () => {
  eq('a &amp; b', 'a &amp; b');
  eq('It&rsquo;s &mdash; &copy;', 'It&rsquo;s &mdash; &copy;');
  eq('&nbsp;', '&nbsp;');
  eq('&lt;script&gt;alert(1)&lt;/script&gt;', '&lt;script&gt;alert(1)&lt;/script&gt;');
  eq('&#60;script&#62;', '&#60;script&#62;'); // renders as text "<script>", inert
  eq('&#x3C;b&#x3E;x', '&#x3C;b&#x3E;x');
  eq('AT&T & co', 'AT&amp;T &amp; co');
  eq('&x; &;', '&amp;x; &amp;;');
  eq('q "x" 1 < 2 > 0', 'q &quot;x&quot; 1 &lt; 2 &gt; 0');
  const once = sanitize('<p>a &amp; b &lt; c & d</p>');
  assert.equal(sanitize(once), once);
});
test('href: spaces after the scheme are percent-encoded, scheme whitespace tolerated only to reject', () => {
  eq('<a href="https://e.com/a b">l</a>', '<a href="https://e.com/a%20b" target="_blank" rel="noopener">l</a>');
  eq('<a href=" https://e.com">l</a>', '<a href="https://e.com" target="_blank" rel="noopener">l</a>');
  eq('<a href="java script:x">z</a>', 'z');
});
test('deep nesting is capped (unwrapped to text), output stays balanced', () => {
  const out = sanitize('<b>'.repeat(500) + 'x');
  assert.equal((out.match(/<b>/g) || []).length, 100);
  assert.equal((out.match(/<\/b>/g) || []).length, 100);
  assert.ok(out.includes('x'));
});
test('null/undefined/empty', () => {
  eq(null, ''); eq(undefined, ''); eq('', '');
});
