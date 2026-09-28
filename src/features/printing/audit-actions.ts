/**
 * أفعال إعداد الطباعة بسجلّ التدقيق. «من خفّض سعر الألوان بفرع المزة؟» سؤالٌ
 * يُطرح حين يختلف المحصَّل عن المتوقَّع، وجوابه هنا.
 */
export const PRINTING_AUDIT = {
  optionCreate: 'printing.option.create',
  optionUpdate: 'printing.option.update',
  ratesSet: 'printing.rates.set',
  tiersSet: 'printing.tiers.set',
  settingsSet: 'printing.settings.set',
  branchOptionsSet: 'printing.branch.options.set',
  branchRatesSet: 'printing.branch.rates.set',
  // طلب الطباعة — ما يفعله الموظف به. «من سعّر هذا الطلب بخمسين صفحة؟» جوابه هنا.
  jobQuote: 'printing.job.quote',
  jobStage: 'printing.job.stage',
  jobCancel: 'printing.job.cancel',
  jobDefer: 'printing.job.defer',
  jobFileOpen: 'printing.job.file.open',
  // وصفة الاستهلاك (9-هـ) — «من غيّر كم ورقة يستهلك الغلاف؟» و«متى رُكِّبت العلبة؟»
  consumptionRulesSet: 'printing.consumption.rules.set',
  consumableInstall: 'printing.consumable.install',
} as const;

export const printingTarget = {
  option: (id: number) => `print_option:${id}`,
  config: () => 'print_config',
  branch: (id: number) => `print_branch:${id}`,
  job: (id: number) => `print_job:${id}`,
};
