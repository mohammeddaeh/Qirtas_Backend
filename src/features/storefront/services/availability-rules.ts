/**
 * What a customer is told about one item at one branch — store_system.md §٨.
 *
 * Pure, because every wrong answer here is silent and expensive: an item shown
 * as available sends somebody across town for goods that are not there, and an
 * item shown as «نفد» hides stock that is on the shelf. Nothing throws, no log
 * is written, and the screen looks exactly the same either way.
 *
 * The seven states, and the one that is never shown by name:
 *
 * | state | the customer reads | what they can do |
 * |---|---|---|
 * | `available` | the price | add to cart |
 * | `low_stock` | «بقي ٣» | add to cart |
 * | `out_here_available_elsewhere` | «متوفّر بفرع X» | switch branch · ask for it here |
 * | `out_everywhere` | «نفد حالياً» | «أعلمني عند التوفّر» |
 * | `not_listed_here` | the same «غير متوفّر بفرعك» — **only if another branch sells it** | — |
 * | `unpriced` | *nothing* — it reads as unavailable here | (an internal signal) |
 * | `discontinued` | hidden from browsing; an old order still opens it | — |
 */

export type Availability =
  | 'available'
  | 'low_stock'
  | 'out_here_available_elsewhere'
  | 'out_everywhere'
  | 'not_listed_here'
  | 'unpriced'
  | 'discontinued'
  /**
   * A row nobody has published yet — a branch draft (§٢) or a half-written
   * product. Like `unpriced` it is **never shown to a customer**: it is a state
   * of our paperwork, not of the goods. It exists so the rules can say so in a
   * word instead of borrowing one that means something else.
   */
  | 'not_published';

/**
 * ما **يُرسل للزبون** من هذه الحالات.
 *
 * `unpriced` و`not_published` حالتان عن أوراقنا لا عن البضاعة، ولا يجوز أن
 * تغادرا الخادم بهذا الاسم (§٨): الزبون يحتاج «ماذا أفعل الآن»، والإدارة
 * تحتاج الإشارة — وهي تصلها بشاشاتها. فتُقالان بما يعنيانه له: «غير متوفّر
 * بفرعك».
 *
 * والترجمة هنا لا بالعميل: عميلٌ يترجمها يعني أن أي عميل آخر (متجر ويب
 * لاحقاً) يقرأ الاسم الداخلي ويعرضه كما هو.
 */
export type PublicAvailability = Exclude<Availability, 'unpriced' | 'not_published'>;

export function publicStateOf(state: Availability): PublicAvailability {
  return state === 'unpriced' || state === 'not_published' ? 'not_listed_here' : state;
}

/**
 * How few is few enough to say the number out loud.
 *
 * Deliberately **not** the branch's reorder threshold: that answers «متى أطلب
 * من المورد؟» and may be fifty for a fast mover — «بقي ٥٠» is not urgency, it
 * is noise. Five is a quantity a customer can act on.
 */
export const LOW_STOCK_VISIBLE_QTY = 5;

export interface OtherBranchStock {
  branchId: number;
  name: string;
  onHand: number;
  /** Kilometres from the customer, when they shared where they are. */
  distanceKm: number | null;
}

export interface AvailabilityInput {
  productStatus: 'draft' | 'active' | 'discontinued' | string;
  /** The branch has not withdrawn it (`catalog_branch_listings`). */
  isListedHere: boolean;
  /** The catalog resolved a sellable number for this branch. */
  isPricedHere: boolean;
  /** `on_hand − reserved` at this branch. Negative is possible and means none. */
  availableHere: number;
  /** Branches that both sell it and hold it — nearest first is the caller's job. */
  elsewhere: OtherBranchStock[];
}

export interface AvailabilityOutcome {
  state: Availability;
  /** Only for `low_stock` — the figure the screen says out loud. */
  remaining: number | null;
  /** Only for `out_here_available_elsewhere`. */
  otherBranch: OtherBranchStock | null;
  /** Browsing lists drop these rows; a link to one still opens it. */
  hiddenFromBrowsing: boolean;
}

export function availabilityOf(input: AvailabilityInput): AvailabilityOutcome {
  const hidden = (state: Availability): AvailabilityOutcome => ({
    state,
    remaining: null,
    otherBranch: null,
    hiddenFromBrowsing: true,
  });

  // Retired goods leave the shop's shelves but not its history: an old order
  // must still resolve to a real product with a real name.
  if (input.productStatus === 'discontinued') return hidden('discontinued');
  // A draft has no name anybody agreed on yet (§٢) — the branch receives on it
  // and nobody sells it.
  if (input.productStatus !== 'active') return hidden('not_published');

  const elsewhere = input.elsewhere.filter((b) => b.onHand > 0);

  if (!input.isListedHere) {
    // Withdrawn here. If nobody else sells it either, there is nothing to say
    // about it at all — so it is hidden rather than listed as unavailable.
    return elsewhere.length === 0
      ? hidden('not_listed_here')
      : {
          state: 'not_listed_here',
          remaining: null,
          otherBranch: elsewhere[0] ?? null,
          hiddenFromBrowsing: false,
        };
  }

  if (!input.isPricedHere) {
    // «غير مسعَّر» is a fault of ours, not a fact about the goods — so the
    // customer is never shown those words. The row simply is not offered here,
    // and the administration gets the signal on its own screen.
    return hidden('unpriced');
  }

  if (input.availableHere > 0) {
    return input.availableHere <= LOW_STOCK_VISIBLE_QTY
      ? {
          state: 'low_stock',
          remaining: input.availableHere,
          otherBranch: null,
          hiddenFromBrowsing: false,
        }
      : { state: 'available', remaining: null, otherBranch: null, hiddenFromBrowsing: false };
  }

  // Out here. Naming the branch that has it is the whole difference between a
  // dead end and a trip worth making — and it is also what turns «اطلب توفيره
  // بفرعي» into a request somebody can actually fill.
  if (elsewhere.length > 0) {
    return {
      state: 'out_here_available_elsewhere',
      remaining: null,
      otherBranch: elsewhere[0] ?? null,
      hiddenFromBrowsing: false,
    };
  }

  return { state: 'out_everywhere', remaining: null, otherBranch: null, hiddenFromBrowsing: false };
}

/**
 * The product row's state, from its variants'.
 *
 * The best state wins, because a product page opens on what the customer *can*
 * buy: one colour out of five being out is not «نفد», and saying so would hide
 * four colours that are on the shelf.
 */
const ORDER: Availability[] = [
  'available',
  'low_stock',
  'out_here_available_elsewhere',
  'out_everywhere',
  'not_listed_here',
  'unpriced',
  'discontinued',
  'not_published',
];

export function bestOf(states: Availability[]): Availability {
  for (const state of ORDER) if (states.includes(state)) return state;
  return 'unpriced';
}

/**
 * Great-circle distance in kilometres, rounded to one decimal.
 *
 * A branch with half a coordinate is **not** placed at the equator: `null`
 * travels through, and the screen says the branch's name without a distance
 * rather than «على بعد ٣٬٤٠٠ كم».
 */
export function distanceKm(
  from: { lat: number | null; lng: number | null },
  to: { lat: number | null; lng: number | null },
): number | null {
  if (from.lat === null || from.lng === null || to.lat === null || to.lng === null) return null;
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(a))) * 10) / 10;
}
