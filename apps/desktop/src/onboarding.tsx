/** 初次啟動、以 CAFECA 登入加入（ui-spec「初次啟動與加入」、technical-design §17、D41）。 */
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, type OnboardArgs, type SignInInfo } from './api';
import { defaultDeviceName, useNodeEvents } from './hooks';
import { getLocale, t, type MessageKey } from './i18n';
import { Button, Card, Centered, Checkbox, ErrorText, Field, Pressable, useAction } from './ui';

export type Start = 'create' | 'join';

export function Welcome({ onPick }: { onPick: (s: Start) => void }) {
  const items: [Start, MessageKey, MessageKey][] = [
    ['create', 'welcome.create', 'welcome.create.desc'],
    ['join', 'welcome.join', 'welcome.join.desc'],
  ];
  return (
    <Centered title={t('welcome.title')}>
      <p className="text-muted">{t('welcome.subtitle')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {items.map(([k, title, desc]) => (
          <Pressable
            key={k}
            onClick={() => onPick(k)}
            className="flex flex-col gap-1 rounded-card bg-surface p-4 shadow-sm hover:bg-primary-soft"
          >
            <span className="font-medium">{t(title)}</span>
            <span className="text-sm text-muted">{t(desc)}</span>
          </Pressable>
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

/** 完成後的去向：created → 匯出備份；approval → 等待核准；linked → 直接進入。 */
export type Finished = 'created' | 'approval' | 'linked';

export function CreateOrgForm({
  onBack,
  onDone,
  devLogin = false,
}: {
  onBack: () => void;
  onDone: (f: Finished) => void;
  /** debug 建置顯示測試帳號欄位（D44） */
  devLogin?: boolean;
}) {
  // 自架組織可在建置時設定預設值（ui-spec「初次啟動與加入」；repo 不內建，D20）
  const [mailboxCode, setMailbox] = useState(
    import.meta.env.VITE_HILLS_DEFAULT_MAILBOX?.trim() ?? '',
  );
  const [orgName, setOrg] = useState('');
  const [myName, setMe] = useState('');
  const [deviceName, setDevice] = useState(defaultDeviceName());
  const [teamName, setTeam] = useState(t('field.teamName.default'));
  const [devAccount, setDevAccount] = useState('');
  const [touched, setTouched] = useState(false);
  const [args, setArgs] = useState<OnboardArgs | null>(null);
  if (args) {
    return <SignInFlow args={args} onBack={() => setArgs(null)} onDone={onDone} />;
  }
  const submit = () => {
    setTouched(true);
    if ([mailboxCode, orgName, myName, deviceName, teamName].some((v) => !v.trim())) return;
    setArgs({
      kind: 'create',
      code: mailboxCode,
      orgName,
      myName,
      deviceName,
      teamName,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: getLocale(),
      devAccount: devAccount.trim() || undefined,
    });
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
        {devLogin && <DevAccountField value={devAccount} onChange={setDevAccount} />}
      </Card>
      <Actions
        onBack={onBack}
        submit={t(devAccount.trim() ? 'dev.continue' : 'signin.continue')}
        busy={false}
        busyLabel={t('common.loading')}
        onSubmit={submit}
      />
    </Centered>
  );
}

export function JoinForm({
  onBack,
  onDone,
  devLogin = false,
}: {
  onBack: () => void;
  onDone: (f: Finished) => void;
  /** debug 建置顯示測試帳號欄位（D44） */
  devLogin?: boolean;
}) {
  const [code, setCode] = useState('');
  const [devAccount, setDevAccount] = useState('');
  const [name, setName] = useState('');
  const [device, setDevice] = useState(defaultDeviceName());
  const [touched, setTouched] = useState(false);
  const [args, setArgs] = useState<OnboardArgs | null>(null);
  if (args) {
    return <SignInFlow args={args} onBack={() => setArgs(null)} onDone={onDone} />;
  }
  const submit = () => {
    setTouched(true);
    if ([code, device].some((v) => !v.trim())) return;
    setArgs({
      kind: 'join',
      code,
      myName: name,
      deviceName: device,
      devAccount: devAccount.trim() || undefined,
    });
  };
  return (
    <Centered title={t('join.title')}>
      <Card className="flex flex-col gap-4">
        <Field
          label={t('field.orgCode')}
          hint={t('field.orgCode.hint')}
          value={code}
          onChange={setCode}
          multiline
          autoFocus
          error={touched ? required(code) : null}
        />
        <Field
          label={t('field.myName')}
          hint={t('join.nameHint')}
          value={name}
          onChange={setName}
        />
        <Field
          label={t('field.deviceName')}
          value={device}
          onChange={setDevice}
          error={touched ? required(device) : null}
        />
        {devLogin && <DevAccountField value={devAccount} onChange={setDevAccount} />}
      </Card>
      <Actions
        onBack={onBack}
        submit={t(devAccount.trim() ? 'dev.continue' : 'signin.continue')}
        busy={false}
        busyLabel={t('common.loading')}
        onSubmit={submit}
      />
    </Centered>
  );
}

/** 開發測試模式的測試帳號欄位（ui-spec「開發測試模式」，D44）。 */
function DevAccountField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label={t('dev.account')} hint={t('dev.accountHint')} value={value} onChange={onChange} />
  );
}

/** 每秒更新的目前時間（Unix 秒）。 */
function useNowSecs(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const POLL_MS = 2000;
/** 新裝置等待本人其他裝置的時間，逾時後主動提示還原（technical-design §17.6 步驟 6）。 */
const DEVICE_WAIT_SECS = 10 * 60;

type FlowState =
  | { s: 'starting' }
  | { s: 'signin'; info: SignInInfo }
  | { s: 'device'; since: number; handle: string | null }
  | { s: 'denied' }
  | { s: 'expired' }
  | { s: 'error'; message: string };

/** 「以 CAFECA 登入」畫面（ui-spec「以 CAFECA 登入」）：QR、在這台電腦開啟、確認碼、倒數。 */
export function SignInFlow({
  args,
  onBack,
  onDone,
}: {
  args: OnboardArgs;
  onBack: () => void;
  onDone: (f: Finished) => void;
}) {
  const [state, setState] = useState<FlowState>({ s: 'starting' });
  const [attempt, setAttempt] = useState(0);
  const [recover, setRecover] = useState<'ask' | 'go' | null>(null);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });

  // 開始登入
  useEffect(() => {
    let alive = true;
    api
      .onboardBegin(args)
      .then((info) => alive && setState({ s: 'signin', info }))
      .catch((e: unknown) => alive && setState({ s: 'error', message: errorMessage(e) }));
    return () => {
      alive = false;
    };
  }, [args, attempt]);

  // 輪詢進度
  const polling = state.s === 'signin' || state.s === 'device';
  useEffect(() => {
    if (!polling) return;
    let alive = true;
    const id = setInterval(() => {
      api
        .onboardPoll()
        .then((r) => {
          if (!alive) return;
          switch (r.step) {
            case 'signin':
              break;
            case 'device':
              setState((cur) =>
                cur.s === 'device'
                  ? cur
                  : { s: 'device', since: Math.floor(Date.now() / 1000), handle: r.handle },
              );
              break;
            case 'denied':
            case 'expired':
              setState({ s: r.step });
              break;
            default:
              done.current(r.step);
          }
        })
        .catch((e: unknown) => alive && setState({ s: 'error', message: errorMessage(e) }));
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [polling]);

  const now = useNowSecs();
  const cancel = () => {
    void api.onboardCancel();
    onBack();
  };
  const retry = () => {
    setState({ s: 'starting' });
    setAttempt((n) => n + 1);
  };

  if (recover === 'go') {
    return (
      <SignInFlow
        args={{
          kind: 'recover',
          code: args.code,
          deviceName: args.deviceName,
          devAccount: args.devAccount,
        }}
        onBack={() => setRecover(null)}
        onDone={onDone}
      />
    );
  }
  if (recover === 'ask') {
    return <RecoverConfirm onBack={() => setRecover(null)} onGo={() => setRecover('go')} />;
  }

  const title = t(args.kind === 'recover' ? 'recover.title' : 'signin.title');
  if (state.s === 'device') {
    const waited = now - state.since;
    return (
      <Centered title={t('device.title')}>
        <Card className="flex flex-col gap-3">
          {state.handle && (
            <p className="text-sm text-muted">{t('signin.as', { handle: state.handle })}</p>
          )}
          <p aria-live="polite">{t('device.desc')}</p>
          <p className="text-sm text-muted">{t('device.wait')}</p>
          {waited >= DEVICE_WAIT_SECS && (
            <p className="text-sm" role="status">
              {t('device.timeout')}
            </p>
          )}
        </Card>
        <div className="flex justify-between">
          <Button variant="secondary" onClick={cancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="secondary" onClick={() => setRecover('ask')}>
            {t('device.noOther')}
          </Button>
        </div>
      </Centered>
    );
  }
  return (
    <Centered title={title}>
      {state.s === 'starting' && <p className="text-muted">{t('common.loading')}</p>}
      {state.s === 'signin' &&
        (args.devAccount ? (
          <Card>
            <p aria-live="polite">{t('dev.signingIn', { name: args.devAccount })}</p>
          </Card>
        ) : (
          <SignInCard info={state.info} now={now} />
        ))}
      {(state.s === 'denied' || state.s === 'expired' || state.s === 'error') && (
        <Card className="flex flex-col gap-3">
          <p role="alert">
            {state.s === 'denied'
              ? t('signin.denied')
              : state.s === 'expired'
                ? t('signin.expired')
                : t('signin.failed', { message: state.message })}
          </p>
          <div>
            <Button onClick={retry}>{t('signin.retry')}</Button>
          </div>
        </Card>
      )}
      <div>
        <Button variant="secondary" onClick={cancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </Centered>
  );
}

function SignInCard({ info, now }: { info: SignInInfo; now: number }) {
  const { error, attempt } = useAction();
  const left = Math.max(0, info.expiresAt - now);
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, '0');
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-6">
        <div className="flex flex-col items-center gap-2">
          <div
            className="rounded bg-qr p-2"
            role="img"
            aria-label={t('signin.qr')}
            // 來源為本機 Rust（qrcode crate）產生的 SVG，不含外部輸入的標記
            dangerouslySetInnerHTML={{ __html: info.qrSvg }}
          />
          <span className="text-xs text-muted">{t('signin.scan')}</span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="text-sm text-muted">{t('signin.code')}</span>
          <span className="font-mono text-3xl tracking-widest" aria-live="polite">
            {info.code}
          </span>
          <span className="text-sm">{t('signin.codeHint')}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button onClick={() => void attempt(() => api.onboardOpenLink())}>
          {t('signin.openHere')}
        </Button>
        <span className="text-sm text-muted" role="timer">
          {t('signin.waiting', { time: `${mm}:${ss}` })}
        </span>
      </div>
      <ErrorText message={error} />
    </Card>
  );
}

/** 還原前說明限制（ui-spec「等待核准」還原）。 */
function RecoverConfirm({ onBack, onGo }: { onBack: () => void; onGo: () => void }) {
  const [ack, setAck] = useState(false);
  return (
    <Centered title={t('recover.title')}>
      <Card className="flex flex-col gap-3">
        <p className="text-sm">{t('recover.desc')}</p>
        <Checkbox
          label={t('recover.ack')}
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
        />
      </Card>
      <div className="flex justify-between">
        <Button variant="secondary" onClick={onBack}>
          {t('common.back')}
        </Button>
        <Button disabled={!ack} onClick={onGo}>
          {t('recover.submit')}
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
        <p
          role="status"
          className="rounded-control border border-primary px-3 py-2 text-sm break-all"
        >
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

export function Pending({ onReset }: { onReset: () => void }) {
  const [rejected, setRejected] = useState(false);
  const { busy, error, attempt } = useAction();
  useNodeEvents((name) => {
    if (name === 'rejected') setRejected(true);
  });
  return (
    <Centered title={t(rejected ? 'pending.rejected.title' : 'pending.title')}>
      <Card className="flex flex-col gap-3">
        <p className="text-sm">{t(rejected ? 'pending.rejected.desc' : 'pending.desc')}</p>
        {rejected && (
          <div>
            <Button
              disabled={busy}
              onClick={async () => {
                if (await attempt(() => api.resetLocalData())) onReset();
              }}
            >
              {t('pending.restart')}
            </Button>
          </div>
        )}
      </Card>
      <ErrorText message={error} />
    </Centered>
  );
}

/** 舊版資料（以復原詞與邀請碼建立）：清除後重新開始（technical-design §17.9）。 */
export function Legacy({ onReset }: { onReset: () => void }) {
  const { busy, error, attempt } = useAction();
  return (
    <Centered title={t('legacy.title')}>
      <Card className="flex flex-col gap-3">
        <p className="text-sm">{t('legacy.desc')}</p>
        <div>
          <Button
            variant="danger"
            disabled={busy}
            onClick={async () => {
              if (await attempt(() => api.resetLocalData())) onReset();
            }}
          >
            {t('legacy.reset')}
          </Button>
        </div>
      </Card>
      <ErrorText message={error} />
    </Centered>
  );
}
