import type { OnlineRecommendationProvider, ProviderCollection } from '../../../types/onlineMusic';
import { getPersonalFmRequestOptions } from '../../../stores/usePersonalFmModeStore';
import { requestQishui } from './qishuiTransport';
import { createQishuiSceneCover } from './qishuiSceneCover';
import { normalizeQishuiSong, qishuiImage } from './qishuiNormalize';

// src/services/onlineMusic/qishui/qishuiRecommendations.ts
// 汽水的「场景电台」既是私人 FM 的来源，也是首页那排电台卡片。
//
// 与上游的差异：上游还把场景列表做成了 `getPersonalFmCatalog`（动态填充 FM 模式选择器的目录），
// 我们这条分支的 `OnlineRecommendationProvider` 没有那个钩子（FM 模式来自 fmModes 的静态清单），
// 所以这里只保留两个出口：`getPersonalFm`（按 fmModes 的模式向 feed 要歌）和
// `getRecommendedCollections`（场景卡片）。将来搬动态目录时把 getQishuiFmCatalog 加回来即可。
type Scene = { id: string; name: string; group: string; coverUrl?: unknown };
let scenes: Scene[] = [];
let scenesAt = 0;
let generation = 0;
// 统计「清空了几次」：换账号前发起的场景读取不能把新账号的列表填回去。
export function clearQishuiRecommendations() { generation++; scenes = []; scenesAt = 0; }

const loadScenes = async (): Promise<Scene[]> => {
    if (scenes.length > 0 && Date.now() - scenesAt < 10 * 60_000) return scenes;
    const mine = generation;
    const rows = await requestQishui<Scene[]>('feed_modes');
    const seen = new Set<string>();
    const read = rows.filter(row => /^\d+$/.test(row.id) && row.name && !seen.has(row.id) && Boolean(seen.add(row.id)));
    if (mine === generation) { scenes = read; scenesAt = Date.now(); }
    return read;
};

export const qishuiRecommendations: OnlineRecommendationProvider = {
    async dislikeSong(id) {
        await requestQishui('dislike_song', { id: String(id), disliked: true });
        console.info('[Qishui] Recommendation disliked');
        return {};
    },
    async getPersonalFm(options) {
        const selected = options || getPersonalFmRequestOptions();
        const data = await requestQishui<{ items: unknown[] }>('feed', { queue: 'fm', limit: 20,
            ...(selected.mode === 'SCENE_RCMD' && selected.submode ? { scene: selected.submode } : {}),
            ...(selected.mode === 'FAMILIAR' ? { preference: 'familiar' } : selected.mode === 'EXPLORE' ? { preference: 'fresh' } : {}) });
        return data.items.map(normalizeQishuiSong);
    },
    async getRecommendedCollections(limit): Promise<ProviderCollection[]> {
        const read = await loadScenes();
        return Promise.all(read.slice(0, limit).map(async scene => ({
            providerId: 'qishui', id: `scene-${scene.id}`, type: 'radio', name: scene.name,
            description: scene.group, coverUrl: await createQishuiSceneCover(scene.id, qishuiImage(scene.coverUrl)),
            personalFm: { mode: 'SCENE_RCMD', scene: scene.id },
        })));
    },
};
