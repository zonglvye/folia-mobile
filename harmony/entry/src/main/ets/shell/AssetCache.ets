import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { ShellLog } from './ShellLog';

// harmony/entry/src/main/ets/shell/AssetCache.ets
// 前端资源的缓存代次。
//
// 打包进来的静态站点是内容哈希命名的，本来不该被缓存，但真机上遇到过「CSS 换了文件名，页面还在用上一版」：
// 缓存里的旧 chunk 按旧 URL 去要 CSS，而那个 URL 早就不在 rawfile 里了，仍然被缓存喂回来。
// 表现是「改了样式、装了包、真机没变」，很容易往别处找原因。
//
// 治根：AssetServer 现在一律回 no-store。治这一次：这里的代次变了就清一遍已经存在的旧缓存。
// 以后新增/改动前端资源想确保手机上立刻生效，把 ASSET_CACHE_REV +1 即可（只在换代时清，平时不清，
// 否则每次启动都会把在线封面这些也丢掉）。
export const ASSET_CACHE_REV: number = 2;

const CACHE_STORE: string = 'shell-cache';
const CACHE_REV_KEY: string = 'assetCacheRev';

/**
 * 是否需要清缓存：代次与上次记录的不同就返回 true，并把新代次落盘（保证只清一次）。
 * 读不到记录（首次启动、偏好被清）也算需要清——那时缓存本来就是空的，清一次没有代价。
 */
export const shouldClearAssetCache = async (context: common.UIAbilityContext): Promise<boolean> => {
  try {
    const store = await preferences.getPreferences(context, CACHE_STORE);
    const last = store.getSync(CACHE_REV_KEY, 0) as number;
    if (last === ASSET_CACHE_REV) {
      return false;
    }
    store.putSync(CACHE_REV_KEY, ASSET_CACHE_REV);
    await store.flush();
    ShellLog.info(`asset cache rev ${last} -> ${ASSET_CACHE_REV}`);
    return true;
  } catch (error) {
    ShellLog.info(`asset cache rev check failed: ${String(error)}`);
    return false;
  }
};
