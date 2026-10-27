import { useEffect, useSyncExternalStore } from 'react';
import type { HomeViewTab } from '../../../types';
import type { MediaId } from '../../../types/onlineMusic';
import type {
    LibraryHomeFeedOwner,
    LibraryHomeFeedResource,
    LibraryHomeFeedSnapshot,
    LibraryHomeResources,
} from '../contracts/homeModel';

// src/library/core/bindings/useLibraryHomeOnlineFeeds.ts
// 在线首页数据的绑定：把当前 provider / 账户设成两份资源的归属，看着哪个页签就让哪份资源读一次，
// 并订阅它们的快照。归属与读取在同一个 effect 里按顺序做（先换归属、再 ensure），所以切 provider 之后
// 新 provider 的收藏专辑 / 电台一定会读——原先两个 effect 的先后让它永远不读。
// 这里不在卸载时放掉归属：资源属于首页宿主，换 suite（旧 surface 卸载、新 surface 挂载）时新 surface 设的是
// 同一个归属、ensure 也不再读；首页真的离开时由宿主放掉（core/services/libraryHomeLifetime）。

export const useLibraryHomeFeed = <TData>(resource: LibraryHomeFeedResource<TData>): LibraryHomeFeedSnapshot<TData> => (
    useSyncExternalStore(resource.subscribe, resource.getSnapshot)
);

const ownerOf = (providerId: string, userId: MediaId | null | undefined, capable: boolean): LibraryHomeFeedOwner | null => (
    capable && userId !== null && userId !== undefined ? { providerId, userId } : null
);

/**
 * 游客可用平台的电台归属用的假账户 id：这类平台的私人 FM / 场景不需要账号，
 * 但首页资源是按「provider + 账户」认领的，没有 id 就一直不读。
 */
export const GUEST_FEED_OWNER_ID = 'guest';

type OnlineHomeFeedsAttachment = {
    tab: HomeViewTab;
    providerId: string;
    userId: MediaId | null | undefined;
    canUseAlbums: boolean;
    canUseRadio: boolean;
    /** 平台未登录也能用（汽水）：电台按游客身份去读。 */
    guestRadio?: boolean;
};

/**
 * 正在显示的首页 surface 认领两份在线数据：先把归属设成当前 provider / 账户，再让当前页签的那份读一次。
 * 同一个归属、已经读过时什么都不做——换 suite 后新 surface 认领同一份数据不会再请求。
 */
export const attachOnlineHomeFeeds = (
    resources: Pick<LibraryHomeResources, 'favoriteAlbums' | 'radioFeed'>,
    { tab, providerId, userId, canUseAlbums, canUseRadio, guestRadio = false }: OnlineHomeFeedsAttachment,
): void => {
    resources.favoriteAlbums.setOwner(ownerOf(providerId, userId, canUseAlbums));
    resources.radioFeed.setOwner(
        ownerOf(providerId, userId, canUseRadio)
        ?? (guestRadio ? { providerId, userId: GUEST_FEED_OWNER_ID } : null),
    );
    if (tab === 'albums') void resources.favoriteAlbums.ensure();
    if (tab === 'radio') void resources.radioFeed.ensure();
};

export const useLibraryHomeOnlineFeeds = ({
    resources,
    tab,
    providerId,
    userId,
    canUseAlbums,
    canUseRadio,
    guestRadio,
}: {
    resources: Pick<LibraryHomeResources, 'favoriteAlbums' | 'radioFeed'>;
    tab: HomeViewTab;
    providerId: string;
    /** 当前 provider 的已登录账户（没有账户时为 null：两份数据都没有归属）。 */
    userId: MediaId | null | undefined;
    canUseAlbums: boolean;
    canUseRadio: boolean;
    /** 平台未登录也能用（汽水）：电台按游客身份去读（收藏专辑仍然要账号）。 */
    guestRadio?: boolean;
}) => {
    const { favoriteAlbums, radioFeed } = resources;
    useEffect(() => {
        attachOnlineHomeFeeds({ favoriteAlbums, radioFeed }, { tab, providerId, userId, canUseAlbums, canUseRadio, guestRadio });
    }, [canUseAlbums, canUseRadio, favoriteAlbums, guestRadio, providerId, radioFeed, tab, userId]);

    return {
        favoriteAlbums: useLibraryHomeFeed(favoriteAlbums),
        radioFeed: useLibraryHomeFeed(radioFeed),
    };
};
