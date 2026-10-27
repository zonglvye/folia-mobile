import { useCallback, useEffect, useRef } from 'react';
import { omni } from '../services/onlineMusic/omni';
import { clearProviderAccountSnapshot, loadProviderAccountSnapshot, saveProviderAccountSnapshot } from '../services/onlineMusic/providerAccountCache';
import { useOnlineProviderAccountStore } from '../stores/useOnlineProviderAccountStore';
import { OnlineProviderError } from '../types/onlineMusic';
import type { MediaId, ProviderCollection } from '../types/onlineMusic';

// src/hooks/useQishuiLibrary.ts
//
// 汽水的账户刷新与登出。汽水没有自建后端：登录态就是页面里那个 localStorage 会话，
// 没登录时 `login_status` 直接给 null（不联网、不抛错），所以这里把「没有账号」落成
// `clearAccount` —— status 变 anonymous、hydration 变 ready，首页就不会一直卡在解析中，
// 在线页签按游客态显示（检索、播放、歌词照常，歌单等登录后再出现）。
export const useQishuiLibrary = () => {
    const generation = useRef(0);
    const pendingSave = useRef<Promise<unknown>>(Promise.resolve());

    const settleGuest = useCallback(async () => {
        const store = useOnlineProviderAccountStore.getState();
        store.clearAccount('qishui');
        await pendingSave.current.catch(() => {});
        await clearProviderAccountSnapshot('qishui');
    }, []);

    const refresh = useCallback(async () => {
        const current = ++generation.current;
        const store = useOnlineProviderAccountStore.getState();
        try {
            if (!omni.getProviderAvailability('qishui').configured || !omni.getProviderCapabilities('qishui').auth) {
                await settleGuest();
                return false;
            }
            store.updateAccount('qishui', { freshness: 'refreshing', error: undefined });
            const user = await omni.getLoginStatus('qishui');
            if (generation.current !== current) return false;
            if (!user) {
                await settleGuest();
                return false;
            }
            // 换账号时先丢掉上一个账号的缓存，再按 id 认领本地快照（与其它 provider 一致）。
            const visibleUser = useOnlineProviderAccountStore.getState().accounts.qishui?.user;
            if (!visibleUser || String(visibleUser.id) !== String(user.id)) {
                store.clearAccount('qishui');
                const snapshot = await loadProviderAccountSnapshot('qishui').catch(() => null);
                if (generation.current !== current) return false;
                const matching = snapshot && String(snapshot.user.id) === String(user.id) ? snapshot : null;
                store.updateAccount('qishui', { status: 'authenticated', user,
                    collections: matching?.collections || [], likedSongIds: matching?.likedSongIds || [],
                    hydration: 'ready', freshness: 'refreshing', lastUpdatedAt: matching?.savedAt, error: undefined });
            }
            const likesBeforeRefresh = useOnlineProviderAccountStore.getState().accounts.qishui.likedSongIds;
            const collections: ProviderCollection[] = [];
            const capabilities = omni.getProviderCapabilities('qishui');
            let offset = 0;
            if (capabilities.userLibrary) {
                while (true) {
                    const page = await omni.getProviderUserPlaylists('qishui', user.id, { offset, limit: 50 });
                    if (generation.current !== current) return false;
                    collections.push(...page.items);
                    if (!page.hasMore || page.nextOffset <= offset) break;
                    offset = page.nextOffset;
                }
            }
            const fetchedLikedSongIds: MediaId[] = capabilities.likes ? await omni.getProviderLikedSongIds('qishui', user.id) : [];
            if (generation.current !== current) return false;
            const save = pendingSave.current.catch(() => {}).then(() => {
                if (generation.current !== current) return null;
                // Omni 每次红心变更后会换掉这个数组；刷新期间用户点过就保留新的。
                const latestLikes = useOnlineProviderAccountStore.getState().accounts.qishui.likedSongIds;
                const likedSongIds = latestLikes === likesBeforeRefresh ? fetchedLikedSongIds : latestLikes;
                store.updateAccount('qishui', { status: 'authenticated', user, collections, likedSongIds,
                    hydration: 'ready', error: undefined });
                return saveProviderAccountSnapshot('qishui', { user, collections, likedSongIds });
            });
            pendingSave.current = save;
            const saved = await save;
            if (generation.current !== current) return false;
            if (!saved) return false;
            store.updateAccount('qishui', { freshness: 'fresh', lastUpdatedAt: saved.savedAt });
            return true;
        } catch (error) {
            if (generation.current !== current) return false;
            if (error instanceof OnlineProviderError && error.code === 'auth-required') {
                await settleGuest();
            } else {
                store.updateAccount('qishui', { hydration: 'ready', freshness: 'error',
                    status: useOnlineProviderAccountStore.getState().accounts.qishui?.user ? 'authenticated' : 'anonymous',
                    error: 'qishui-refresh-failed' });
            }
            return false;
        }
    }, [settleGuest]);

    const logout = useCallback(async () => {
        generation.current++;
        useOnlineProviderAccountStore.getState().clearAccount('qishui');
        await pendingSave.current.catch(() => {});
        await Promise.all([omni.logout('qishui'), clearProviderAccountSnapshot('qishui')]);
    }, []);

    useEffect(() => {
        // 启动时先确认登录态再显示缓存：没有会话时这一步把账号落成游客态。
        useOnlineProviderAccountStore.getState().clearAccount('qishui');
        void refresh();
        return () => { generation.current++; };
    }, [refresh]);

    return { refresh, logout };
};
