import { describe, expect, it } from 'vitest';
import { checkBibtex } from './bibtex.js';

const codes = (text: string, others: string[] = []) =>
  checkBibtex(text, new Set(others)).issues.map(
    (issue) => `${issue.code}${issue.name === undefined ? '' : `:${issue.name}`}`,
  );

describe('checkBibtex', () => {
  it('accepts valid entries, strings, comments and concatenations', () => {
    const text = `Free text is a comment.
@string{ieee = "IEEE"}
@comment{anything {here}}
@article{knuth84,
  author = {Donald E. Knuth},
  title = "The {TeX}book",
  journal = ieee # " Transactions",
  year = 1984,
}
@book(lamport, title = {LaTeX})
@preamble{"\\newcommand{\\x}{y}"}
`;
    const result = checkBibtex(text);
    expect(result.issues).toEqual([]);
    expect(result.entries.map((entry) => entry.key)).toEqual(['knuth84', 'lamport']);
    const first = result.entries[0];
    expect(first && text.slice(first.from, first.to)).toBe('knuth84');
    const second = result.entries[1];
    expect(second && text.slice(second.start, second.end)).toBe('@book(lamport, title = {LaTeX})');
  });

  it('reports a missing key, a missing comma and a missing equals sign', () => {
    expect(codes('@article{, title = {A}}')).toEqual(['missingKey']);
    expect(codes('@article{title = {A}}')).toEqual(['missingKey']);
    expect(codes('@article{a,\n title = {A}\n year = 2000}')).toEqual(['expectedComma']);
    expect(codes('@article{a, title {A}}')).toEqual(['expectedEquals']);
  });

  it('reports unclosed values and entries, and resumes at the next entry', () => {
    expect(codes('@article{a, title = {A}\n@book{b, title = {B}}')).toEqual(['unclosedEntry']);
    expect(codes('@article{a, title = {A\n@book{b, title = {B}}\n@book{a2, title={C}}')).toEqual([
      'unclosedValue',
    ]);
    expect(
      checkBibtex('@article{a, title = {A\n@book{b, title = {B}}').entries.map((e) => e.key),
    ).toEqual(['a', 'b']);
  });

  it('reports duplicate fields and duplicate keys, here or in another file', () => {
    expect(codes('@misc{a, title={x}, Title={y}}')).toEqual(['duplicateField:Title']);
    expect(codes('@misc{a, title={x}}\n@misc{A, title={y}}')).toEqual(['duplicateKey:A']);
    expect(codes('@misc{a, title={x}}', ['a'])).toEqual(['duplicateKeyElsewhere:a']);
  });

  it('keeps issue spans inside the text', () => {
    for (const text of ['@article{', '@article{a, title = ', '@article{a, title = {x']) {
      for (const issue of checkBibtex(text).issues) {
        expect(issue.from).toBeGreaterThanOrEqual(0);
        expect(issue.to).toBeLessThanOrEqual(text.length);
        expect(issue.to).toBeGreaterThan(issue.from);
      }
    }
  });
});
