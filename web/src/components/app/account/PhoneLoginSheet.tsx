import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Smartphone, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { LibraryPhoneLoginState } from '../../../library/core/contracts/account';

// src/components/app/account/PhoneLoginSheet.tsx
// 手机号验证码登录的表单（酷狗在没有后端实例时；扫码面板在这类平台上没有二维码可要）。
// 只画表单：发码、提交、关闭都由账户 controller 提供，状态（在途 / 错误 / 上次发码时间）从快照读。

const RESEND_COOLDOWN_SECONDS = 60;
// 中国大陆手机号：1 开头的 11 位数字。只做形状校验，号码是否存在由服务端回答。
const MOBILE_PATTERN = /^1\d{10}$/;

type PhoneLoginSheetProps = {
    providerLabel: string;
    state: LibraryPhoneLoginState;
    onSendCode: (mobile: string) => Promise<unknown>;
    onSubmit: (mobile: string, code: string) => Promise<unknown>;
    onClose: () => void;
};

const PhoneLoginSheet: React.FC<PhoneLoginSheetProps> = ({
    providerLabel,
    state,
    onSendCode,
    onSubmit,
    onClose,
}) => {
    const { t } = useTranslation();
    const [mobile, setMobile] = useState('');
    const [code, setCode] = useState('');
    // 倒计时每一秒推进一次；只影响重发按钮的可用性与文案。
    const [nowTick, setNowTick] = useState(() => Date.now());

    useEffect(() => {
        if (!state.codeSentAt) return undefined;
        const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [state.codeSentAt]);

    const cooldown = useMemo(() => {
        if (!state.codeSentAt) return 0;
        const elapsed = Math.floor((nowTick - state.codeSentAt) / 1000);
        return Math.max(0, RESEND_COOLDOWN_SECONDS - elapsed);
    }, [nowTick, state.codeSentAt]);

    const mobileValid = MOBILE_PATTERN.test(mobile);
    const sending = state.pending === 'code';
    const loggingIn = state.pending === 'login';
    const canSend = mobileValid && !sending && !loggingIn && cooldown === 0;
    const canSubmit = mobileValid && code.trim().length >= 4 && !sending && !loggingIn;

    return (
        <div
            className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4 backdrop-blur-md"
            role="dialog"
            aria-modal="true"
            aria-label={t('kugouLogin.title')}
        >
            <div className="w-full max-w-sm rounded-3xl border border-white/15 bg-zinc-800/95 p-6 text-left shadow-2xl shadow-black/30">
                <div className="mb-4 flex items-start justify-between gap-3">
                    <div>
                        <h3 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>
                            {t('kugouLogin.title')}
                        </h3>
                        <p className="mt-1 text-[11px] leading-snug opacity-65" style={{ color: 'var(--text-secondary)' }}>
                            {t('kugouLogin.hint')}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={t('kugouLogin.title')}
                        className="shrink-0 rounded-full bg-white/5 p-1 opacity-50 transition-opacity hover:opacity-100"
                    >
                        <X size={16} />
                    </button>
                </div>

                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.16em] opacity-45" htmlFor="kugou-phone">
                    {t('kugouLogin.mobile')}
                </label>
                <div className="mb-3 flex items-center gap-2">
                    <div className="flex flex-1 items-center gap-2 rounded-2xl border border-white/15 bg-white/10 px-3 py-2">
                        <Smartphone size={14} className="opacity-40" aria-hidden />
                        <input
                            id="kugou-phone"
                            type="tel"
                            inputMode="tel"
                            autoComplete="tel"
                            maxLength={11}
                            value={mobile}
                            placeholder={providerLabel}
                            onChange={event => setMobile(event.target.value.replace(/\D/g, '').slice(0, 11))}
                            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                            style={{ color: 'var(--text-primary)' }}
                        />
                    </div>
                    <button
                        type="button"
                        disabled={!canSend}
                        onClick={() => { void onSendCode(mobile); }}
                        className="shrink-0 rounded-2xl border border-white/15 bg-white/10 px-3 py-2 text-xs font-semibold disabled:opacity-35"
                        style={{ color: 'var(--text-primary)' }}
                    >
                        {sending
                            ? t('kugouLogin.sending')
                            : cooldown > 0
                                ? t('kugouLogin.resend', { seconds: cooldown })
                                : t('kugouLogin.send')}
                    </button>
                </div>

                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.16em] opacity-45" htmlFor="kugou-code">
                    {t('kugouLogin.code')}
                </label>
                <input
                    id="kugou-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={8}
                    value={code}
                    onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 8))}
                    className="mb-3 w-full rounded-2xl border border-white/15 bg-white/10 px-3 py-2 text-sm tracking-[0.3em] outline-none"
                    style={{ color: 'var(--text-primary)' }}
                />

                {state.error && (
                    <p className="mb-3 text-[11px] leading-snug text-red-400" role="alert">
                        {t('kugouLogin.failed', { message: state.error })}
                    </p>
                )}

                <button
                    type="button"
                    disabled={!canSubmit}
                    onClick={() => { void onSubmit(mobile, code.trim()); }}
                    className="flex w-full items-center justify-center gap-2 rounded-2xl bg-green-500/90 px-4 py-2.5 text-sm font-semibold text-black disabled:opacity-35"
                >
                    {loggingIn && <Loader2 size={14} className="animate-spin" aria-hidden />}
                    {loggingIn ? t('kugouLogin.loggingIn') : t('kugouLogin.submit')}
                </button>
            </div>
        </div>
    );
};

export default PhoneLoginSheet;
