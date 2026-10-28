import { describe, expect, it } from 'vitest';
import { normalizeRemoteUrl, remoteBranch } from './remote.js';

const hosts = ['github.com', 'gitlab.com'];

describe('normalizeRemoteUrl', () => {
  it('accepts repositories of the allowed hosts', () => {
    expect(normalizeRemoteUrl('https://github.com/ada/these', hosts)).toBe(
      'https://github.com/ada/these',
    );
    expect(normalizeRemoteUrl(' https://GitHub.com/ada/these.git/ ', hosts)).toBe(
      'https://github.com/ada/these.git',
    );
    expect(normalizeRemoteUrl('https://gitlab.com/labo/equipe/these', hosts)).toBe(
      'https://gitlab.com/labo/equipe/these',
    );
  });

  it('refuses other hosts, schemes, credentials and odd paths', () => {
    for (const url of [
      'https://evil.example/ada/these',
      'https://github.com.evil.example/ada/these',
      'http://github.com/ada/these',
      'ssh://git@github.com/ada/these',
      'file:///etc/passwd',
      'https://token@github.com/ada/these',
      'https://github.com/ada/these?x=1',
      'https://github.com/ada',
      'https://github.com/ada/../these',
      'https://github.com:8443/ada/these',
      'not a url',
    ]) {
      expect(normalizeRemoteUrl(url, hosts), url).toBeNull();
    }
  });

  it('accepts HTTP and a port only when the instance allows them', () => {
    expect(normalizeRemoteUrl('http://127.0.0.1:8080/git/abc', ['127.0.0.1:8080'])).toBeNull();
    expect(normalizeRemoteUrl('http://127.0.0.1:8080/git/abc', ['127.0.0.1:8080'], true)).toBe(
      'http://127.0.0.1:8080/git/abc',
    );
  });
});

describe('remoteBranch', () => {
  it('accepts usual names and refuses options and revision syntax', () => {
    for (const name of ['main', 'master', 'feature/plan', 'v1.2']) {
      expect(remoteBranch.safeParse(name).success, name).toBe(true);
    }
    for (const name of ['-f', 'a..b', 'a//b', 'x.lock', 'a/', 'HEAD~1', 'a b', 'a:b', '']) {
      expect(remoteBranch.safeParse(name).success, name).toBe(false);
    }
  });
});

describe('GIT_SYNC_HOSTS', () => {
  it('defaults to GitHub and GitLab and reads a comma-separated list', async () => {
    const { apiEnv } = await import('./env.js');
    const base = {
      DATABASE_URL: 'postgres://u:p@localhost/db',
      VALKEY_URL: 'redis://localhost:6379',
      S3_ENDPOINT: 'http://localhost:8333',
      S3_ACCESS_KEY_ID: 'key',
      S3_SECRET_ACCESS_KEY: 'secret-key',
      S3_BUCKET: 'galley',
    };
    expect(apiEnv.parse(base).GIT_SYNC_HOSTS).toEqual(['github.com', 'gitlab.com']);
    expect(
      apiEnv.parse({ ...base, GIT_SYNC_HOSTS: ' GitHub.com, git.example.org ,' }).GIT_SYNC_HOSTS,
    ).toEqual(['github.com', 'git.example.org']);
  });
});
