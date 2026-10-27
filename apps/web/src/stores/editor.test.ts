import { beforeEach, describe, expect, it } from 'vitest';
import { neighbourTab, useEditor } from './editor.js';

describe('editor tabs', () => {
  beforeEach(() => {
    useEditor.setState({ projectId: null, tabs: [], activeId: null });
    useEditor.getState().openProject('p');
  });

  it('opens, activates and closes tabs', () => {
    const { openTab, closeTab } = useEditor.getState();
    openTab('a');
    openTab('b');
    openTab('a');
    expect(useEditor.getState()).toMatchObject({ tabs: ['a', 'b'], activeId: 'a' });
    closeTab('a');
    expect(useEditor.getState()).toMatchObject({ tabs: ['b'], activeId: 'b' });
    closeTab('b');
    expect(useEditor.getState()).toMatchObject({ tabs: [], activeId: null });
  });

  it('drops tabs of deleted files and reveals places', () => {
    const { openTab, keepTabs, revealAt } = useEditor.getState();
    openTab('a');
    openTab('b');
    keepTabs(new Set(['a']));
    expect(useEditor.getState()).toMatchObject({ tabs: ['a'], activeId: 'a' });
    revealAt({ fileId: 'c', line: 3 });
    expect(useEditor.getState()).toMatchObject({ tabs: ['a', 'c'], activeId: 'c' });
    expect(useEditor.getState().reveal).toMatchObject({ fileId: 'c', line: 3 });
  });

  it('opens the target of an insertion and tells identical requests apart', () => {
    const { insert } = useEditor.getState();
    insert({ fileId: 'bib', text: '@book{a,}', at: 'end' });
    const first = useEditor.getState().insertion;
    expect(useEditor.getState()).toMatchObject({ tabs: ['bib'], activeId: 'bib' });
    expect(first).toMatchObject({ fileId: 'bib', text: '@book{a,}', at: 'end' });
    insert({ fileId: 'bib', text: '@book{a,}', at: 'end' });
    expect(useEditor.getState().insertion?.nonce).not.toBe(first?.nonce);
    useEditor.getState().openProject('q');
    expect(useEditor.getState().insertion).toBeNull();
  });

  it('resets on another project', () => {
    useEditor.getState().openTab('a');
    useEditor.getState().openProject('q');
    expect(useEditor.getState().tabs).toEqual([]);
  });

  it('picks the neighbour of a closed tab', () => {
    expect(neighbourTab(['a', 'b', 'c'], 'b')).toBe('c');
    expect(neighbourTab(['a', 'b', 'c'], 'c')).toBe('b');
    expect(neighbourTab(['a'], 'x')).toBeNull();
  });
});
