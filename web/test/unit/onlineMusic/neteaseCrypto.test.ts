import { describe, expect, it } from 'vitest';
import { eapiEncrypt, weapiEncrypt } from '../../../src/services/onlineMusic/neteaseCrypto';

// test/unit/onlineMusic/neteaseCrypto.test.ts
//
// These vectors are not self-generated: each one was produced by running the reference
// implementation (@neteasecloudmusicapienhanced/api's util/crypto.js) over the same input, with the
// weapi secret key pinned to a fixed value because that implementation randomises it per request.
// So the assertions below are "byte-identical to the thing that already works against the platform",
// which is the only claim worth making about a port of existing cryptography.

const EAPI_UNIKEY_PARAMS = '1CA81A97B7BAEB099F29A9B99A25CD6E58E7BA5B35F25231033065C776830C0A38A128CF8B3EAF44635E50E0B9800A4A037CBDA1E04BD460C02768E3ECD5E66E905A5BCAE52009FB0933EFB373A62E834048DEBDABCCC627F25820A8D94E0A8C';
const EAPI_CLOUDSEARCH_PARAMS = '2B5D64177AA6460FBAA3DCB1285E28954BBB4F7556E09B0FB25750F12398BB50699B9E0C5AB14A9C135E3FB6947F787F43D51C5366462117E9B221E851D77D620EBF383D8F8FCDAE42D2D519CEDCF5D9C1B5F865E0C0F565830D262C482C2C74CFD22B7BAFF256FA48DB5A462FE7E3C256800DF344ACBC79DB9BB5A9B660815E38322BC312DA1E97314C2631089A1889';

const WEAPI_SECRET = 'abcdefghijklmnop';
const WEAPI_PAYLOAD = { s: 'test', type: 1, limit: 1 };
const WEAPI_PARAMS = 'DJtzZlO4j6WGsoqnByvWRVt9m04jGNIya4aE5bKK8B1LENT5nG0rcTttGmGYfQr0';
const WEAPI_ENC_SEC_KEY = 'd15a1683c992095d0c234c19966605c5c5964911268bbeda8cb8d08d834913e59d53b32358903a121b5fca784c1f5ae44951fd02524df58ecc98e52cc7cf8689b42c2e93ddf05b0592512d87f5960467e2f086c018849d76014d323500e30f13ef4cafbb0cf5a66731a3f1776c75ca35d0062dac70a3e33245afabcf47938487';

describe('eapiEncrypt', () => {
    it('matches the reference output for the QR unikey request', async () => {
        const { params } = await eapiEncrypt('/api/login/qrcode/unikey', { type: 3 });
        expect(params).toBe(EAPI_UNIKEY_PARAMS);
    });

    it('matches the reference output for cloud search', async () => {
        const { params } = await eapiEncrypt('/api/cloudsearch/pc', { s: 'test', type: 1, limit: 1, offset: 0, total: true });
        expect(params).toBe(EAPI_CLOUDSEARCH_PARAMS);
    });
});

describe('weapiEncrypt', () => {
    it('matches the reference output when the secret key is pinned', async () => {
        const result = await weapiEncrypt(WEAPI_PAYLOAD, WEAPI_SECRET);
        expect(result.params).toBe(WEAPI_PARAMS);
        expect(result.encSecKey).toBe(WEAPI_ENC_SEC_KEY);
    });

    it('picks its own secret key and still produces a full-width textbook RSA block', async () => {
        const result = await weapiEncrypt({ a: 1 });
        expect(result.params.length).toBeGreaterThan(0);
        // 128 bytes of modulus, lowercase hex, left-padded — a short result would mean the
        // exponentiation lost leading zero bytes.
        expect(result.encSecKey).toMatch(/^[0-9a-f]{256}$/);
    });
});
