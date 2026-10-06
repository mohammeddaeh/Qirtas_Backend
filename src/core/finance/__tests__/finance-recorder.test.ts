import { describe, expect, it } from 'vitest';
import { allocateRevenue } from '../finance-recorder.js';

// The revenue booked for a sale must equal the invoice, never what was handed
// over: cash above the total is change that goes back to the customer.
// Getting this wrong fails silently — the report and the drawer differ by the
// change, and nothing errors.
describe('allocateRevenue', () => {
  it('books exactly the invoice total for an exact payment', () => {
    expect(allocateRevenue([{ method: 'cash', amountSyp: 4300 }], 4300)).toEqual([
      { method: 'cash', amountSyp: 4300 },
    ]);
  });

  it('cuts cash overpayment down to the total — change is not revenue', () => {
    expect(allocateRevenue([{ method: 'cash', amountSyp: 5000 }], 4300)).toEqual([
      { method: 'cash', amountSyp: 4300 },
    ]);
  });

  it('keeps each method in a split payment', () => {
    expect(
      allocateRevenue(
        [
          { method: 'card', amountSyp: 3000 },
          { method: 'cash', amountSyp: 1300 },
        ],
        4300,
      ),
    ).toEqual([
      { method: 'card', amountSyp: 3000 },
      { method: 'cash', amountSyp: 1300 },
    ]);
  });

  it('cuts the cash part first when a split overpays — only cash gives change', () => {
    expect(
      allocateRevenue(
        [
          { method: 'cash', amountSyp: 2000 },
          { method: 'card', amountSyp: 3000 },
        ],
        4300,
      ),
    ).toEqual([
      { method: 'card', amountSyp: 3000 },
      { method: 'cash', amountSyp: 1300 },
    ]);
  });

  it('never invents revenue: zero total books nothing', () => {
    expect(allocateRevenue([{ method: 'cash', amountSyp: 500 }], 0)).toEqual([]);
  });

  it('drops a method that ended up with nothing', () => {
    expect(
      allocateRevenue(
        [
          { method: 'card', amountSyp: 4300 },
          { method: 'cash', amountSyp: 700 },
        ],
        4300,
      ),
    ).toEqual([{ method: 'card', amountSyp: 4300 }]);
  });
});
