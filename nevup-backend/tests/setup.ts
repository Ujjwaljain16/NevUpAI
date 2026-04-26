// Enforces a consistent environment for all test suites
process.env.NODE_ENV = "test";

// Extends the default timeout to accommodate cold starts in containerized or CI environments
jest.setTimeout(30000);

// Suppress known non-critical logs during test runs to keep output clean and reviewer-readable
// (Can be expanded if specific infrastructure noise becomes distracting)
