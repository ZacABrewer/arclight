import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * Searchable title expressions for a history/blocklist row's parent (`q` on the activity
 * lists): the series, movie, artist and author names plus the album/book titles the row covers.
 * Correlated subqueries rather than joins, so the count query (which has no joins) and the page
 * query share one WHERE. Inner tables are aliased so they never collide with the page query's
 * own joins.
 */
export function parentTitleSearchColumns(cols: {
  seriesId: SQLWrapper;
  movieId: SQLWrapper;
  artistId: SQLWrapper;
  authorId: SQLWrapper;
  albumIds: SQLWrapper;
  bookIds: SQLWrapper;
}): SQL[] {
  return [
    sql`(select q_s.title from series q_s where q_s.id = ${cols.seriesId})`,
    sql`(select q_m.title from movies q_m where q_m.id = ${cols.movieId})`,
    sql`(select q_m.original_title from movies q_m where q_m.id = ${cols.movieId})`,
    sql`(select q_ar.name from artists q_ar where q_ar.id = ${cols.artistId})`,
    sql`(select q_au.name from authors q_au where q_au.id = ${cols.authorId})`,
    sql`(select group_concat(q_al.title, ' | ') from albums q_al where q_al.id in (select value from json_each(coalesce(${cols.albumIds}, '[]'))))`,
    sql`(select group_concat(q_b.title, ' | ') from books q_b where q_b.id in (select value from json_each(coalesce(${cols.bookIds}, '[]'))))`,
  ];
}

/** Title and `s01e02` code of one episode. */
export function episodeSearchColumns(episodeId: SQLWrapper): SQL[] {
  return [
    sql`(select q_e.title from episodes q_e where q_e.id = ${episodeId})`,
    sql`(select printf('s%02de%02d', q_e.season_number, q_e.episode_number) from episodes q_e where q_e.id = ${episodeId})`,
  ];
}

/** Titles and codes of the episodes in a JSON id array (blocklist rows). */
export function episodeListSearchColumns(episodeIds: SQLWrapper): SQL[] {
  return [
    sql`(select group_concat(q_e.title || ' ' || printf('s%02de%02d', q_e.season_number, q_e.episode_number), ' | ') from episodes q_e where q_e.id in (select value from json_each(coalesce(${episodeIds}, '[]'))))`,
  ];
}
