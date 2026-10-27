import i18n from '../../../i18n/config';
import type { MediaId, OnlineCatalogProvider, OnlineLibraryProvider, ProviderCollection, ProviderPage } from '../../../types/onlineMusic';
import { OnlineProviderError } from '../../../types/onlineMusic';
import { normalizeQishuiCollection, normalizeQishuiSong, record, type QishuiRecord } from './qishuiNormalize';
import { requestQishui } from './qishuiTransport';
import { createQishuiSceneCover } from './qishuiSceneCover';

// src/services/onlineMusic/qishui/qishuiCatalog.ts
// Catalogue and account collection reads; paging metadata comes from the package.
//
// 与上游的差异只有一处：`getLikedSongIds`。上游返回 `{ ids, whole }`（`whole` 表示「这份清单是完整的」，
// 供增量缓存判断），我们这条分支的这个接口只返回 id 数组，所以这里把 `whole` 降到日志里，
// 返回值按本仓库的形状给。等以后搬上游的增量缓存时再把 `whole` 接出去。
const RECENT_ID = 'recent-played';
/**
 * 场景卡片（首页电台那一眼）的集合 id 前缀，见 qishuiRecommendations 的 `scene-${id}`。
 * 场景不是歌单：它按场景 id 向 `feed` 要歌，能翻页，不经过 `playlist_tracks`。
 */
const SCENE_PREFIX = 'scene-';
const sceneIdOf = (id: MediaId): string | null => {
    const value = String(id);
    return value.startsWith(SCENE_PREFIX) ? value.slice(SCENE_PREFIX.length) : null;
};
const recentCollection = async (): Promise<ProviderCollection> => ({ providerId: 'qishui', id: RECENT_ID, type: 'history',
    name: i18n.t('qishui.recentPlayed'), isOwned: false, coverUrl: await createQishuiSceneCover(RECENT_ID, '') });
export const qishuiCatalog: OnlineCatalogProvider = {
    async getPlaylistTracks(id, limit, offset, collection) {
        if (id === RECENT_ID) {
            const page = await requestQishui<ProviderPage<unknown>>('recent_played', { limit, offset });
            return { ...page, items: page.items.map(normalizeQishuiSong) };
        }
        const scene = sceneIdOf(id);
        if (scene) {
            const page = await requestQishui<ProviderPage<unknown>>('feed', { queue: 'fm', scene, limit, offset });
            return { ...page, items: page.items.map(normalizeQishuiSong) };
        }
        const page = await requestQishui<ProviderPage<unknown>>('playlist_tracks', { id: String(id), limit, offset,
            ownerId: typeof collection?.providerData?.ownerId === 'string' ? collection.providerData.ownerId : '' });
        return { ...page, items: page.items.map(normalizeQishuiSong) };
    },
    async getPlaylistDetail(id, collection) {
        if (id === RECENT_ID) return recentCollection();
        // 场景卡片自带名字与封面（首页那张卡片就是它），没有更细的详情可读。
        if (sceneIdOf(id)) return collection ?? null;
        const raw = await requestQishui('playlist_detail', { id: String(id), limit: 1,
            ownerId: typeof collection?.providerData?.ownerId === 'string' ? collection.providerData.ownerId : '' });
        if (!raw) return null;
        const detail = normalizeQishuiCollection({ ...record(raw), isOwned: collection?.isOwned ?? record(raw).isOwned });
        return { ...collection, ...detail, ...(collection?.isLiked === true ? { isLiked: true } : {}) };
    },
    async getArtistSongs(id, limit, offset) {
        const page = await requestQishui<ProviderPage<unknown>>('artist_songs', { id: String(id), limit, offset });
        return { ...page, items: page.items.map(normalizeQishuiSong) };
    },
    async getArtistDetail(id) {
        const raw = await requestQishui('artist_detail', { id: String(id) });
        return raw ? normalizeQishuiCollection(raw, 'artist') : null;
    },
};
export const qishuiLibrary: OnlineLibraryProvider = {
    async getUserPlaylists(_userId, limit, offset) {
        // The read-only history card occupies one row; translate the library offset to playlist rows.
        const first = offset === 0;
        const page = await requestQishui<ProviderPage<QishuiRecord>>('user_playlists', {
            limit: first ? Math.max(1, limit - 1) : limit, offset: Math.max(0, offset - 1),
        });
        const rows = first && limit === 1 ? [] : page.items.map(item => normalizeQishuiCollection(item));
        const items = [...(first ? [await recentCollection()] : []), ...rows];
        return { items, hasMore: first && limit === 1 ? page.items.length > 0 || page.hasMore : page.hasMore,
            nextOffset: offset + items.length, ...(page.total === undefined ? {} : { total: page.total + 1 }) };
    },
    async getLikedSongIds() {
        const data = await requestQishui<{ ids: string[]; whole: boolean }>('liked_songs');
        if (!Array.isArray(data.ids) || data.ids.some(id => typeof id !== 'string' || !/^\d+$/.test(id))) {
            throw new OnlineProviderError('invalid-response', 'Qishui liked songs are missing', 'qishui');
        }
        console.info('[Qishui] Liked songs read', { count: data.ids.length, whole: data.whole });
        return data.ids;
    },
};
