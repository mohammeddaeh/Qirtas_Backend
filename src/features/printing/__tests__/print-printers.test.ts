import { beforeEach, describe, expect, it, vi } from 'vitest';

const findByBranch = vi.fn();

vi.mock('../repositories/print-printers.repository.js', () => ({
  findByBranch: (...a: unknown[]) => findByBranch(...a),
}));
vi.mock('../repositories/printing.repository.js', () => ({}));
vi.mock('../../../core/http/require-permission.js', () => ({ holdsPermissionAt: vi.fn() }));
vi.mock('../services/printing.service.js', () => ({
  SETTINGS_KEY: 'printing.settings',
  BRANCH_SETTINGS_KEY: 'printing.branch_settings',
}));

const { resolveStartPrinter } = await import('../services/print-printers.service.js');

const printer = (id: number, supports_color = true) => ({ id, branch_id: 1, name: `P${id}`, supports_color, is_active: true });

/**
 * «ابدأ» on the wrong printer prints nothing wrong-looking: the job says
 * «يُطبع على P2» and P2 cannot print colour. Each case with its opposite.
 */
describe('resolveStartPrinter (9-ط-2)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a branch with no printers starts as before — no question, no printer', async () => {
    findByBranch.mockResolvedValue([]);
    await expect(resolveStartPrinter(1, 'color', undefined)).resolves.toBeNull();
  });

  it('no printer named starts without one even when the branch has printers (a phone) — a named one is kept', async () => {
    findByBranch.mockResolvedValue([printer(1), printer(2)]);
    await expect(resolveStartPrinter(1, 'bw', undefined)).resolves.toBeNull();
    await expect(resolveStartPrinter(1, 'bw', 2)).resolves.toBe(2);
  });

  it('a colour job refuses a black-and-white printer; a black-and-white job takes it', async () => {
    findByBranch.mockResolvedValue([printer(3, false)]);
    await expect(resolveStartPrinter(1, 'color', 3)).rejects.toMatchObject({ messageKey: 'printer_not_usable' });
    await expect(resolveStartPrinter(1, 'bw', 3)).resolves.toBe(3);
  });

  it('a printer of another branch or a stopped one is not among the active list — refused', async () => {
    findByBranch.mockResolvedValue([printer(1)]);
    await expect(resolveStartPrinter(1, 'bw', 99)).rejects.toMatchObject({ messageKey: 'printer_not_usable' });
    expect(findByBranch).toHaveBeenCalledWith(1, true);
  });
});
