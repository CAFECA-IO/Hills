/**
 * 週一方向時刻（ui-spec「週一方向時刻」v0.23，第 4 批；設計畫布 D8；technical-design §16.14 v0.22）：
 * 上週的方向與四週軌跡、負責人的這週重點，以及把這週的任務連到週目標並即時預測方向。
 * 預測只在本機計算；按「好，開始這一週」才寫入任務的 planItemId。
 */
import { useMemo, useState } from 'react';
import {
  api,
  type DirectionRules,
  type DirectionWeek,
  type MemberView,
  type PlanView,
  type Task,
  type TeamView,
  type WeekNote,
} from './api';
import { DirectionCompass, type CompassPerson } from './compass';
import { pastTrail, predictAngle, quarterElapsed, sideOf, unlinkedThisWeek } from './drift-utils';
import { taskInput, type ToastState } from './goals-guided';
import type { Periods } from './goals-utils';
import { t } from './i18n';
import { lookOf } from './summit';
import { Button, Card, ErrorText, LinkButton, Select, useAction } from './ui';

const SEEN_KEY = 'hills.goals.weeklySeen';

/** 本週是否已看過週一方向時刻（記在本機）。 */
export function weeklySeen(week: string): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === week;
  } catch {
    return true;
  }
}

function markSeen(week: string) {
  try {
    localStorage.setItem(SEEN_KEY, week);
  } catch {
    // 忽略
  }
}

export function WeeklyCheck({
  me,
  members,
  teams,
  weeks,
  rules,
  plans,
  tasks,
  weekNotes,
  periods,
  timezone,
  onLater,
  onDone,
  notify,
}: {
  me: MemberView;
  members: MemberView[];
  teams: TeamView[];
  weeks: DirectionWeek[];
  rules: DirectionRules;
  plans: PlanView[];
  tasks: Task[];
  weekNotes: WeekNote[];
  periods: Periods;
  timezone: string;
  onLater: () => void;
  onDone: () => void;
  notify: (s: ToastState) => void;
}) {
  const [picks, setPicks] = useState<Record<string, string>>({});
  const { busy, error, attempt } = useAction();
  const listed = useMemo(
    () => unlinkedThisWeek(me.id, tasks, periods.week, timezone),
    [me.id, tasks, periods.week, timezone],
  );
  const weekGoals = plans.filter((p) => p.mine && p.level === 'week' && p.period === periods.week);
  const thisWeek = weeks.find((w) => w.week === periods.week) ?? null;
  const { points, change } = pastTrail(weeks, periods.week);
  const last = points[points.length - 1] ?? null;
  const predicted = predictAngle(thisWeek, listed, picks, plans);
  const limit = 90 * (1 - rules.minAlignedShare / 100);
  const notes = teams
    .filter((x) => x.members.includes(me.id) || x.leads.includes(me.id))
    .map((x) => weekNotes.find((n) => n.team === x.id && n.week === periods.week))
    .filter((n): n is WeekNote => Boolean(n));
  const side = sideOf(me.id);
  const progress = thisWeek?.quarterProgress ?? last?.progress ?? null;
  const people: CompassPerson[] = [];
  if (last) {
    people.push({
      id: me.id,
      name: me.name,
      look: lookOf(me),
      angle: last.angle,
      progress: last.progress,
      state: last.angle <= limit ? 'ok' : 'warn',
      unaligned: false,
      isMe: true,
      side,
      trail: points.slice(0, -1),
    });
  }
  if (predicted !== null) {
    people.push({
      id: 'ghost',
      name: t('weekly.ghost'),
      look: lookOf(me),
      angle: predicted,
      progress,
      state: 'ok',
      unaligned: false,
      isMe: false,
      ghost: true,
      tag: t('weekly.ghost'),
      side,
    });
  }

  const start = async () => {
    const chosen = listed.filter((x) => picks[x.id]);
    const ok = await attempt(async () => {
      for (const x of chosen) {
        await api.updateTask(x.team, x.id, taskInput(x, { planItemId: picks[x.id] }));
      }
    });
    if (!ok) return;
    markSeen(periods.week);
    if (chosen.length > 0) notify({ message: t('weekly.saved', { n: chosen.length }) });
    onDone();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <div className="flex items-center gap-3">
        <h2 className="flex-1 text-lg font-bold">{t('weekly.title')}</h2>
        <LinkButton onClick={onLater}>{t('weekly.later')}</LinkButton>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="flex flex-col gap-2">
          <p className="text-base font-bold">
            {last
              ? t('weekly.lastWeek', { deg: Math.round(last.angle) }) +
                (change ? t(change === 'tighter' ? 'weekly.tighter' : 'weekly.looser') : '')
              : t('weekly.noData')}
          </p>
          <p className="text-xs text-muted">{t('weekly.private')}</p>
          {people.length > 0 && (
            <div className="flex justify-center pt-2">
              <DirectionCompass
                mode="me"
                width={520}
                height={330}
                radius={220}
                today={quarterElapsed(periods) * 100}
                teamLabel={teams.find((x) => x.members.includes(me.id))?.name ?? ''}
                people={people}
                label={t('weekly.compass')}
              />
            </div>
          )}
        </Card>
        <div className="flex flex-col gap-3">
          {notes.map((n) => (
            <div
              key={n.team}
              className="flex flex-col gap-1 rounded-card border border-level-year bg-surface p-4"
            >
              <p className="text-xs font-bold text-level-year">
                {t('weekly.note', {
                  name:
                    n.author === me.id
                      ? t('drift.you')
                      : (members.find((m) => m.id === n.author)?.name ?? n.author),
                })}
              </p>
              <p className="text-sm">{n.text}</p>
            </div>
          ))}
          <Card className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <h3 className="text-base font-bold">{t('weekly.ask')}</h3>
              <p className="text-xs text-muted">{t('weekly.askHint')}</p>
            </div>
            {listed.length === 0 ? (
              <p className="text-sm text-muted">{t('weekly.none')}</p>
            ) : (
              <>
                {weekGoals.length === 0 && (
                  <p className="text-xs text-warning">{t('weekly.noWeekGoal')}</p>
                )}
                <ul className="flex flex-col divide-y divide-line">
                  {listed.map((x) => (
                    <li key={x.id} className="flex items-center gap-3 py-2">
                      <span className="min-w-0 flex-1 truncate text-sm">{x.title}</span>
                      <Select
                        aria-label={t('weekly.pick', { title: x.title })}
                        className="w-48"
                        value={x.id in picks ? picks[x.id] : '-'}
                        onChange={(e) => {
                          const v = e.target.value;
                          setPicks((old) => {
                            const next = { ...old };
                            if (v === '-') delete next[x.id];
                            else next[x.id] = v;
                            return next;
                          });
                        }}
                      >
                        <option value="-">{t('weekly.noGoal')}</option>
                        {weekGoals.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.title}
                          </option>
                        ))}
                        <option value="">{t('weekly.unrelated')}</option>
                      </Select>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {predicted !== null && (
              <p
                className={`rounded-control px-3.5 py-2.5 text-sm font-bold ${predicted <= limit ? 'border border-st-online text-st-online-text' : 'border border-warning text-warning'}`}
              >
                {t(predicted <= limit ? 'weekly.predict' : 'weekly.predictOff', {
                  deg: Math.round(predicted),
                })}
              </p>
            )}
            <ErrorText message={error} />
            <div className="flex justify-end">
              <Button busy={busy} onClick={start}>
                {t('weekly.start')}
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
