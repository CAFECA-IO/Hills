/** 初次啟動與加入（ui-spec「初次啟動與加入」、technical-design §16.2–16.4）。 */
import { useEffect, useRef, useState } from 'react';
import { api, EVENTS, listen, type Code } from './api';
import { defaultDeviceName } from './hooks';
import { getLocale, t, type MessageKey } from './i18n';
import { Button, Card, Centered, CodeBox, ErrorText, Field, useAction } from './ui';

export type Start = 'create' | 'join' | 'link' | 'recover';

export function Welcome({ onPick }: { onPick: (s: Start) => void }) {
  const items: [Start, MessageKey, MessageKey][] = [
    ['create', 'welcome.create', 'welcome.create.desc'],
    ['join', 'welcome.join', 'welcome.join.desc'],
    ['link', 'welcome.link', 'welcome.link.desc'],
    ['recover', 'welcome.recover', 'welcome.recover.desc'],
  ];
  return (
    <Centered title={t('welcome.title')}>
      <p className="text-muted">{t('welcome.subtitle')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {items.map(([k, title, desc]) => (
          <button
            key={k}
            type="button"
            onClick={() => onPick(k)}
            className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-4 text-left hover:border-primary focus-visible:outline-2 focus-visible:outline-primary"
          >
            <span className="font-medium">{t(title)}</span>
            <span className="text-sm text-muted">{t(desc)}</span>
          </button>
        ))}
      </div>
    </Centered>
  );
}

const required = (v: string) => (v.trim() ? null : t('field.required'));

function Actions({
  onBack,
  submit,
  busy,
  busyLabel,
  onSubmit,
}: {
  onBack: () => void;
  submit: string;
  busy: boolean;
  busyLabel: string;
  onSubmit: () => void;
}) {
  return (
    <div className="flex justify-between">
      <Button variant="secondary" onClick={onBack} disabled={busy}>
        {t('common.back')}
      </Button>
      <Button onClick={onSubmit} disabled={busy}>
        {busy ? busyLabel : submit}
      </Button>
    </div>
  );
}

export function CreateOrgForm({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [mailboxCode, setMailbox] = useState('');
  const [orgName, setOrg] = useState('');
  const [myName, setMe] = useState('');
  const [deviceName, setDevice] = useState(defaultDeviceName());
  const [teamName, setTeam] = useState(t('field.teamName.default'));
  const [touched, setTouched] = useState(false);
  const { busy, error, attempt } = useAction();
  const submit = async () => {
    setTouched(true);
    if ([mailboxCode, orgName, myName, deviceName, teamName].some((v) => !v.trim())) return;
    const ok = await attempt(() =>
      api.createOrg({
        mailboxCode,
        orgName,
        myName,
        deviceName,
        teamName,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        locale: getLocale(),
      }),
    );
    if (ok) onDone();
  };
  return (
    <Centered title={t('create.title')}>
      <Card className="flex flex-col gap-4">
        <Field
          label={t('field.mailboxCode')}
          hint={t('field.mailboxCode.hint')}
          value={mailboxCode}
          onChange={setMailbox}
          multiline
          autoFocus
          error={touched ? required(mailboxCode) : null}
        />
        <Field
          label={t('field.orgName')}
          value={orgName}
          onChange={setOrg}
          error={touched ? required(orgName) : null}
        />
        <Field
          label={t('field.teamName')}
          value={teamName}
          onChange={setTeam}
          error={touched ? required(teamName) : null}
        />
        <Field
          label={t('field.myName')}
          value={myName}
          onChange={setMe}
          error={touched ? required(myName) : null}
        />
        <Field
          label={t('field.deviceName')}
          value={deviceName}
          onChange={setDevice}
          error={touched ? required(deviceName) : null}
        />
      </Card>
      <ErrorText message={error} />
      <Actions
        onBack={onBack}
        submit={t('create.submit')}
        busy={busy}
        busyLabel={t('create.working')}
        onSubmit={() => void submit()}
      />
    </Centered>
  );
}

export function JoinForm({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [device, setDevice] = useState(defaultDeviceName());
  const [touched, setTouched] = useState(false);
  const { busy, error, attempt } = useAction();
  const submit = async () => {
    setTouched(true);
    if ([code, name, device].some((v) => !v.trim())) return;
    if (await attempt(() => api.joinOrg(code, name, device))) onDone();
  };
  return (
    <Centered title={t('join.title')}>
      <Card className="flex flex-col gap-4">
        <Field
          label={t('field.inviteCode')}
          value={code}
          onChange={setCode}
          multiline
          autoFocus
          error={touched ? required(code) : null}
        />
        <Field
          label={t('field.myName')}
          value={name}
          onChange={setName}
          error={touched ? required(name) : null}
        />
        <Field
          label={t('field.deviceName')}
          value={device}
          onChange={setDevice}
          error={touched ? required(device) : null}
        />
      </Card>
      <ErrorText message={error} />
      <Actions
        onBack={onBack}
        submit={t('join.submit')}
        busy={busy}
        busyLabel={t('join.working')}
        onSubmit={() => void submit()}
      />
    </Centered>
  );
}

export function RecoverForm({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [words, setWords] = useState('');
  const [orgCode, setOrgCode] = useState('');
  const [device, setDevice] = useState(defaultDeviceName());
  const [touched, setTouched] = useState(false);
  const { busy, error, attempt } = useAction();
  const submit = async () => {
    setTouched(true);
    if ([words, orgCode, device].some((v) => !v.trim())) return;
    if (await attempt(() => api.recover(words, orgCode, device))) onDone();
  };
  return (
    <Centered title={t('recover.title')}>
      <p className="text-sm text-muted">{t('recover.desc')}</p>
      <Card className="flex flex-col gap-4">
        <Field
          label={t('field.words')}
          value={words}
          onChange={setWords}
          multiline
          autoFocus
          error={touched ? required(words) : null}
        />
        <Field
          label={t('field.orgCode')}
          hint={t('field.orgCode.hint')}
          value={orgCode}
          onChange={setOrgCode}
          multiline
          error={touched ? required(orgCode) : null}
        />
        <Field
          label={t('field.deviceName')}
          value={device}
          onChange={setDevice}
          error={touched ? required(device) : null}
        />
      </Card>
      <ErrorText message={error} />
      <Actions
        onBack={onBack}
        submit={t('recover.submit')}
        busy={busy}
        busyLabel={t('recover.working')}
        onSubmit={() => void submit()}
      />
    </Centered>
  );
}

/** 新裝置端綁定：輸入組織連線碼 → 顯示綁定碼 → 顯示 SAS → 等待舊裝置確認。 */
export function LinkNewDevice({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [orgCode, setOrgCode] = useState('');
  const [device, setDevice] = useState(defaultDeviceName());
  const [code, setCode] = useState<Code | null>(null);
  const [sas, setSas] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const { busy, error, run } = useAction();
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });

  useEffect(() => {
    const offs: Promise<() => void>[] = [
      listen<string | null>(EVENTS.linkSas, (s) => setSas(s)),
      listen<string | null>(EVENTS.linkDone, (err) => {
        if (err) setFailed(err);
        else done.current();
      }),
    ];
    return () => {
      offs.forEach((p) => void p.then((off) => off()));
    };
  }, []);

  const start = async () => {
    setTouched(true);
    if (!orgCode.trim() || !device.trim()) return;
    setFailed(null);
    setSas(null);
    const c = await run(() => api.linkStart(orgCode, device));
    if (c) setCode(c);
  };
  const back = () => {
    void api.linkCancel();
    onBack();
  };

  return (
    <Centered title={t('link.title')}>
      {!code ? (
        <>
          <Card className="flex flex-col gap-4">
            <Field
              label={t('field.orgCode')}
              hint={t('link.step1')}
              value={orgCode}
              onChange={setOrgCode}
              multiline
              autoFocus
              error={touched ? required(orgCode) : null}
            />
            <Field
              label={t('field.deviceName')}
              value={device}
              onChange={setDevice}
              error={touched ? required(device) : null}
            />
          </Card>
          <ErrorText message={error} />
          <Actions
            onBack={back}
            submit={t('link.start')}
            busy={busy}
            busyLabel={t('common.loading')}
            onSubmit={() => void start()}
          />
        </>
      ) : (
        <>
          <Card className="flex flex-col gap-4">
            {sas ? (
              <div className="flex flex-col items-center gap-3 py-4">
                <p>{t('link.sas')}</p>
                <p className="font-mono text-4xl tracking-[0.3em]" aria-live="polite">
                  {sas}
                </p>
                <p className="text-sm text-muted">{t('link.sasWait')}</p>
              </div>
            ) : (
              <>
                <p className="text-sm">{t('link.showCode')}</p>
                <CodeBox code={code.code} qrSvg={code.qrSvg} />
                <p className="text-center text-sm text-muted" aria-live="polite">
                  {t('link.waiting')}
                </p>
              </>
            )}
          </Card>
          {failed && <ErrorText message={t('link.failed', { message: failed })} />}
          <div>
            <Button variant="secondary" onClick={back}>
              {t('common.cancel')}
            </Button>
          </div>
        </>
      )}
    </Centered>
  );
}

function pickPositions(n: number): number[] {
  const picks = new Set<number>();
  const buf = new Uint32Array(1);
  while (picks.size < Math.min(3, n)) {
    crypto.getRandomValues(buf);
    picks.add((buf[0] ?? 0) % n);
  }
  return [...picks].sort((a, b) => a - b);
}

/** 復原詞顯示 + 隨機 3 字驗證（ui-spec「復原詞畫面」，語言跟隨介面 D38）。 */
export function PhraseFlow({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [words, setWords] = useState<string[] | null>(null);
  const [ack, setAck] = useState(false);
  const [verify, setVerify] = useState(false);
  const [positions, setPositions] = useState<number[]>([]);
  const [answers, setAnswers] = useState<string[]>(['', '', '']);
  const [wrong, setWrong] = useState(false);
  const { error, run } = useAction();

  useEffect(() => {
    void run(() => api.recoveryWords(getLocale())).then((w) => {
      if (w) {
        setWords(w);
        setPositions(pickPositions(w.length));
      }
    });
    // 只在開啟時讀取一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!words) {
    return (
      <Centered title={t('phrase.title')}>
        <ErrorText message={error} />
        {!error && <p className="text-muted">{t('common.loading')}</p>}
      </Centered>
    );
  }

  if (verify) {
    const check = () => {
      const ok = positions.every(
        (p, i) => (answers[i] ?? '').trim().toLowerCase() === (words[p] ?? '').toLowerCase(),
      );
      setWrong(!ok);
      if (ok) {
        setWords(null);
        onDone();
      }
    };
    return (
      <Centered title={t('phrase.verify.title')}>
        <p className="text-sm text-muted">{t('phrase.verify.desc')}</p>
        <Card className="flex flex-col gap-4">
          {positions.map((p, i) => (
            <Field
              key={p}
              label={t('phrase.verify.word', { n: p + 1 })}
              value={answers[i] ?? ''}
              autoFocus={i === 0}
              onChange={(v) => setAnswers((a) => a.map((x, j) => (j === i ? v : x)))}
            />
          ))}
          {wrong && (
            <p role="alert" className="text-sm text-danger">
              {t('phrase.verify.wrong')}
            </p>
          )}
        </Card>
        <div className="flex justify-between">
          <Button variant="secondary" onClick={() => setVerify(false)}>
            {t('common.back')}
          </Button>
          <Button onClick={check}>{t('phrase.verify.submit')}</Button>
        </div>
      </Centered>
    );
  }

  return (
    <Centered title={t('phrase.title')}>
      <p className="text-sm text-muted">{t('phrase.desc')}</p>
      <Card>
        <ol className="grid grid-cols-2 gap-x-6 gap-y-2 font-mono sm:grid-cols-4 select-none">
          {words.map((w, i) => (
            <li key={i} className="flex gap-2">
              <span className="w-6 text-right text-muted">{i + 1}</span>
              <span>{w}</span>
            </li>
          ))}
        </ol>
      </Card>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        {t('phrase.ack')}
      </label>
      <div className="flex justify-between">
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        ) : (
          <span />
        )}
        <Button disabled={!ack} onClick={() => setVerify(true)}>
          {t('phrase.toVerify')}
        </Button>
      </div>
    </Centered>
  );
}

/** 組織根金鑰備份（設定密碼後存到「下載」資料夾）。 */
export function BackupForm({ onDone, onSkip }: { onDone?: () => void; onSkip?: () => void }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [touched, setTouched] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const pwError = pw.length < 12 ? t('field.passwordShort') : null;
  const pw2Error = pw !== pw2 ? t('field.passwordMismatch') : null;
  const submit = async () => {
    setTouched(true);
    if (pwError || pw2Error) return;
    const path = await run(() => api.exportOrgRootBackup(pw));
    if (path) {
      setSaved(path);
      setPw('');
      setPw2('');
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{t('backup.desc')}</p>
      {saved ? (
        <p role="status" className="rounded border border-primary px-3 py-2 text-sm break-all">
          {t('backup.saved', { path: saved })}
        </p>
      ) : (
        <>
          <Field
            label={t('field.password')}
            type="password"
            value={pw}
            onChange={setPw}
            error={touched ? pwError : null}
          />
          <Field
            label={t('field.passwordAgain')}
            type="password"
            value={pw2}
            onChange={setPw2}
            error={touched ? pw2Error : null}
          />
        </>
      )}
      <ErrorText message={error} />
      <div className="flex justify-between">
        {onSkip && !saved ? (
          <Button variant="secondary" onClick={onSkip}>
            {t('backup.skip')}
          </Button>
        ) : (
          <span />
        )}
        {saved ? (
          onDone && <Button onClick={onDone}>{t('common.done')}</Button>
        ) : (
          <Button disabled={busy} onClick={() => void submit()}>
            {t('backup.submit')}
          </Button>
        )}
      </div>
    </div>
  );
}

export function BackupStep({ onDone }: { onDone: () => void }) {
  return (
    <Centered title={t('backup.title')}>
      <Card>
        <BackupForm onDone={onDone} onSkip={onDone} />
      </Card>
    </Centered>
  );
}

export function Pending() {
  return (
    <Centered title={t('pending.title')}>
      <Card>
        <p className="text-sm">{t('pending.desc')}</p>
      </Card>
    </Centered>
  );
}
