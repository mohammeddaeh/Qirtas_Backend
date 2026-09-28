import { describe, expect, it } from 'vitest';
import type { WireOffer, WirePrintConfig, WireQuote } from '../services/printing.service.js';
import type { WirePrintJob } from '../services/print-jobs.service.js';

/**
 * **The server half of the printing contract `qirtas_app` parses**
 * (`test/wire_contract_test.dart` · fixtures `test/fixtures/wire/print_*.json`).
 *
 * A renamed key fails nowhere: the client reads a missing `can_edit_branch` as
 * `false` and hides the edit buttons from the manager who may use them; a
 * missing `band` hides the range the branch price must sit in, so the price is
 * refused *after* it is typed. `200` in the log, green pipelines on both
 * halves.
 *
 * When this list changes, change the Flutter fixture in the same commit.
 */

const config: WirePrintConfig = {
  branch: { id: 1, name: 'الفرع الرئيسي' },
  branches: [{ id: 1, name: 'الفرع الرئيسي' }],
  options: [
    {
      id: 1,
      kind: 'paper_size',
      code: 'a4',
      name_ar: 'A4',
      name_en: 'A4',
      sort_order: 0,
      is_active: true,
      is_enabled: true,
    },
  ],
  page_rates: [
    {
      paper_size_id: 1,
      color_mode_id: 5,
      sides_id: 7,
      central_syp: 100,
      branch_syp: 90,
      band: { min_syp: 80, max_syp: 120 },
    },
  ],
  finishing_rates: [
    { option_id: 11, central_syp: 3000, branch_syp: null, band: { min_syp: 2400, max_syp: 3600 } },
  ],
  tiers: [{ min_pages: 100, discount_percent: 10 }],
  settings: {
    branch_band_percent: 20,
    file_retention_days: 30,
    max_file_mb: 50,
    max_pages: 2000,
    unpaid_timeout_days: 3,
  },
  can_edit_central: true,
  can_edit_branch: true,
};

const offer: WireOffer = {
  branch_id: 1,
  options: {
    paper_size: [{ id: 1, code: 'a4', name_ar: 'A4', name_en: 'A4' }],
    color_mode: [],
    sides: [],
    binding: [],
    cover: [],
  },
  tiers: [{ min_pages: 100, discount_percent: 10 }],
  max_file_mb: 50,
  max_pages: 2000,
};

const quote: WireQuote = {
  branch_id: 1,
  pages: 50,
  copies: 2,
  printed_pages: 100,
  sheets: 100,
  page_rate_syp: 90,
  page_rate_source: 'branch',
  pages_subtotal_syp: 9000,
  tier: { min_pages: 100, discount_percent: 10 },
  tier_discount_syp: 900,
  finishing: [
    { option_id: 11, kind: 'binding', per_copy_syp: 3000, source: 'central', subtotal_syp: 6000 },
  ],
  finishing_subtotal_syp: 8000,
  total_syp: 16100,
};

/**
 * The print order as both the customer and the queue read it (slice 9-ج-2).
 * `next_states` missing hides every button; `hours_left` missing turns «3 days
 * to pay» into a silence; a file without `status` looks ready while it uploads.
 * The Flutter fixture arrives with the screens (9-د) — add it there then.
 */
const job: WirePrintJob = {
  id: 7,
  number: 'BR1-P-2026-000001',
  branch_id: 1,
  branch_name: 'الفرع الرئيسي',
  customer_id: 3,
  customer_name: 'طباعة مالك',
  customer_phone: null,
  status: 'awaiting_payment',
  next_states: ['queued', 'cancelled', 'expired'],
  payment_status: 'unpaid',
  at_till: false,
  sale_id: null,
  paid_at: null,
  deferred: null,
  spec: {
    paper_size: { id: 1, code: 'a4', name_ar: 'A4', name_en: 'A4' },
    color_mode: null,
    sides: null,
    binding: null,
    cover: null,
  },
  copies: 2,
  note: null,
  total_pages: 50,
  quote,
  quoted_total_syp: 16100,
  quoted_at: '2026-09-28T10:00:00.000Z',
  payment_due_at: '2026-10-01T10:00:00.000Z',
  hours_left: 72,
  files: [{ id: 1, name: 'بحث.pdf', bytes: 4105, status: 'ready', type: 'pdf' }],
  links: [{ id: 1, url: 'https://example.com/a.pdf', note: null }],
  cancel_reason: null,
  created_at: '2026-09-28T09:00:00.000Z',
  submitted_at: '2026-09-28T09:30:00.000Z',
  production_started_at: null,
  ready_at: null,
  picked_up_at: null,
};

describe('the printing wire', () => {
  it('a print order carries exactly the keys both screens read', () => {
    expect(Object.keys(job).sort()).toEqual(
      [
        'id',
        'number',
        'branch_id',
        'branch_name',
        'customer_id',
        'customer_name',
        'customer_phone',
        'status',
        'next_states',
        'payment_status',
        'at_till',
        'sale_id',
        'paid_at',
        'deferred',
        'spec',
        'copies',
        'note',
        'total_pages',
        'quote',
        'quoted_total_syp',
        'quoted_at',
        'payment_due_at',
        'hours_left',
        'files',
        'links',
        'cancel_reason',
        'created_at',
        'submitted_at',
        'production_started_at',
        'ready_at',
        'picked_up_at',
      ].sort(),
    );
    expect(Object.keys(job.spec).sort()).toEqual([
      'binding',
      'color_mode',
      'cover',
      'paper_size',
      'sides',
    ]);
    expect(Object.keys(job.files[0]!).sort()).toEqual(['bytes', 'id', 'name', 'status', 'type']);
  });

  it('config carries exactly the keys the settings screen reads', () => {
    expect(Object.keys(config).sort()).toEqual(
      [
        'branch',
        'branches',
        'options',
        'page_rates',
        'finishing_rates',
        'tiers',
        'settings',
        'can_edit_central',
        'can_edit_branch',
      ].sort(),
    );
    expect(Object.keys(config.page_rates[0]!).sort()).toEqual(
      ['paper_size_id', 'color_mode_id', 'sides_id', 'central_syp', 'branch_syp', 'band'].sort(),
    );
    expect(Object.keys(config.options[0]!).sort()).toEqual(
      ['id', 'kind', 'code', 'name_ar', 'name_en', 'sort_order', 'is_active', 'is_enabled'].sort(),
    );
  });

  it('offer groups options under the five kinds', () => {
    expect(Object.keys(offer.options).sort()).toEqual([
      'binding',
      'color_mode',
      'cover',
      'paper_size',
      'sides',
    ]);
  });

  it('quote carries its breakdown', () => {
    expect(Object.keys(quote).sort()).toEqual(
      [
        'branch_id',
        'pages',
        'copies',
        'printed_pages',
        'sheets',
        'page_rate_syp',
        'page_rate_source',
        'pages_subtotal_syp',
        'tier',
        'tier_discount_syp',
        'finishing',
        'finishing_subtotal_syp',
        'total_syp',
      ].sort(),
    );
  });
});
