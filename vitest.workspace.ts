import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  // ---------- Key tests: in-process routing + dynamic DATABASE_URL ----------
  {
    test: {
      name: "key",
      include: ["tests/key/*.test.ts"],
      environment: "node",
      testTimeout: 30_000,
      sequence: { concurrent: false },
      fileParallelism: false,
      maxWorkers: 1,
      minWorkers: 1,
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
      setupFiles: ["./tests/server/key-server-setup.ts"],
      env: {
        NODE_ENV: "test",
        SKIP_CSRF_CHECK: "true",
        ENABLE_TEST_ROUTES: "true",
        APP_ENCRYPTION_KEY:
          process.env.APP_ENCRYPTION_KEY ??
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        WIRE_MODE: "fixtures",
        DATABASE_URL: process.env.DATABASE_URL ?? "file:./local.db",
        PREDMKT_KEY_TEST: "true",
      },
      deps: {
        optimizer: {
          ssr: {
            include: ["next-auth", "@auth/core", "@auth/drizzle-adapter"],
          },
        },
      },
    },
  },

  // ---------- Watched-question CRUD tests: in-process routing + dynamic DATABASE_URL ----------
  {
    test: {
      name: "watched",
      include: ["tests/watched/*.test.ts"],
      environment: "node",
      testTimeout: 30_000,
      sequence: { concurrent: false },
      fileParallelism: false,
      maxWorkers: 1,
      minWorkers: 1,
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
      // Re-uses key-server-setup.ts which intercepts fetch() to localhost:3000
      // and routes to in-process handlers. The watched-question server setup
      // extends this by adding /api/watched routing (task-watched-server-setup.ts
      // will be created by task-watched-backend). Until that file exists, the
      // setup falls back to key-server-setup.ts which returns 404 for /api/watched
      // — causing all these tests to fail as expected in Mode 1.
      setupFiles: ["./tests/server/watched-server-setup.ts"],
      env: {
        NODE_ENV: "test",
        SKIP_CSRF_CHECK: "true",
        ENABLE_TEST_ROUTES: "true",
        APP_ENCRYPTION_KEY:
          process.env.APP_ENCRYPTION_KEY ??
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        WIRE_MODE: "fixtures",
        DATABASE_URL: process.env.DATABASE_URL ?? "file:./local.db",
        // Must be "true" so runSeed() in each test inserts FIXTURE_USER_B and
        // seeds the session for user B (required by isolation tests).
        PREDMKT_KEY_TEST: "true",
      },
      deps: {
        optimizer: {
          ssr: {
            include: ["next-auth", "@auth/core", "@auth/drizzle-adapter"],
          },
        },
      },
    },
  },

  // ---------- Cron tests: each test uses a temp DB via runSeed ----------
  {
    test: {
      name: "cron",
      include: ["tests/cron/*.test.ts"],
      environment: "node",
      testTimeout: 60_000,
      sequence: { concurrent: false },
      fileParallelism: false,
      maxWorkers: 1,
      minWorkers: 1,
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
      setupFiles: ["./tests/server/matching-setup.ts"],
      env: {
        NODE_ENV: "test",
        SKIP_CSRF_CHECK: "true",
        APP_ENCRYPTION_KEY:
          process.env.APP_ENCRYPTION_KEY ??
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        WIRE_MODE: "fixtures",
        DATABASE_URL: process.env.DATABASE_URL ?? "file:./local.db",
        CRON_SECRET: "test-cron-secret-do-not-use-in-prod",
        PREDMKT_CRON_TEST: "true",
      },
    },
  },

  // ---------- Auth tests: server-setup.ts provides fetch intercept ----------
  {
    test: {
      name: "auth",
      include: ["tests/auth/*.test.ts"],
      exclude: ["tests/auth/*.spec.ts"],
      environment: "node",
      testTimeout: 30_000,
      hookTimeout: 30_000,
      isolate: true,
      sequence: { concurrent: false },
      globals: true,
      clearMocks: false,
      mockReset: false,
      pool: "threads",
      setupFiles: ["./tests/auth/server-setup.ts"],
      env: {
        NODE_ENV: "test",
        SKIP_CSRF_CHECK: "true",
        TEST_BASE_URL: process.env.TEST_BASE_URL ?? "http://localhost:3000",
        NEXTAUTH_URL: process.env.NEXTAUTH_URL ?? "http://localhost:3000",
        NEXTAUTH_SECRET:
          process.env.NEXTAUTH_SECRET ?? "test-secret-do-not-use-in-prod",
        AUTH_SECRET:
          process.env.AUTH_SECRET ?? "test-secret-for-vitest-do-not-use-in-prod",
        DATABASE_URL: process.env.DATABASE_URL ?? "file:./local.db",
        APP_ENCRYPTION_KEY:
          process.env.APP_ENCRYPTION_KEY ??
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        RESEND_API_KEY: "re_test_placeholder",
      },
      deps: {
        inline: ["next-auth", "@auth/core", "@auth/drizzle-adapter"],
      },
    },
  },

  // ---------- Per-question threshold tests: temp DBs + Resend mock ----------
  {
    test: {
      name: "thresholds",
      include: ["tests/thresholds/*.test.ts"],
      environment: "node",
      testTimeout: 60_000,
      sequence: { concurrent: false },
      fileParallelism: false,
      maxWorkers: 1,
      minWorkers: 1,
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
      globals: true,
      clearMocks: false,
      mockReset: false,
      setupFiles: ["./tests/server/threshold-server-setup.ts"],
      env: {
        NODE_ENV: "test",
        SKIP_CSRF_CHECK: "true",
        APP_ENCRYPTION_KEY:
          process.env.APP_ENCRYPTION_KEY ??
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        WIRE_MODE: "fixtures",
        DATABASE_URL: process.env.DATABASE_URL ?? "file:./local.db",
        CRON_SECRET: "test-cron-secret-do-not-use-in-prod",
        RESEND_API_KEY: "re_test_placeholder",
        PREDMKT_CRON_TEST: "true",
        TEST_BASE_URL: "http://localhost:3000",
      },
    },
  },

  // ---------- Alert dispatch tests: temp DBs + Resend mock ----------
  {
    test: {
      name: "alerts",
      include: ["tests/alerts/*.test.ts"],
      environment: "node",
      testTimeout: 60_000,
      sequence: { concurrent: false },
      fileParallelism: false,
      maxWorkers: 1,
      minWorkers: 1,
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
      globals: true,
      clearMocks: false,
      mockReset: false,
      setupFiles: ["./tests/server/matching-setup.ts"],
      env: {
        NODE_ENV: "test",
        SKIP_CSRF_CHECK: "true",
        APP_ENCRYPTION_KEY:
          process.env.APP_ENCRYPTION_KEY ??
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        WIRE_MODE: "fixtures",
        DATABASE_URL: process.env.DATABASE_URL ?? "file:./local.db",
        CRON_SECRET: "test-cron-secret-do-not-use-in-prod",
        RESEND_API_KEY: "re_test_placeholder",
        PREDMKT_CRON_TEST: "true",
      },
    },
  },

  // ---------- Multiuser isolation tests: in-process routing + dynamic DATABASE_URL ----------
  {
    test: {
      name: "multiuser",
      include: ["tests/multiuser/*.test.ts"],
      environment: "node",
      testTimeout: 60_000,
      sequence: { concurrent: false },
      fileParallelism: false,
      maxWorkers: 1,
      minWorkers: 1,
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
      setupFiles: ["./tests/server/watched-server-setup.ts"],
      globals: true,
      clearMocks: false,
      mockReset: false,
      env: {
        NODE_ENV: "test",
        SKIP_CSRF_CHECK: "true",
        ENABLE_TEST_ROUTES: "true",
        APP_ENCRYPTION_KEY:
          process.env.APP_ENCRYPTION_KEY ??
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        WIRE_MODE: "fixtures",
        DATABASE_URL: process.env.DATABASE_URL ?? "file:./local.db",
        CRON_SECRET: "test-cron-secret-do-not-use-in-prod",
        RESEND_API_KEY: "re_test_placeholder",
        PREDMKT_KEY_TEST: "true",
        PREDMKT_MULTIUSER_TEST: "true",
      },
      deps: {
        inline: ["next-auth", "@auth/core", "@auth/drizzle-adapter"],
      },
    },
  },

  // ---------- Web-push tests: temp DBs + web-push mock + Resend mock ----------
  {
    test: {
      name: "webpush",
      include: ["tests/webpush/*.test.ts"],
      environment: "node",
      testTimeout: 60_000,
      sequence: { concurrent: false },
      fileParallelism: false,
      maxWorkers: 1,
      minWorkers: 1,
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
      globals: true,
      clearMocks: false,
      mockReset: false,
      setupFiles: ["./tests/server/watched-server-setup.ts"],
      env: {
        NODE_ENV: "test",
        SKIP_CSRF_CHECK: "true",
        ENABLE_TEST_ROUTES: "true",
        APP_ENCRYPTION_KEY:
          process.env.APP_ENCRYPTION_KEY ??
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        WIRE_MODE: "fixtures",
        DATABASE_URL: process.env.DATABASE_URL ?? "file:./local.db",
        CRON_SECRET: "test-cron-secret-do-not-use-in-prod",
        RESEND_API_KEY: "re_test_placeholder",
        PREDMKT_CRON_TEST: "true",
        PREDMKT_SEED_MATCHES: "true",
        PREDMKT_KEY_TEST: "true",
        TEST_BASE_URL: "http://localhost:3000",
        VAPID_PUBLIC_KEY:
          "BNbvRKWoFPJRnP9cG4bYrBEGD7s9xDLjS5Ydb6z8w8P2X0ZlV2QsNTaUJ9xYCvBpfD0PgXkVzYX2ZvBwBEDmwrY=",
        VAPID_PRIVATE_KEY: "testVapidPrivateKeyBase64urlEncoded1234",
        VAPID_SUBJECT: "mailto:test@arbwatch.test",
      },
      deps: {
        optimizer: {
          ssr: {
            include: ["next-auth", "@auth/core", "@auth/drizzle-adapter"],
          },
        },
      },
    },
  },

  // ---------- Embedding tests: fixture-mode embeddings + temp DBs ----------
  {
    test: {
      name: "embedding",
      include: ["tests/embedding/*.test.ts"],
      environment: "node",
      testTimeout: 60_000,
      sequence: { concurrent: false },
      fileParallelism: false,
      maxWorkers: 1,
      minWorkers: 1,
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
      setupFiles: ["./tests/server/matching-setup.ts"],
      env: {
        NODE_ENV: "test",
        SKIP_CSRF_CHECK: "true",
        APP_ENCRYPTION_KEY:
          process.env.APP_ENCRYPTION_KEY ??
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        WIRE_MODE: "fixtures",
        DATABASE_URL: process.env.DATABASE_URL ?? "file:./local.db",
        CRON_SECRET: "test-cron-secret-do-not-use-in-prod",
        PREDMKT_CRON_TEST: "true",
        // No OPENAI_API_KEY — embeddings served from fixture files
      },
    },
  },

  // ---------- Billing schema tests: temp DBs, plan/stripe_customer_id columns ----------
  {
    test: {
      name: "billing",
      include: ["tests/billing/*.test.ts"],
      environment: "node",
      testTimeout: 60_000,
      sequence: { concurrent: false },
      fileParallelism: false,
      maxWorkers: 1,
      minWorkers: 1,
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
      setupFiles: ["./tests/server/matching-setup.ts"],
      env: {
        NODE_ENV: "test",
        APP_ENCRYPTION_KEY:
          process.env.APP_ENCRYPTION_KEY ??
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        WIRE_MODE: "fixtures",
        DATABASE_URL: process.env.DATABASE_URL ?? "file:./local.db",
        PREDMKT_CRON_TEST: "true",
      },
    },
  },

  // ---------- SSO tests: Google OAuth provider (mirrors auth project config) ----------
  {
    test: {
      name: "sso",
      include: ["tests/sso/*.test.ts"],
      environment: "node",
      testTimeout: 30_000,
      hookTimeout: 30_000,
      isolate: true,
      sequence: { concurrent: false },
      globals: true,
      clearMocks: false,
      mockReset: false,
      pool: "threads",
      setupFiles: ["./tests/auth/server-setup.ts"],
      env: {
        NODE_ENV: "test",
        SKIP_CSRF_CHECK: "true",
        TEST_BASE_URL: process.env.TEST_BASE_URL ?? "http://localhost:3000",
        NEXTAUTH_URL: process.env.NEXTAUTH_URL ?? "http://localhost:3000",
        NEXTAUTH_SECRET:
          process.env.NEXTAUTH_SECRET ?? "test-secret-do-not-use-in-prod",
        AUTH_SECRET:
          process.env.AUTH_SECRET ?? "test-secret-for-vitest-do-not-use-in-prod",
        DATABASE_URL: process.env.DATABASE_URL ?? "file:./local.db",
        APP_ENCRYPTION_KEY:
          process.env.APP_ENCRYPTION_KEY ??
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        RESEND_API_KEY: "re_test_placeholder",
        GOOGLE_CLIENT_ID: "test-google-client-id",
        GOOGLE_CLIENT_SECRET: "test-google-client-secret",
      },
      deps: {
        inline: ["next-auth", "@auth/core", "@auth/drizzle-adapter"],
      },
    },
  },

  // ---------- History tests: temp DBs + PREDMKT_SEED_MATCHES for question_matches ----------
  {
    test: {
      name: "history",
      include: ["tests/history/*.test.ts"],
      environment: "node",
      testTimeout: 60_000,
      sequence: { concurrent: false },
      fileParallelism: false,
      maxWorkers: 1,
      minWorkers: 1,
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
      setupFiles: ["./tests/server/matching-setup.ts"],
      env: {
        NODE_ENV: "test",
        SKIP_CSRF_CHECK: "true",
        APP_ENCRYPTION_KEY:
          process.env.APP_ENCRYPTION_KEY ??
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        WIRE_MODE: "fixtures",
        DATABASE_URL: process.env.DATABASE_URL ?? "file:./local.db",
        CRON_SECRET: "test-cron-secret-do-not-use-in-prod",
        // Flag that causes seed.ts to insert question_matches for matching questions.
        // Cron tests insert their own per-describe-block; history DoD #2 needs them seeded.
        PREDMKT_SEED_MATCHES: "true",
      },
    },
  },

  // ---------- All other tests: matching-setup seeds local.db ----------
  {
    test: {
      name: "other",
      include: ["tests/**/*.test.ts"],
      exclude: [
        "tests/**/*.spec.ts",
        "tests/key/*.test.ts",
        "tests/watched/*.test.ts",
        "tests/cron/*.test.ts",
        "tests/auth/*.test.ts",
        "tests/alerts/*.test.ts",
        "tests/thresholds/*.test.ts",
        "tests/multiuser/*.test.ts",
        "tests/history/*.test.ts",
        "tests/webpush/*.test.ts",
        "tests/embedding/*.test.ts",
        "tests/billing/*.test.ts",
        "tests/sso/*.test.ts",
        "node_modules/**",
      ],
      environment: "node",
      testTimeout: 30_000,
      sequence: { concurrent: false },
      setupFiles: ["./tests/server/matching-setup.ts"],
      env: {
        NODE_ENV: "test",
        SKIP_CSRF_CHECK: "true",
        APP_ENCRYPTION_KEY:
          process.env.APP_ENCRYPTION_KEY ??
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        WIRE_MODE: "fixtures",
        DATABASE_URL: process.env.DATABASE_URL ?? "file:./local.db",
        CRON_SECRET: "test-cron-secret-do-not-use-in-prod",
      },
    },
  },
]);
