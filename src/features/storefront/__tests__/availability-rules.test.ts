import { describe, expect, it } from 'vitest';
import {
  LOW_STOCK_VISIBLE_QTY,
  availabilityOf,
  publicStateOf,
  bestOf,
  distanceKm,
  type AvailabilityInput,
} from '../services/availability-rules.js';

/**
 * **A wrong availability is silent, and it costs somebody a trip.**
 *
 * Shown as available, the goods are not there when the customer arrives.
 * Shown as «نفد», stock sits on the shelf that nobody comes for. Shown as
 * «غير مسعَّر», an internal fault is read as a fact about the goods. Every one
 * of these renders perfectly, logs nothing, and is wrong.
 *
 * So each case is pinned **with its opposite**: proving that an unlisted item
 * is hidden proves nothing on its own — a function that hides everything
 * passes it, and that function is an empty shop.
 */

const base: AvailabilityInput = {
  productStatus: 'active',
  isListedHere: true,
  isPricedHere: true,
  availableHere: 50,
  elsewhere: [],
};

const near = (onHand: number) => [{ branchId: 7, name: 'المزة', onHand, distanceKm: 2 }];

describe('what the customer is told', () => {
  it('says «متوفّر» only when it is listed, priced and on the shelf', () => {
    expect(availabilityOf(base).state).toBe('available');
    expect(availabilityOf(base).hiddenFromBrowsing).toBe(false);
    // Each leg removed on its own — none of them may be optional.
    expect(availabilityOf({ ...base, isListedHere: false }).state).not.toBe('available');
    expect(availabilityOf({ ...base, isPricedHere: false }).state).not.toBe('available');
    expect(availabilityOf({ ...base, availableHere: 0 }).state).not.toBe('available');
  });

  it('says the number out loud only while it is small', () => {
    const low = availabilityOf({ ...base, availableHere: 3 });
    expect(low.state).toBe('low_stock');
    expect(low.remaining).toBe(3);
    // The edge counts as few; one more does not — otherwise «بقي ٥٠» would be
    // printed beside goods nobody needs to hurry for.
    expect(availabilityOf({ ...base, availableHere: LOW_STOCK_VISIBLE_QTY }).state).toBe('low_stock');
    expect(availabilityOf({ ...base, availableHere: LOW_STOCK_VISIBLE_QTY + 1 }).state).toBe('available');
    expect(availabilityOf({ ...base, availableHere: LOW_STOCK_VISIBLE_QTY + 1 }).remaining).toBeNull();
  });

  it('counts reserved goods as gone, and a negative balance as none', () => {
    // `availableHere` is `on_hand − reserved`; the caller subtracts, and zero
    // or less is «ليس على الرف» either way — a negative is a contradiction for
    // the stocktake, not a quantity to sell.
    expect(availabilityOf({ ...base, availableHere: 0 }).state).toBe('out_everywhere');
    expect(availabilityOf({ ...base, availableHere: -4 }).state).toBe('out_everywhere');
    expect(availabilityOf({ ...base, availableHere: 0.5 }).state).toBe('low_stock');
  });

  it('names the branch that has it instead of ending the conversation', () => {
    const out = availabilityOf({ ...base, availableHere: 0, elsewhere: near(4) });
    expect(out.state).toBe('out_here_available_elsewhere');
    expect(out.otherBranch?.name).toBe('المزة');
    // And a branch that is also empty is not an alternative: sending somebody
    // across town for nothing is worse than «نفد حالياً».
    expect(availabilityOf({ ...base, availableHere: 0, elsewhere: near(0) }).state).toBe('out_everywhere');
    expect(availabilityOf({ ...base, availableHere: 0 }).otherBranch).toBeNull();
  });

  it('never says «غير مسعَّر» to a customer', () => {
    const unpriced = availabilityOf({ ...base, isPricedHere: false });
    expect(unpriced.state).toBe('unpriced');
    // Hidden, always — it is our fault, not a fact about the goods. Even with
    // stock on the shelf and another branch selling it.
    expect(unpriced.hiddenFromBrowsing).toBe(true);
    expect(
      availabilityOf({ ...base, isPricedHere: false, elsewhere: near(9) }).hiddenFromBrowsing,
    ).toBe(true);
    expect(availabilityOf(base).hiddenFromBrowsing).toBe(false);
  });

  it('hides a withdrawn item only when nobody else sells it', () => {
    // Withdrawn here but on sale elsewhere: worth showing, because the answer
    // is a branch switch.
    const elsewhere = availabilityOf({ ...base, isListedHere: false, elsewhere: near(6) });
    expect(elsewhere.state).toBe('not_listed_here');
    expect(elsewhere.hiddenFromBrowsing).toBe(false);
    expect(elsewhere.otherBranch?.branchId).toBe(7);
    // Withdrawn everywhere: there is nothing to say about it at all.
    expect(availabilityOf({ ...base, isListedHere: false }).hiddenFromBrowsing).toBe(true);
  });

  it('keeps retired and unpublished goods out of browsing — and apart', () => {
    const retired = availabilityOf({ ...base, productStatus: 'discontinued' });
    expect(retired.state).toBe('discontinued');
    expect(retired.hiddenFromBrowsing).toBe(true);
    // A branch draft is not «مسحوب من البيع» — it was never published, and
    // folding the two would lose which of them an administrator must act on.
    const draft = availabilityOf({ ...base, productStatus: 'draft' });
    expect(draft.state).toBe('not_published');
    expect(draft.hiddenFromBrowsing).toBe(true);
    expect(availabilityOf(base).state).toBe('available');
  });
});

describe('a product from its variants', () => {
  it('opens on what the customer can buy', () => {
    // One colour out of five being out is not «نفد»: saying so would hide the
    // four on the shelf.
    expect(bestOf(['out_everywhere', 'available'])).toBe('available');
    expect(bestOf(['unpriced', 'low_stock'])).toBe('low_stock');
    expect(bestOf(['available', 'low_stock'])).toBe('available');
    // And with nothing buyable anywhere, the worst is what is left to say.
    expect(bestOf(['out_everywhere', 'unpriced'])).toBe('out_everywhere');
    expect(bestOf(['out_here_available_elsewhere', 'out_everywhere'])).toBe(
      'out_here_available_elsewhere',
    );
    expect(bestOf([])).toBe('unpriced');
  });
});

describe('how far the other branch is', () => {
  it('measures a real distance and refuses to invent one', () => {
    const damascus = { lat: 33.5138, lng: 36.2765 };
    const aleppo = { lat: 36.2021, lng: 37.1343 };
    expect(distanceKm(damascus, aleppo)).toBeGreaterThan(300);
    expect(distanceKm(damascus, aleppo)).toBeLessThan(330);
    expect(distanceKm(damascus, damascus)).toBe(0);
    // Half a coordinate is not a location: the branch is named without a
    // distance rather than placed on the equator.
    expect(distanceKm(damascus, { lat: 36.2, lng: null })).toBeNull();
    expect(distanceKm({ lat: null, lng: null }, aleppo)).toBeNull();
  });
});

describe('ما يغادر الخادم', () => {
  it('لا يُرسل حالةً عن أوراقنا بوصفها حقيقةً عن البضاعة', () => {
    // «غير مسعَّر» و«غير منشور» عطلان عندنا: يخرجان «غير متوفّر بفرعك»،
    // وهو ما يستطيع الزبون التصرّف به.
    expect(publicStateOf('unpriced')).toBe('not_listed_here');
    expect(publicStateOf('not_published')).toBe('not_listed_here');
    // وكل حالة حقيقية تعبر كما هي — ترجمةٌ تبتلع الجميع تُخفي متجراً كاملاً.
    expect(publicStateOf('available')).toBe('available');
    expect(publicStateOf('low_stock')).toBe('low_stock');
    expect(publicStateOf('out_everywhere')).toBe('out_everywhere');
    expect(publicStateOf('out_here_available_elsewhere')).toBe('out_here_available_elsewhere');
    expect(publicStateOf('discontinued')).toBe('discontinued');
  });
});
