import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { libraryItems, media } from '../../db/schema.js';

/**
 * The genres Tracearr's library sync stored for the item a session plays: the server's own
 * copy first (by its rating key), else the canonical media row. None when it has no record
 * of them, or the read fails: a message is never held up for its genres.
 */
export async function itemGenres(
  serverId: string,
  ratingKey: string | null,
  mediaId: string | null
): Promise<string[]> {
  try {
    if (ratingKey) {
      const [item] = await db
        .select({ genres: libraryItems.genres })
        .from(libraryItems)
        .where(and(eq(libraryItems.serverId, serverId), eq(libraryItems.ratingKey, ratingKey)))
        .limit(1);
      if (item?.genres?.length) return item.genres;
    }
    if (mediaId) {
      const [row] = await db
        .select({ genres: media.genres })
        .from(media)
        .where(eq(media.id, mediaId))
        .limit(1);
      if (row?.genres?.length) return row.genres;
    }
  } catch {
    // Best effort: the card goes without genres.
  }
  return [];
}
