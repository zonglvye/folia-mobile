import { describe, expect, it } from 'vitest';
import { classifyKugouProfileResponse } from '@/services/onlineMusic/kugouWebAuth';

// test/unit/onlineMusic/kugouWebAuth.test.ts
// 酷狗账号资料应答的分类：20018 是「没登录」，别的错误码是「这次没查成」。
// 这个区分决定了账户层会不会把已保存的 token 删掉，所以单独锁住。

describe('classifyKugouProfileResponse', () => {
    it('treats a status-1 response as the profile', () => {
        expect(classifyKugouProfileResponse({
            status: 1,
            error_code: 0,
            data: { userid: 42, nickname: '酷狗用户', pic: 'https://img/1.jpg' },
        })).toEqual({ kind: 'ok', data: { userid: 42, nickname: '酷狗用户', pic: 'https://img/1.jpg' } });
    });

    it('reads a response without an error_code field as the profile', () => {
        expect(classifyKugouProfileResponse({ status: 1, data: { userid: 7 } }))
            .toEqual({ kind: 'ok', data: { userid: 7 } });
    });

    it('treats 20018 as signed out (no token and an invalid token both answer this)', () => {
        expect(classifyKugouProfileResponse({ status: 0, error_code: 20018, data: null }))
            .toEqual({ kind: 'signed-out' });
    });

    it('keeps any other error code as an error, not a sign-out', () => {
        expect(classifyKugouProfileResponse({ status: 0, error_code: 20010, data: '参数错误' }))
            .toEqual({ kind: 'error', message: 'KuGou profile request failed: error_code 20010 参数错误' });
        expect(classifyKugouProfileResponse({ status: 0, error_code: 20017, data: null }))
            .toEqual({ kind: 'error', message: 'KuGou profile request failed: error_code 20017' });
    });

    it('treats a status-0 answer without an error code as an error', () => {
        expect(classifyKugouProfileResponse({ status: 0, data: null }))
            .toEqual({ kind: 'error', message: 'KuGou profile request failed: error_code 0' });
    });
});
