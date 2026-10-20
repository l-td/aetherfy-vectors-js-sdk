import { defined } from './defined';

describe('defined (the typed replacement for a non-null assertion)', () => {
  it.each([0, '', false, 'x', {}])('returns %j untouched', value => {
    expect(defined(value, 'the value')).toBe(value);
  });

  it.each([null, undefined])('fails naming what was missing (%s)', value => {
    expect(() => defined(value, 'the first hit')).toThrow(
      'expected the first hit to be defined'
    );
  });
});
