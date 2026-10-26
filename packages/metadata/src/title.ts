// Title normalisation helpers shared by the whole app. `sortTitle` is for ordering lists
// ("The Office" sorts under O); `cleanTitle` is for matching ("Mr. Robot" ↔ "mrrobot").

const LEADING_ARTICLE = /^(?:the|a|an)\s+/;

/** Lowercase, fold accents, spell out "&", turn every other symbol into a space. */
function foldTitle(title: string): string {
  // Decompose, drop Latin combining accents only, then recompose so scripts whose marks
  // are not accents (e.g. Japanese dakuten) come back intact.
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function sortTitle(title: string): string {
  const folded = foldTitle(title).replace(/\s+/g, ' ');
  const stripped = folded.replace(LEADING_ARTICLE, '');
  // "The" on its own is still a title; never return an empty string for a non-empty input.
  return stripped.length > 0 ? stripped : folded;
}

export function cleanTitle(title: string): string {
  return foldTitle(title).replace(/\s+/g, '');
}
