/**
 * Which endpoint a credential belongs to.
 *
 * OpenCode ships TWO matched sets, and mixing them is what this module exists to
 * stop. Read from the client's catalogs rather than guessed:
 *
 * | catalog                | `opencode`                    | `opencode-go`                    |
 * | :--------------------- | :---------------------------- | :------------------------------- |
 * | `models.dev` (old)     | `…/zen/v1`                    | `…/zen/go/v1`                    |
 * | `models.opencode.ai`   | `…/inference/v1`              | `…/inference/go/v1`              |
 *
 * and the credential formats pair with them: the installation's older key is
 * `oc_sk_` + 45 characters, while the one OpenCode 2.x mints is
 * `oc_sk_<12 hex>_<rest>`. A new-format key on the old endpoint, or the reverse,
 * is a mismatched pair — and a mismatched pair is refused in a way that reads
 * like an entitlement problem rather than a wiring one.
 *
 * Measured: both pairs answer `200` for a paid model on their own endpoint, which
 * is why the pairing is worth honouring rather than collapsing to one.
 */

/** The endpoint families, old and new. */
const ZEN_OLD = "opencode.ai/zen/";
const ZEN_NEW = "opencode.ai/inference/";

/**
 * Whether a credential is the format OpenCode 2.x mints.
 *
 * `oc_sk_` + twelve hex characters + `_` + the rest, which is the shape the
 * installed client sends. The older key has no such group, so the distinction is
 * structural rather than a length.
 *
 * @param key - the credential, without any scheme prefix.
 * @returns whether it carries the 2.x format's embedded identifier.
 */
export const isNewFormatKey = (key: unknown): boolean =>
  typeof key === "string" && /^oc_sk_[0-9a-f]{12}_/u.test(key);

/**
 * The endpoint that matches a credential's format.
 *
 * Only the host is rewritten: the path after `/v1` is the protocol's and is left
 * exactly as it arrived, because that part is already correct for both sets. A
 * URL that is neither family is returned unchanged, so this cannot move a request
 * it does not recognise.
 *
 * @param url - the request URL.
 * @param key - the credential the request will carry, without the scheme prefix.
 * @returns the URL for the matching endpoint family.
 */
export const pairedEndpointUrl = (url: string, key: unknown): string => {
  if (!url.includes(ZEN_OLD) && !url.includes(ZEN_NEW)) {
    return url;
  }
  const wanted = isNewFormatKey(key) ? ZEN_NEW : ZEN_OLD;
  const current = url.includes(ZEN_NEW) ? ZEN_NEW : ZEN_OLD;
  return current === wanted ? url : url.replace(current, wanted);
};
