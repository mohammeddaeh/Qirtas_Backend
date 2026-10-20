import { desc } from 'drizzle-orm';
import { recordAudit } from '../../../core/audit/audit-recorder.js';
import { db } from '../../../core/db/client.js';
import { BusinessError } from '../../../core/http/api-error.js';
import type { RequestActorContext } from '../../../core/http/require-actor.js';
import { SALES_AUDIT, saleTarget } from '../audit-actions.js';
import { findSettings, saveSettings } from '../repositories/returns.repository.js';
import * as salesRepo from '../repositories/sales.repository.js';
import { fxRatesTable, type FxRateRow } from '../schemas/fx.schema.js';
import { ratesInOrder } from './fx-rules.js';

/**
 * The dollar's buy and sell rates (`finance_operations.md` §٣-ب, decision §٨ #١١):
 * written by the manager when they change, read by every till.
 */

export interface WireFxRate {
  id: number;
  buy_rate: number;
  sell_rate: number;
  note: string | null;
  set_by_name: string | null;
  created_at: string;
}

export interface WireFx {
  /** `null` until a rate was ever written — dollars are refused then. */
  current: WireFxRate | null;
  /** The change in liras for dollars is rounded to this. `0` = not rounded. */
  round_syp: number;
  history: WireFxRate[];
}

async function wireRates(rows: FxRateRow[]): Promise<WireFxRate[]> {
  const ids = [...new Set(rows.flatMap((r) => (r.set_by_user_id === null ? [] : [r.set_by_user_id])))];
  const names = await salesRepo.findUserNames(ids);
  return rows.map((r) => ({
    id: r.id,
    buy_rate: Number(r.buy_rate),
    sell_rate: Number(r.sell_rate),
    note: r.note,
    set_by_name: r.set_by_user_id === null ? null : (names.get(r.set_by_user_id) ?? null),
    created_at: r.created_at.toISOString(),
  }));
}

/** The rate in force now — the newest row. */
export async function currentRate(): Promise<FxRateRow | null> {
  const [row] = await db.select().from(fxRatesTable).orderBy(desc(fxRatesTable.created_at), desc(fxRatesTable.id)).limit(1);
  return row ?? null;
}

export async function getFx(): Promise<WireFx> {
  const [rows, settings] = await Promise.all([
    db.select().from(fxRatesTable).orderBy(desc(fxRatesTable.created_at), desc(fxRatesTable.id)).limit(30),
    findSettings(),
  ]);
  const wired = await wireRates(rows);
  return { current: wired[0] ?? null, round_syp: settings.cash_round_syp, history: wired };
}

export async function setRates(
  actor: RequestActorContext,
  input: { buy_rate: number; sell_rate: number; note?: string },
): Promise<WireFx> {
  if (!ratesInOrder(input.buy_rate, input.sell_rate)) {
    throw new BusinessError(422, 'The buy rate cannot be above the sell rate', 'fx_buy_above_sell');
  }
  await db.insert(fxRatesTable).values({
    buy_rate: input.buy_rate.toFixed(4),
    sell_rate: input.sell_rate.toFixed(4),
    note: input.note?.trim() || null,
    set_by_user_id: actor.userId,
  });
  await recordAudit(actor, SALES_AUDIT.fxRates, saleTarget.settings(), null, input);
  return getFx();
}

export async function setRounding(actor: RequestActorContext, roundSyp: number): Promise<WireFx> {
  await saveSettings({ cash_round_syp: roundSyp }, actor.userId);
  await recordAudit(actor, SALES_AUDIT.fxRounding, saleTarget.settings(), null, { round_syp: roundSyp });
  return getFx();
}
