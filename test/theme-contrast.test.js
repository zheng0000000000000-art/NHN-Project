import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 라이트 테마에서 배경만 밝게 바꾸고 본문 색을 다크용 그대로 두면 글자가 안 보인다.
// 2026-07-27 관측: 토론 화면이 통째로 흰색으로 보여 사용자가 읽지 못했다(.discussion-message p),
// 같은 결함이 .ai-advice p 에도 있었다. 화면이 비어 보이는 것은 조용히 초록이 되는 것과 같다.
const LIGHT_HEX = /^#(?:[c-fC-F][0-9a-fA-F]{5})$/;

function sections(css) {
  const at = css.indexOf('color-scheme: light');
  assert.ok(at > 0, 'light theme block must exist');
  return { dark: css.slice(0, at), light: css.slice(at) };
}

// 규칙 한 줄에서 "선택자 { … color: #xxxxxx … }" 를 뽑는다.
function colorRules(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\.[^{]+?)\s*\{([^}]*)\}/);
    if (!m) continue;
    const color = m[2].match(/(?:^|[;\s])color:\s*(#[0-9a-fA-F]{6})/);
    if (color) out.push({ selector: m[1].trim(), color: color[1] });
  }
  return out;
}

test('a selector the light theme repaints must not keep a dark-theme text colour', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const { dark, light } = sections(css);

  // 라이트 테마가 밝은 배경으로 다시 칠하는 선택자들
  const repainted = new Set();
  for (const line of light.split('\n')) {
    const m = line.match(/^\s*(\.[^{]+?)\s*\{[^}]*background:\s*#[c-fC-F][0-9a-fA-F]{5}/);
    if (m) repainted.add(m[1].trim());
  }

  const lightColored = new Set(colorRules(light).map((rule) => rule.selector));
  const offenders = colorRules(dark)
    .filter((rule) => LIGHT_HEX.test(rule.color))
    .filter((rule) => {
      const base = rule.selector.replace(/\s+p$/, '').trim();
      return (repainted.has(base) || repainted.has(rule.selector)) && !lightColored.has(rule.selector);
    });

  assert.deepEqual(
    offenders.map((rule) => `${rule.selector} (${rule.color})`),
    [],
    '라이트 테마가 배경을 다시 칠하는 선택자는 글자색도 함께 정해야 한다',
  );
});

// 다크 모드가 라이트처럼 보이던 원인: 라이트 구역이 조건 없이 밝은 배경을 칠하는데
// 다크 구역에 같은 선택자가 없으면 그 부품만 흰 채로 남는다(2026-07-27: 대화창이 그랬다).
test('every light-painted component has a dark counterpart', async () => {
  const css = (await readFile(new URL('../public/styles.css', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const lightAt = css.indexOf('color-scheme: light');
  const darkAt = css.indexOf(':root[data-theme="dark"]');
  assert.ok(lightAt > 0 && darkAt > lightAt, 'both theme regions must exist');

  const parse = (text) => {
    const found = new Map();
    for (const match of text.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      for (const raw of match[1].split(',')) {
        const selector = raw.trim().replace(/\s+/g, ' ');
        if (selector) found.set(selector, (found.get(selector) ?? '') + match[2]);
      }
    }
    return found;
  };

  const light = parse(css.slice(lightAt, darkAt));
  const dark = new Set([...parse(css.slice(darkAt)).keys()]
    .map((selector) => selector.replace(':root[data-theme="dark"]', '').trim()));
  const lightBackground = /background(?:-color)?:\s*(#[c-fA-F][0-9a-fA-F]{5}|#fff\b|white)/;

  const uncovered = [...light].filter(([selector, body]) => lightBackground.test(body) && !dark.has(selector))
    .map(([selector]) => selector);
  assert.deepEqual(uncovered, [], '다크 테마가 되돌리지 않는 밝은 배경 부품이 남아 있다');
});
