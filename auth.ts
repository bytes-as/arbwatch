import NextAuth from "next-auth";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { skipCSRFCheck } from "@auth/core";
import { Resend } from "resend";
import { getDb } from "./db/client";
import {
  users,
  accounts,
  sessions,
  verificationTokens,
} from "./db/schema";

const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds
const TOKEN_MAX_AGE = 15 * 60; // 15 minutes in seconds

const resend = new Resend(process.env.RESEND_API_KEY ?? "re_placeholder");

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(getDb(), {
    usersTable: users as any,
    accountsTable: accounts as any,
    sessionsTable: sessions as any,
    verificationTokensTable: verificationTokens as any,
  }),
  providers: [
    {
      id: "email",
      type: "email",
      name: "Email",
      from: process.env.EMAIL_FROM ?? "ArbWatch <noreply@arbwatch.test>",
      maxAge: TOKEN_MAX_AGE,
      async sendVerificationRequest({ identifier, url, provider }) {
        const emailPayload = {
          from: provider.from ?? "ArbWatch <noreply@arbwatch.test>",
          to: identifier,
          subject: "Sign in to ArbWatch",
          html: `<p>Click the link below to sign in to ArbWatch:</p><p><a href="${url}">${url}</a></p><p>This link expires in 15 minutes.</p>`,
          text: `Sign in to ArbWatch: ${url}\n\nThis link expires in 15 minutes.`,
        };

        // Populate the global inbox for Playwright / dev server tests
        if (process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development") {
          if (typeof global !== "undefined") {
            if (!(global as any).__testResendInbox) {
              (global as any).__testResendInbox = [];
            }
            (global as any).__testResendInbox.push(emailPayload);
          }
        }

        await resend.emails.send(emailPayload);
      },
    },
  ],
  pages: {
    signIn: "/signin",
    verifyRequest: "/check-email",
    error: "/signin",
    newUser: "/onboarding/key",
  },
  session: {
    strategy: "database",
    maxAge: SESSION_MAX_AGE,
  },
  cookies: {
    sessionToken: {
      name: "next-auth.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax" as const,
        path: "/",
        secure: process.env.NODE_ENV === "production",
        maxAge: SESSION_MAX_AGE,
      },
    },
  },
  // Skip CSRF validation only when SKIP_CSRF_CHECK=true is explicitly set.
  // This var must never appear in staging or production environments.
  ...(process.env.SKIP_CSRF_CHECK === "true" ? { skipCSRFCheck } : {}),
  callbacks: {
    async redirect({ url, baseUrl }) {
      if (url.startsWith(baseUrl)) return url;
      if (url.startsWith("/")) return `${baseUrl}${url}`;
      return baseUrl;
    },
  },
});
