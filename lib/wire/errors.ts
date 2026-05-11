/**
 * lib/wire/errors.ts
 *
 * WireError class and error taxonomy per ADR-0002.
 * Tags: key-missing | key-invalid | quota-exhausted | transient | other | fixture-not-found
 */

export type WireErrorClass =
  | "key-missing"
  | "key-invalid"
  | "quota-exhausted"
  | "transient"
  | "other"
  | "fixture-not-found";

export class WireError extends Error {
  readonly class: WireErrorClass;

  constructor({ class: cls, message }: { class: WireErrorClass; message?: string }) {
    super(message ?? cls);
    this.class = cls;
    this.name = "WireError";
  }
}
