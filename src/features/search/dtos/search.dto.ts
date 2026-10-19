import { z } from 'zod';

/** At least two characters: one letter matches half the shop and tells nothing. */
export const searchQuerySchema = z
  .object({
    q: z.string().trim().min(2).max(80),
  })
  .strict();
export type SearchQuery = z.infer<typeof searchQuerySchema>;
