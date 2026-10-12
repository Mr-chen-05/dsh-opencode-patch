/**
 * The org a plane's requests should carry, kept next to what changes it.
 *
 * `patchFetch` asks for this synchronously - `hooks.resolveOrg?.(plane)` - so it
 * cannot go to the credential store itself. The value is read once at startup and
 * then per request, and a LOGIN happens after startup: the user signs in from the
 * card, minutes or hours into the process. A cache that only the startup path
 * writes therefore holds what was true then, and the requests that follow carry no
 * `x-opencode-org-id` even though the grant now has one.
 *
 * So it lives here, in one small module both sides import: `lifecycle.ts` reads it
 * per request, and the login writes it when it completes. The value is kept next to
 * the thing that changes it, which is the same answer the token reader arrived at.
 *
 * @module dsh-opencode-patch/org-cache
 */

const byPlane = new Map<string, string | undefined>();

/**
 * Record the org for a plane.
 *
 * @param plane - the plane the org belongs to.
 * @param org - the org id, or `undefined` when there is none to record.
 */
export const setOrg = (plane: string, org: string | undefined): void => {
  byPlane.set(plane, org);
};

/**
 * The org a plane's requests should carry.
 *
 * @param plane - the plane to ask about.
 * @returns the org id, or `undefined` when none is known.
 */
export const orgFor = (plane: string): string | undefined => byPlane.get(plane);

/** Forget everything, for a test that needs a clean slate. */
export const clearOrgs = (): void => {
  byPlane.clear();
};
