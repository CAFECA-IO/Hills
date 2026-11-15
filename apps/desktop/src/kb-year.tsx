/** 知識庫「這一年」（ui-spec「知識庫」v0.51，D70）：53 週 × 7 天的每日新增格子，點一週回看星空。 */
import { useMemo } from 'react';
import type { KbItem } from './api';
import { getLocale, t } from './i18n';
import { activityDays, dayOf, isoWeekOfMonday, weekOf, yearStats } from './kb-utils';
import { ActivityGrid, ActivityLegend, LinkButton, mondayOf, dayKey } from './ui';

export function YearSection({
  items,
  now,
  timezone,
  week,
  onWeek,
}: {
  items: KbItem[];
  now: number;
  timezone: string;
  /** 選取的 ISO 週（null = 本週，全部顯示） */
  week: string | null;
  onWeek: (w: string | null) => void;
}) {
  const days = useMemo(() => activityDays(items, timezone), [items, timezone]);
  const stats = useMemo(() => yearStats(items, now, timezone), [items, now, timezone]);
  const end = useMemo(() => new Date(`${dayOf(now, timezone)}T00:00:00`), [now, timezone]);
  const thisWeek = weekOf(now, timezone);
  const locale = getLocale();
  const monthFmt = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'short' }), [locale]);
  const dayFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' }),
    [locale],
  );
  // 選取的週：ISO 週 → 該週星期一
  const selectedMonday = useMemo(() => {
    if (!week) return dayKey(mondayOf(end));
    for (let i = 0; i < 54; i++) {
      const d = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i * 7);
      const m = dayKey(mondayOf(d));
      if (isoWeekOfMonday(m) === week) return m;
    }
    return null;
  }, [week, end]);
  return (
    <section
      aria-labelledby="kb-year-title"
      className="flex shrink-0 flex-col gap-2 rounded-card bg-surface px-4 py-3 shadow-sm"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="kb-year-title" className="text-sm font-bold">
          {t('kb.year.title')}
        </h2>
        <span className="text-xs text-muted">
          {t('kb.year.stats', { year: stats.year, streak: stats.streak, week: stats.week })}
        </span>
        <span className="flex-1" />
        {week && week !== thisWeek && (
          <LinkButton className="text-xs underline" onClick={() => onWeek(null)}>
            {t('kb.year.now')}
          </LinkButton>
        )}
      </div>
      <div className="overflow-x-auto">
        <ActivityGrid
          days={days}
          end={end}
          selectedWeek={selectedMonday}
          onSelectWeek={(m) => {
            const w = isoWeekOfMonday(m);
            onWeek(w === thisWeek ? null : w);
          }}
          label={t('kb.year.grid')}
          monthLabel={(m) => monthFmt.format(new Date(2026, m, 1))}
          cellLabel={(c) =>
            t('kb.year.cell', {
              date: dayFmt.format(new Date(`${c.date}T00:00:00`)),
              count: c.count,
            })
          }
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>{t('kb.year.hint')}</span>
        <span className="flex-1" />
        <ActivityLegend less={t('kb.year.less')} more={t('kb.year.more')} />
      </div>
    </section>
  );
}
