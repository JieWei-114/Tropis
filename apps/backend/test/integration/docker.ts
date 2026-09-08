import { execSync } from 'child_process';

/**
 * Detect Docker availability at module-load time so suites can gracefully
 * skip (describe.skip) instead of exploding when Docker isn't running.
 */
function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/** Returns `describe` when Docker is up, otherwise `describe.skip` + warning. */
export function describeWithDocker(name: string): jest.Describe {
  if (isDockerAvailable()) return describe;

  console.warn(
    `[integration] Docker is not available — skipping suite "${name}". ` +
      'Start Docker to run integration tests.',
  );
  return describe.skip;
}
