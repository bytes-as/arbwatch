// Re-export from the canonical mock so vi.mock("resend") and the direct import
// in tests/auth/*.test.ts share the same module instance and inbox array.
export * from "../tests/auth/__mocks__/resend";
export { default } from "../tests/auth/__mocks__/resend";
