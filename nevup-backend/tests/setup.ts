// Enforces a consistent environment for all test suites
process.env.NODE_ENV = "test";

// Extends the default timeout to accommodate cold starts in containerized or CI environments
jest.setTimeout(30000);

// Redirect infrastructure endpoints to localhost for host-based test execution
// but ONLY if we are not already running inside a Docker container.
const isDocker = require('fs').existsSync('/.dockerenv');
if (!isDocker) {
  process.env.DATABASE_URL = process.env.DATABASE_URL?.replace("@db:", "@localhost:5433") 
    || process.env.DATABASE_URL?.replace("@localhost:5432", "@localhost:5433")
    || "postgres://postgres:postgres@localhost:5433/nevup";
  process.env.REDIS_URL = process.env.REDIS_URL?.replace("//redis:", "//localhost:") || "redis://localhost:6379";
}
