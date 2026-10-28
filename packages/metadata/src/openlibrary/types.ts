// Clean OpenLibrary output types. Ids are bare OLIDs ("OL7234434A", "OL21745884W",
// "OL30036715M"); languages are lower-case English names; images are cover/photo ids, turned
// into URLs by ./covers.ts.

export interface OlPage<T> {
  /** Total matches OpenLibrary reports. */
  total: number;
  offset: number;
  results: T[];
}

export interface OlAuthorSearchResult {
  olid: string;
  name: string;
  alternateNames: string[];
  birthDate?: string;
  deathDate?: string;
  topWork?: string;
  workCount: number;
  topSubjects: string[];
}

export interface OlAuthor {
  olid: string;
  name: string;
  alternateNames: string[];
  bio?: string;
  birthDate?: string;
  deathDate?: string;
  photoIds: number[];
  /** Amazon/Audible author ASIN from `remote_ids.amazon`, when someone recorded it. */
  amazonAsin?: string;
  wikidataId?: string;
  links: { title?: string; url: string }[];
}

export interface OlWork {
  olid: string;
  title: string;
  subtitle?: string;
  description?: string;
  authorOlids: string[];
  subjects: string[];
  coverIds: number[];
  firstPublishDate?: string;
  /** Free-text series names; OpenLibrary rarely has positions. */
  series: string[];
}

export interface OlEdition {
  olid: string;
  workOlids: string[];
  title: string;
  subtitle?: string;
  description?: string;
  authorOlids: string[];
  /** As recorded ("May 04, 2021"). */
  publishDate?: string;
  /** `YYYY-MM-DD` / `YYYY` when `publishDate` can be read. */
  releaseDate?: string;
  publishers: string[];
  coverIds: number[];
  isbn10: string[];
  isbn13: string[];
  languages: string[];
  pages?: number;
  physicalFormat?: string;
  series: string[];
  /** Amazon ASINs from `identifiers.amazon`. */
  asins: string[];
}

export interface OlBookSearchResult {
  /** Work OLID. */
  olid: string;
  title: string;
  subtitle?: string;
  authorNames: string[];
  authorOlids: string[];
  firstPublishYear?: number;
  isbns: string[];
  coverId?: number;
  languages: string[];
  publishers: string[];
  editionCount: number;
  subjects: string[];
  asins: string[];
}
