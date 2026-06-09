import { describe, it, expect } from 'vitest';
import { extractJsxComponents } from '../../src/core/ingestion/vue-sfc-extractor.js';

describe('extractJsxComponents', () => {
  it('matches self-closing <Foo />', () => {
    const result = extractJsxComponents('<Foo />');
    expect(result).toContain('Foo');
  });

  it('matches opening <Foo>', () => {
    const result = extractJsxComponents('<Foo>child</Foo>');
    expect(result).toContain('Foo');
  });

  it('matches <Foo prop={x}>', () => {
    const result = extractJsxComponents('<MyCard active={true} />');
    expect(result).toContain('MyCard');
  });

  it('does not match lowercase HTML tags', () => {
    const result = extractJsxComponents('<div><span>text</span></div>');
    expect(result).not.toContain('div');
    expect(result).not.toContain('span');
  });

  it('deduplicates repeated usages', () => {
    const result = extractJsxComponents('<Foo /><Foo /><Foo />');
    expect(result.filter((c) => c === 'Foo')).toHaveLength(1);
  });

  it('extracts multiple distinct components', () => {
    const content = `
      <Parent>
        <MyCard active />
        <AnotherWidget foo="bar" />
        <div>ignored</div>
      </Parent>
    `;
    const result = extractJsxComponents(content);
    expect(result).toContain('Parent');
    expect(result).toContain('MyCard');
    expect(result).toContain('AnotherWidget');
    expect(result).not.toContain('div');
  });

  it('returns empty array for content with no PascalCase JSX tags', () => {
    const result = extractJsxComponents('<div><span>text</span></div>');
    expect(result).toHaveLength(0);
  });
});
