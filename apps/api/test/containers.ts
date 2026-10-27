import { existsSync } from 'node:fs';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

// Keep in sync with compose.yaml.
export const images = {
  postgres: 'postgres:16.15-alpine',
  valkey: 'valkey/valkey:8.1.10-alpine',
  seaweedfs: 'chrislusf/seaweedfs:4.50',
  languagetool:
    'erikvl87/languagetool:6.8@sha256:ef8fa12cbd485166c9ceeb7139d76d56d07707a624da6bb1fc1fbb5411750527',
} as const;

/**
 * Integration tests need Docker. Locally they are skipped when no daemon is
 * reachable; in CI a missing daemon must fail the run rather than hide a gap.
 */
export const dockerAvailable =
  Boolean(process.env.DOCKER_HOST) || existsSync('/var/run/docker.sock') || Boolean(process.env.CI);

export const S3_CREDENTIALS = { accessKeyId: 'galley-test', secretAccessKey: 'galley-test-secret' };

export function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer(images.postgres).start();
}

export function startValkey(): Promise<StartedTestContainer> {
  return new GenericContainer(images.valkey)
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
}

export function startSeaweedfs(): Promise<StartedTestContainer> {
  return new GenericContainer(images.seaweedfs)
    .withCommand(['server', '-s3', '-ip.bind=0.0.0.0'])
    .withEnvironment({
      AWS_ACCESS_KEY_ID: S3_CREDENTIALS.accessKeyId,
      AWS_SECRET_ACCESS_KEY: S3_CREDENTIALS.secretAccessKey,
    })
    .withExposedPorts(8333)
    .withWaitStrategy(Wait.forHttp('/healthz', 8333).forStatusCode(200))
    .start();
}

export function startLanguageTool(): Promise<StartedTestContainer> {
  return new GenericContainer(images.languagetool)
    .withEnvironment({ Java_Xms: '256m', Java_Xmx: '1g' })
    .withExposedPorts(8010)
    .withWaitStrategy(Wait.forHttp('/v2/languages', 8010).forStatusCode(200))
    .withStartupTimeout(180_000)
    .start();
}
