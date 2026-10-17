import React, { useCallback, useState } from 'react';
import { AlertCircle, Check, Loader2, Server, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { describeProviderApiBase, getProviderApiBaseInput, normalizeProviderApiBase, setProviderApiBaseOverride } from '../../../services/onlineMusic/providerApiBase';
import { SettingsAnchor } from './navigation/SettingsAnchorContext';
import SettingsSectionHeading from './navigation/SettingsSectionHeading';

// src/components/modal/settings/NeteaseApiSettingsSection.tsx
// 网易云 API 网关地址的设置项。桌面版不需要它（后端内置在主进程里），但网页版与安卓壳
// 没有那个后端：网易的接口不登录就不给音频地址，而它自己的客户端逻辑是一个 449 个路由的
// Node 服务，搬不进浏览器。所以手机上的网易只能指向一个自己部署的实例，这里就是填地址的地方。
//
// 上游把它做成了构建期变量 VITE_NETEASE_API_BASE——那是给自部署 Web 版用的。装在手机上的
// APK 没法重新构建，所以这个输入框写的是运行时覆盖值，改完立刻生效、不需要重新打包。
//
// 这里只从 providerApiBase 取"哪个网关生效"，不碰 services/netease：架构契约
// （test/unit/onlineMusic/omniArchitecture.test.ts）禁止 UI 层导入 provider 内部实现。

type TestStatus = 'idle' | 'testing' | 'success' | 'failed';

const NeteaseApiSettingsSection: React.FC = () => {
    const { t } = useTranslation();
    // 生效地址是"读一次快照"而不是派生值：它来自 localStorage，React 看不到它的变化，
    // 所以每次写入之后显式重读，而不是指望重渲染。
    const [effective, setEffective] = useState(() => describeProviderApiBase('netease'));
    const [input, setInput] = useState(() => getProviderApiBaseInput('netease'));
    const [invalid, setInvalid] = useState(false);
    const [testStatus, setTestStatus] = useState<TestStatus>('idle');

    const commit = useCallback(() => {
        const next = input.trim();
        // 空输入是"清除覆盖值"，回落到构建期地址，不是错误。
        if (!next) {
            setProviderApiBaseOverride('netease', null);
            setEffective(describeProviderApiBase('netease'));
            setInvalid(false);
            setTestStatus('idle');
            return;
        }
        const saved = setProviderApiBaseOverride('netease', next);
        setInvalid(!saved);
        if (saved) {
            // 回显整理后的地址：用户打的是 example.com，真正生效的是 https://example.com，
            // 让他看到系统实际会请求什么，比留着他原样的输入更诚实。
            setInput(saved);
            setEffective(describeProviderApiBase('netease'));
            setTestStatus('idle');
        }
    }, [input]);

    const clear = useCallback(() => {
        setProviderApiBaseOverride('netease', null);
        setInput('');
        setEffective(describeProviderApiBase('netease'));
        setInvalid(false);
        setTestStatus('idle');
    }, []);

    const test = useCallback(async () => {
        const base = normalizeProviderApiBase(input) ?? effective.apiBase;
        if (!base) return;
        setTestStatus('testing');
        try {
            // NeteaseCloudMusicApi 的搜索路由。一个真实请求胜过任何格式校验：地址通不通、
            // 实例有没有起来、CORS 放不放行，只有发出去才知道。
            const response = await fetch(`${base}/search?keywords=test&limit=1`, { method: 'GET' });
            setTestStatus(response.ok ? 'success' : 'failed');
        } catch (error) {
            console.warn('[NeteaseApi] Gateway test failed:', error);
            setTestStatus('failed');
        }
    }, [effective.apiBase, input]);

    const sourceLabel = {
        electron: t('options.neteaseApiBaseSourceElectron'),
        runtime: t('options.neteaseApiBaseSourceRuntime'),
        build: t('options.neteaseApiBaseSourceBuild'),
        unset: t('options.neteaseApiBaseSourceUnset'),
    }[effective.source];

    return (
        <SettingsAnchor anchorId="neteaseApi" label={t('options.neteaseApiBase')}>
            <SettingsSectionHeading icon={Server} label={t('options.neteaseApiBase')} />
            <div className="bg-white/5 p-4 rounded-xl border border-white/5 space-y-4">
                <p className="text-xs leading-relaxed opacity-70" style={{ color: 'var(--text-secondary)' }}>
                    {t('options.neteaseApiBaseHint')}
                </p>

                <div className="space-y-2">
                    <label className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        {t('options.neteaseApiBase')}
                    </label>
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={input}
                            onChange={(event) => { setInput(event.target.value); setInvalid(false); }}
                            onBlur={commit}
                            onKeyDown={(event) => { if (event.key === 'Enter') commit(); }}
                            placeholder={t('options.neteaseApiBasePlaceholder')}
                            spellCheck={false}
                            autoComplete="off"
                            className={`flex-1 px-3 py-2 bg-white/5 border rounded-lg text-sm focus:outline-none transition-colors ${
                                invalid ? 'border-red-500/60' : 'border-white/10 focus:border-white/30'
                            }`}
                            style={{ color: 'var(--text-primary)' }}
                        />
                        <button
                            onClick={() => void test()}
                            disabled={testStatus === 'testing' || (!input.trim() && !effective.apiBase)}
                            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 disabled:opacity-40 disabled:cursor-not-allowed"
                            style={{ color: 'var(--text-primary)' }}
                        >
                            {testStatus === 'testing' ? <Loader2 size={16} className="animate-spin" />
                                : testStatus === 'success' ? <Check size={16} className="text-emerald-400" />
                                    : testStatus === 'failed' ? <AlertCircle size={16} className="text-red-400" />
                                        : <Server size={16} />}
                            {t('options.neteaseApiBaseTest')}
                        </button>
                        {Boolean(input.trim() || effective.source === 'runtime') && (
                            <button
                                onClick={clear}
                                title={t('options.neteaseApiBaseClear')}
                                aria-label={t('options.neteaseApiBaseClear')}
                                className="px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center bg-white/10 hover:bg-red-500/20 text-red-300"
                            >
                                <Trash2 size={16} />
                            </button>
                        )}
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    <span className="opacity-70">{t('options.neteaseApiBaseEffective')}</span>
                    <code className="px-1.5 py-0.5 rounded bg-white/5 font-mono break-all">
                        {effective.apiBase ?? t('options.neteaseApiBaseNone')}
                    </code>
                    <span className="opacity-60">· {sourceLabel}</span>
                </div>

                {invalid && (
                    <p className="text-xs text-red-400">{t('options.neteaseApiBaseInvalid')}</p>
                )}
                {testStatus === 'failed' && (
                    <p className="text-xs text-red-400">{t('options.neteaseApiBaseTestFailed')}</p>
                )}
                {testStatus === 'success' && (
                    <p className="text-xs text-emerald-400">{t('options.neteaseApiBaseTestOk')}</p>
                )}
            </div>
        </SettingsAnchor>
    );
};

export default NeteaseApiSettingsSection;
