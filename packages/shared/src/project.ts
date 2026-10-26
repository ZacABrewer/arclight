// Where this project lives. Owner and repository are named once here; the definition feed default
// (packages/indexers definitions served from GitHub raw) and the update check derive from them.

export const ARCLIGHT_GITHUB_OWNER = 'zacheryabrewer';
export const ARCLIGHT_GITHUB_REPO = 'arclight';
/** `owner/name` on GitHub; the image is `ghcr.io/<owner/name>`. */
export const ARCLIGHT_GITHUB_SLUG = `${ARCLIGHT_GITHUB_OWNER}/${ARCLIGHT_GITHUB_REPO}`;
/** Raw-content base of the main branch. */
export const ARCLIGHT_RAW_BASE = `https://raw.githubusercontent.com/${ARCLIGHT_GITHUB_SLUG}/main/`;
