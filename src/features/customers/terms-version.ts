/**
 * Which text of the terms and privacy policy a sign-up agrees to.
 *
 * Bump it whenever the wording changes in a way that matters legally: the value
 * is stored beside each customer's acceptance, and that pairing is the only
 * proof of WHAT they agreed to. Owned by the server on purpose — a client that
 * sent its own version could claim to have shown a text it never did.
 *
 * ⚠️ `provisional`: the current text is a placeholder written by the developer,
 * not by a lawyer. Replace the text in the app (and this value) before launch.
 */
export const TERMS_VERSION = '2026-09-provisional';
